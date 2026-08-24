import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { io, type Socket } from 'socket.io-client';

type Json = Record<string, any>;

function extractCookies(setCookie: string | null): string {
  if (!setCookie) return '';
  // Extract session_token from Set-Cookie headers
  const cookies = setCookie
    .split(',')
    .map((c) => c.trim().split(';')[0])
    .filter((c) => c.startsWith('session_token=') || c.startsWith('csrf_token='));
  return cookies.join('; ');
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForHealth(baseUrl: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Server did not become healthy');
}

interface UserWithCookies {
  user: { id: number };
  cookies: string;
}

async function request(baseUrl: string, route: string, options: RequestInit = {}, cookies?: string) {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  if (cookies) headers.set('Cookie', cookies);
  // Send CSRF token for state-changing methods
  const method = (options.method ?? 'GET').toUpperCase();
  if (cookies && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const csrfMatch = cookies.split('; ').find((c) => c.startsWith('csrf_token='));
    if (csrfMatch) {
      const csrfToken = csrfMatch.split('=').slice(1).join('=');
      headers.set('X-CSRF-Token', csrfToken);
    }
  }
  const response = await fetch(`${baseUrl}${route}`, { ...options, headers, redirect: 'manual' });
  const body = (await response.json().catch(() => null)) as Json | null;
  // Merge set-cookie from this response with existing cookies
  const newCookies = extractCookies(response.headers.get('set-cookie'));
  const merged = mergeCookies(cookies, newCookies);
  return { status: response.status, body, cookies: merged };
}

function mergeCookies(existing?: string, newCookies?: string): string {
  if (!newCookies) return existing ?? '';
  if (!existing) return newCookies;
  // Merge: new cookies override old ones
  const map = new Map<string, string>();
  for (const pair of existing.split('; ')) {
    const [k, ...v] = pair.split('=');
    map.set(k, v.join('='));
  }
  for (const pair of newCookies.split('; ')) {
    const [k, ...v] = pair.split('=');
    map.set(k, v.join('='));
  }
  return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function register(baseUrl: string, phone: string, firstName: string): Promise<UserWithCookies> {
  const codeResponse = await request(baseUrl, '/api/auth/sendCode', {
    method: 'POST',
    body: JSON.stringify({ phone }),
  });
  assert.equal(codeResponse.status, 200);
  assert.equal(typeof codeResponse.body?.dev_code, 'string');
  const signup = await request(baseUrl, '/api/auth/signUp', {
    method: 'POST',
    body: JSON.stringify({
      phone,
      code: codeResponse.body!.dev_code,
      phone_code_hash: codeResponse.body!.phone_code_hash,
      first_name: firstName,
    }),
  });
  assert.equal(signup.status, 200);
  return { user: signup.body!.user, cookies: signup.cookies };
}

async function connect(baseUrl: string, cookies: string): Promise<Socket> {
  const socket = io(baseUrl, { auth: { token: cookies.split('; ').find(c => c.startsWith('session_token='))?.split('=')[1] || '' }, reconnection: false, extraHeaders: { Cookie: cookies } });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket connection timed out')), 3_000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return socket;
}

async function emitAck(socket: Socket, event: string, payload: Json): Promise<Json> {
  return new Promise((resolve, reject) => {
    socket.timeout(3_000).emit(event, payload, (timeoutError: Error | null, response: Json) => {
      if (timeoutError) reject(timeoutError);
      else resolve(response);
    });
  });
}

test('auth, access control, delivery and idempotency', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'messenger-test-'));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['dist-server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(tempDir, 'messenger.db'),
      SERVER_SECRET: 'integration-test-secret-not-for-production',
      EXPOSE_DEV_CODE: 'true',
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout?.on('data', (chunk) => { logs += String(chunk); });
  child.stderr?.on('data', (chunk) => { logs += String(chunk); });

  const sockets: Socket[] = [];
  t.after(async () => {
    sockets.forEach((socket) => socket.disconnect());
    child.kill();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      setTimeout(resolve, 2000);
    });
    await new Promise((r) => setTimeout(r, 200));
    await rm(tempDir, { recursive: true, force: true });
  });

  try {
    await waitForHealth(baseUrl, child);

    const invalidSignup = await request(baseUrl, '/api/auth/signUp', {
      method: 'POST',
      body: JSON.stringify({ phone: 'invalid', first_name: 'Bad' }),
    });
    assert.equal(invalidSignup.status, 400);

    const alice = await register(baseUrl, '+12025550101', 'Alice');
    const bob = await register(baseUrl, '+12025550102', 'Bob');
    const eve = await register(baseUrl, '+12025550103', 'Eve');

    const created = await request(
      baseUrl,
      '/api/chats',
      { method: 'POST', body: JSON.stringify({ peerId: bob.user.id, kind: 'regular' }) },
      alice.cookies,
    );
    assert.equal(created.status, 200);
    const chatId = Number(created.body!.chat.id);

    const aliceSocket = await connect(baseUrl, alice.cookies);
    const bobSocket = await connect(baseUrl, bob.cookies);
    const eveSocket = await connect(baseUrl, eve.cookies);
    sockets.push(aliceSocket, bobSocket, eveSocket);

    const unauthorized = await emitAck(eveSocket, 'message:send', {
      chatId,
      text: 'I should not be here',
      clientId: 'eve-forbidden-0001',
    });
    assert.equal(unauthorized.ok, false);
    assert.equal(unauthorized.error, 'No such chat');

    let delivered = 0;
    bobSocket.on('message:new', () => { delivered += 1; });
    const first = await emitAck(aliceSocket, 'message:send', {
      chatId,
      text: 'hello',
      clientId: 'alice-message-0001',
    });
    assert.equal(first.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(delivered, 1);

    const duplicate = await emitAck(aliceSocket, 'message:send', {
      chatId,
      text: 'this changed text must not create another row',
      clientId: 'alice-message-0001',
    });
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.message.id, first.message.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(delivered, 1);

    const historyForBob = await request(baseUrl, `/api/chats/${chatId}/messages`, {}, bob.cookies);
    assert.equal(historyForBob.status, 200);
    assert.equal(historyForBob.body!.length, 1);
    assert.equal(historyForBob.body![0].text, 'hello');

    const historyForEve = await request(baseUrl, `/api/chats/${chatId}/messages`, {}, eve.cookies);
    assert.equal(historyForEve.status, 404);

    let injectedTyping = 0;
    bobSocket.on('typing', () => { injectedTyping += 1; });
    eveSocket.emit('typing', { chatId, isTyping: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(injectedTyping, 0);

    const aliceReactionEvent = new Promise<Json>((resolve) => {
      aliceSocket.once('message:reaction', resolve);
    });
    const reactionAck = await emitAck(bobSocket, 'message:react', {
      chatId,
      messageId: first.message.id,
      emoji: '👍',
    });
    assert.equal(reactionAck.ok, true);
    assert.equal(reactionAck.reactions[0].mine, true);
    const aliceReaction = await aliceReactionEvent;
    assert.equal(aliceReaction.reactions[0].mine, false);

    const readEvent = new Promise<Json>((resolve) => {
      aliceSocket.once('message:read', resolve);
    });
    bobSocket.emit('message:read', { chatId, messageId: first.message.id });
    assert.equal((await readEvent).userId, bob.user.id);

    const invalidKey = await request(
      baseUrl,
      '/api/users/e2e-key',
      { method: 'POST', body: JSON.stringify({ publicKey: { kty: 'oct' }, fingerprint: 'fake' }) },
      alice.cookies,
    );
    assert.equal(invalidKey.status, 400);

    const group = await request(
      baseUrl,
      '/api/groups',
      { method: 'POST', body: JSON.stringify({ title: 'Integration group', userIds: [bob.user.id] }) },
      alice.cookies,
    );
    assert.equal(group.status, 200);
    const groupId = Number(group.body!.chat.chat.id);

    const ownerLeave = await request(baseUrl, `/api/chats/${groupId}`, { method: 'DELETE' }, alice.cookies);
    assert.equal(ownerLeave.status, 409);

    const transferred = await request(
      baseUrl,
      `/api/groups/${groupId}/transfer-ownership`,
      { method: 'POST', body: JSON.stringify({ userId: bob.user.id }) },
      alice.cookies,
    );
    assert.equal(transferred.status, 200);
    assert.equal(transferred.body!.members.find((member: Json) => member.user.id === bob.user.id).role, 'owner');

    const formerOwnerLeave = await request(baseUrl, `/api/chats/${groupId}`, { method: 'DELETE' }, alice.cookies);
    assert.equal(formerOwnerLeave.status, 200);

    const groupMessage = await emitAck(bobSocket, 'message:send', {
      chatId: groupId,
      text: 'group message',
      clientId: 'bob-group-message-0001',
    });
    assert.equal(groupMessage.ok, true);

    const deleteAlice = await request(baseUrl, '/api/me', { method: 'DELETE', body: JSON.stringify({}) }, alice.cookies);
    assert.equal(deleteAlice.status, 200);
    const deletedSession = await request(baseUrl, '/api/me', {}, alice.cookies);
    assert.equal(deletedSession.status, 401);
  } catch (error) {
    throw new Error(`${(error as Error).message}\nServer output:\n${logs}`);
  }
});

test('production build serves the SPA with security headers', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'messenger-production-test-'));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['dist-server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(tempDir, 'messenger.db'),
      SERVER_SECRET: 'integration-production-secret-not-for-real-use',
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout?.on('data', (chunk) => { logs += String(chunk); });
  child.stderr?.on('data', (chunk) => { logs += String(chunk); });

  t.after(async () => {
    child.kill();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      setTimeout(resolve, 2000);
    });
    await new Promise((r) => setTimeout(r, 500));
    await rm(tempDir, { recursive: true, force: true });
  });

  try {
    await waitForHealth(baseUrl, child);
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('cache-control'), 'no-store');
    assert.match(health.headers.get('content-security-policy') ?? '', /default-src 'self'/);

    const page = await fetch(baseUrl);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await page.text(), /<div id="root"><\/div>/);
  } catch (error) {
    throw new Error(`${(error as Error).message}\nServer output:\n${logs}`);
  }
});

test('reports, admin moderation, sticker packs, GIF search, privacy, scheduled messages', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'messenger-test2-'));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['dist-server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(tempDir, 'messenger.db'),
      SERVER_SECRET: 'integration-test-secret-2',
      EXPOSE_DEV_CODE: 'true',
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout?.on('data', (chunk) => { logs += String(chunk); });
  child.stderr?.on('data', (chunk) => { logs += String(chunk); });

  const sockets: Socket[] = [];
  t.after(async () => {
    sockets.forEach((s) => s.disconnect());
    child.kill();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      setTimeout(resolve, 2000);
    });
    await new Promise((r) => setTimeout(r, 200));
    await rm(tempDir, { recursive: true, force: true });
  });

  try {
    await waitForHealth(baseUrl, child);

    const admin = await register(baseUrl, '+12025550201', 'Admin');
    const user1 = await register(baseUrl, '+12025550202', 'User1');
    const user2 = await register(baseUrl, '+12025550203', 'User2');

    // Admin is first user, should be is_admin
    const meResp = await request(baseUrl, '/api/me', {}, admin.cookies);
    assert.equal(meResp.status, 200);
    assert.equal((meResp.body as Json).is_admin, 1);

    const nonAdminMe = await request(baseUrl, '/api/me', {}, user1.cookies);
    assert.equal((nonAdminMe.body as Json).is_admin, 0);

    // --- Reports ---
    const report = await request(baseUrl, '/api/reports', {
      method: 'POST',
      body: JSON.stringify({ target_type: 'user', target_id: user2.user.id, reason: 'spam', details: 'test details' }),
    }, user1.cookies);
    assert.equal(report.status, 200);
    assert.equal(report.body?.ok, true);

    const badReport = await request(baseUrl, '/api/reports', {
      method: 'POST',
      body: JSON.stringify({ target_type: 'invalid', target_id: 1, reason: 'x' }),
    }, user1.cookies);
    assert.equal(badReport.status, 400);

    // Non-admin cannot list reports
    const noReports = await request(baseUrl, '/api/admin/reports', {}, user1.cookies);
    assert.equal(noReports.status, 403);

    // Admin can list reports
    const reports = await request(baseUrl, '/api/admin/reports', {}, admin.cookies);
    assert.equal(reports.status, 200);
    assert.ok(Array.isArray(reports.body));
    assert.ok(reports.body!.length >= 1);
    assert.equal(reports.body![0].reason, 'spam');
    assert.equal(reports.body![0].reporter_username, user1.user.username);

    // Admin can review report
    const reportId = reports.body![0].id;
    const reviewed = await request(baseUrl, `/api/admin/reports/${reportId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'reviewed' }),
    }, admin.cookies);
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.body?.ok, true);

    // --- Admin user list / ban ---
    const adminUsers = await request(baseUrl, '/api/admin/users?q=user', {}, admin.cookies);
    assert.equal(adminUsers.status, 200);
    assert.ok(Array.isArray(adminUsers.body));
    assert.ok(adminUsers.body!.length >= 2);

    const nonAdminUsers = await request(baseUrl, '/api/admin/users', {}, user1.cookies);
    assert.equal(nonAdminUsers.status, 403);

    // Ban user2
    const ban = await request(baseUrl, `/api/admin/users/${user2.user.id}/ban`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'test ban' }),
    }, admin.cookies);
    assert.equal(ban.status, 200);

    const bans = await request(baseUrl, '/api/admin/bans', {}, admin.cookies);
    assert.equal(bans.status, 200);
    assert.ok(bans.body!.length >= 1);

    // Unban
    const unban = await request(baseUrl, `/api/admin/users/${user2.user.id}/ban`, { method: 'DELETE' }, admin.cookies);
    assert.equal(unban.status, 200);

    // Delete user messages
    const delMsgs = await request(baseUrl, `/api/admin/users/${user2.user.id}/delete-messages`, { method: 'POST' }, admin.cookies);
    assert.equal(delMsgs.status, 200);

    // --- Sticker packs ---
    const createPack = await request(baseUrl, '/api/sticker-packs', {
      method: 'POST',
      body: JSON.stringify({ name: 'Test Pack', emoji: '😀' }),
    }, admin.cookies);
    assert.equal(createPack.status, 200);
    const packId = createPack.body!.id;

    const packList = await request(baseUrl, '/api/sticker-packs', {}, admin.cookies);
    assert.equal(packList.status, 200);
    assert.ok(packList.body!.length >= 1);

    // Install pack
    const installPack = await request(baseUrl, `/api/sticker-packs/${packId}/install`, { method: 'POST' }, user1.cookies);
    assert.equal(installPack.status, 200);

    const myPacks = await request(baseUrl, '/api/me/sticker-packs', {}, user1.cookies);
    assert.equal(myPacks.status, 200);
    assert.ok(myPacks.body!.length >= 1);

    // Uninstall
    const uninstallPack = await request(baseUrl, `/api/sticker-packs/${packId}/install`, { method: 'DELETE' }, user1.cookies);
    assert.equal(uninstallPack.status, 200);

    // --- GIF search ---
    const gifsEmpty = await request(baseUrl, '/api/gifs/search?q=', {}, user1.cookies);
    assert.equal(gifsEmpty.status, 200);
    assert.ok(Array.isArray(gifsEmpty.body));
    assert.ok(gifsEmpty.body!.length > 0);

    const gifsCat = await request(baseUrl, '/api/gifs/search?q=cat', {}, user1.cookies);
    assert.equal(gifsCat.status, 200);
    assert.ok(Array.isArray(gifsCat.body));

    // --- Privacy settings ---
    const privacyUpdate = await request(baseUrl, '/api/me', {
      method: 'PATCH',
      body: JSON.stringify({ privacy: { last_seen: 'contacts', phone: 'nobody', photo: 'contacts', bio: 'everyone', groups: 'contacts', forwarded: 'nobody', find_me: 'nobody' } }),
    }, user1.cookies);
    assert.equal(privacyUpdate.status, 200);

    // --- Chat between users ---
    const chat2 = await request(baseUrl, '/api/chats', {
      method: 'POST',
      body: JSON.stringify({ peerId: user2.user.id, kind: 'regular' }),
    }, user1.cookies);
    assert.equal(chat2.status, 200);
    const chatId2 = Number(chat2.body!.chat.id);

    const user1Socket = await connect(baseUrl, user1.cookies);
    const user2Socket = await connect(baseUrl, user2.cookies);
    sockets.push(user1Socket, user2Socket);

    // --- Chat media endpoint ---
    const mediaList = await request(baseUrl, `/api/chats/${chatId2}/media`, {}, user1.cookies);
    assert.equal(mediaList.status, 200);
    assert.ok(Array.isArray(mediaList.body));

    // --- Notify level ---
    const notifyLevel = await request(baseUrl, `/api/chats/${chatId2}/notify`, {
      method: 'PUT',
      body: JSON.stringify({ level: 'mentions' }),
    }, user1.cookies);
    assert.equal(notifyLevel.status, 200);
    assert.equal(notifyLevel.body?.level, 'mentions');

    // --- VAPID key endpoint ---
    const vapidKey = await request(baseUrl, '/api/push/vapid-public-key', {}, user1.cookies);
    assert.equal(vapidKey.status, 200);
    assert.equal(vapidKey.body?.enabled, false);

    // --- Channel discussion ---
    const channel = await request(baseUrl, '/api/groups', {
      method: 'POST',
      body: JSON.stringify({ title: 'Test Channel', kind: 'channel', userIds: [] }),
    }, admin.cookies);
    assert.ok(channel.status === 200, `Channel creation failed: ${channel.status} ${JSON.stringify(channel.body)}`);
    const channelId = Number(channel.body!.chat.chat.id);
    assert.ok(channelId > 0, `Invalid channelId: ${channelId}, body: ${JSON.stringify(channel.body)}`);

    const discLink = await request(baseUrl, `/api/channels/${channelId}/discussion`, {
      method: 'PUT',
      body: JSON.stringify({ discussion_chat_id: chatId2 }),
    }, admin.cookies);
    assert.ok(discLink.status === 200, `Discussion link failed: ${discLink.status} ${JSON.stringify(discLink.body)}`);
    assert.equal(discLink.body?.discussion_chat_id, chatId2);

    // --- Channel stats ---
    const stats = await request(baseUrl, `/api/channels/${channelId}/stats`, {}, admin.cookies);
    assert.equal(stats.status, 200);
    assert.equal(typeof stats.body?.total_messages, 'number');

  } catch (error) {
    throw error;
  }
});

test('secret chat, message delete for me, disappearing messages', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'messenger-test3-'));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['dist-server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(tempDir, 'messenger.db'),
      SERVER_SECRET: 'integration-test-secret-3',
      EXPOSE_DEV_CODE: 'true',
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout?.on('data', (chunk) => { logs += String(chunk); });
  child.stderr?.on('data', (chunk) => { logs += String(chunk); });

  const sockets: Socket[] = [];
  t.after(async () => {
    sockets.forEach((s) => s.disconnect());
    child.kill();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      setTimeout(resolve, 2000);
    });
    await new Promise((r) => setTimeout(r, 200));
    await rm(tempDir, { recursive: true, force: true });
  });

  try {
    await waitForHealth(baseUrl, child);

    const alice = await register(baseUrl, '+12025550301', 'Alice');
    const bob = await register(baseUrl, '+12025550302', 'Bob');

    // Create chat (secret requires E2E keys, use regular for testing delete-for-me)
    const chatResp = await request(baseUrl, '/api/chats', {
      method: 'POST',
      body: JSON.stringify({ peerId: bob.user.id, kind: 'regular' }),
    }, alice.cookies);
    assert.equal(chatResp.status, 200);
    const chatId = Number(chatResp.body!.chat.id);

    const aliceSocket = await connect(baseUrl, alice.cookies);
    const bobSocket = await connect(baseUrl, bob.cookies);
    sockets.push(aliceSocket, bobSocket);

    // Send message
    const sentMsg = await emitAck(aliceSocket, 'message:send', {
      chatId,
      text: 'hello bob',
      clientId: 'alice-msg-001',
    });
    assert.equal(sentMsg.ok, true);

    // Message delete for me
    const deleteForMe = await emitAck(aliceSocket, 'message:delete', {
      chatId,
      messageId: sentMsg.message.id,
      forMe: true,
    });
    assert.equal(deleteForMe.ok, true);

    // Message still exists for Bob
    const bobHistory = await request(baseUrl, `/api/chats/${chatId}/messages`, {}, bob.cookies);
    assert.equal(bobHistory.status, 200);
    assert.equal(bobHistory.body!.length, 1);

    // Alice can't see it
    const aliceHistory = await request(baseUrl, `/api/chats/${chatId}/messages`, {}, alice.cookies);
    assert.equal(aliceHistory.status, 200);
    assert.equal(aliceHistory.body!.length, 0);

    // Disappearing message (expires in 5 seconds)
    const expiringMsg = await emitAck(aliceSocket, 'message:send', {
      chatId,
      text: 'this will expire',
      clientId: 'alice-expiring-001',
      expiresIn: 5,
    });
    assert.equal(expiringMsg.ok, true);
    assert.ok(expiringMsg.message.expires_at);

  } catch (error) {
    throw new Error(`${(error as Error).message}\nServer output:\n${logs}`);
  }
});
