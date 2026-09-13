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
    } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Server did not become healthy');
}

async function request(baseUrl: string, route: string, options: RequestInit = {}, cookies?: string) {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  if (cookies) headers.set('Cookie', cookies);
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
  const newCookies = extractCookies(response.headers.get('set-cookie'));
  const merged = mergeCookies(cookies, newCookies);
  return { status: response.status, body, cookies: merged };
}

function mergeCookies(existing?: string, newCookies?: string): string {
  if (!newCookies) return existing ?? '';
  if (!existing) return newCookies;
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

async function register(baseUrl: string, phone: string, firstName: string): Promise<any> {
  const codeResponse = await request(baseUrl, '/api/auth/sendCode', { method: 'POST', body: JSON.stringify({ phone }) });
  assert.equal(codeResponse.status, 200);
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
  const socket = io(baseUrl, {
    auth: { token: cookies.split('; ').find((c) => c.startsWith('session_token='))?.split('=')[1] || '' },
    reconnection: false,
    extraHeaders: { Cookie: cookies },
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket connection timed out')), 3_000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
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

test('debug: PRODUCTION new-account group posting cooldown', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'messenger-prod-'));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['dist-server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(tempDir, 'messenger.db'),
      SERVER_SECRET: 'prod-secret',
      EXPOSE_DEV_CODE: 'true',
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout?.on('data', (c) => { logs += String(c); });
  child.stderr?.on('data', (c) => { logs += String(c); });
  const sockets: Socket[] = [];
  t.after(async () => {
    sockets.forEach((s) => s.disconnect());
    child.kill();
    await new Promise((r) => setTimeout(r, 500));
    await rm(tempDir, { recursive: true, force: true });
  });
  try {
    await waitForHealth(baseUrl, child);
    const alice = await register(baseUrl, '+12025550801', 'Alice');
    const bob = await register(baseUrl, '+12025550802', 'Bob');
    const aliceSocket = await connect(baseUrl, alice.cookies);
    const bobSocket = await connect(baseUrl, bob.cookies);
    sockets.push(aliceSocket, bobSocket);
    const group = await request(baseUrl, '/api/groups', {
      method: 'POST',
      body: JSON.stringify({ title: 'Prod group', userIds: [bob.user.id] }),
    }, alice.cookies);
    assert.equal(group.status, 200);
    const groupId = Number(group.body!.chat.chat.id);
    const sent = await emitAck(aliceSocket, 'message:send', {
      chatId: groupId,
      text: 'hi prod group',
      clientId: 'prod-grp-0001',
    });
    console.log('PROD group send ack (default, cooldown off):', JSON.stringify(sent));
    assert.equal(sent.ok, true, `Group post should succeed with cooldown OFF by default\nserver:\n${logs}`);
    // Now spawn with the cooldown flag enabled and confirm it blocks.
    const port2 = await freePort();
    const baseUrl2 = `http://127.0.0.1:${port2}`;
    const child2 = spawn(process.execPath, ['dist-server/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port2),
        DB_PATH: path.join(tempDir, 'messenger2.db'),
        SERVER_SECRET: 'prod-secret-2',
        EXPOSE_DEV_CODE: 'true',
        NODE_ENV: 'production',
        NEW_ACCOUNT_GROUP_COOLDOWN: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs2 = '';
    child2.stdout?.on('data', (c) => { logs2 += String(c); });
    child2.stderr?.on('data', (c) => { logs2 += String(c); });
    t.after(() => child2.kill());
    try {
      await waitForHealth(baseUrl2, child2);
      const a2 = await register(baseUrl2, '+12025550803', 'Alice2');
      const b2 = await register(baseUrl2, '+12025550804', 'Bob2');
      const s2a = await connect(baseUrl2, a2.cookies);
      const s2b = await connect(baseUrl2, b2.cookies);
      sockets.push(s2a, s2b);
      const g2 = await request(baseUrl2, '/api/groups', {
        method: 'POST',
        body: JSON.stringify({ title: 'G2', userIds: [b2.user.id] }),
      }, a2.cookies);
      const g2id = Number(g2.body!.chat.chat.id);
      const s2 = await emitAck(s2a, 'message:send', { chatId: g2id, text: 'x', clientId: 'g2-0001' });
      console.log('PROD group send ack (flag ON):', JSON.stringify(s2));
      assert.equal(s2.ok, false, `Flag ON should still block new-account group posts\nserver:\n${logs2}`);
      assert.match(String(s2.error ?? ''), /24 hours/i);
    } finally {
      child2.kill();
      await new Promise((r) => setTimeout(r, 200));
    }
    console.log('CONFIRMED: cooldown off by default, works when flag enabled');
  } catch (error) {
    throw new Error(`${(error as Error).message}\nServer output:\n${logs}`);
  }
});

test('debug: call signaling reaching callee', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'messenger-call-'));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['dist-server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(tempDir, 'messenger.db'),
      SERVER_SECRET: 'call-secret',
      EXPOSE_DEV_CODE: 'true',
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout?.on('data', (c) => { logs += String(c); });
  child.stderr?.on('data', (c) => { logs += String(c); });
  const sockets: Socket[] = [];
  t.after(async () => {
    sockets.forEach((s) => s.disconnect());
    child.kill();
    await new Promise((r) => setTimeout(r, 500));
    await rm(tempDir, { recursive: true, force: true });
  });
  try {
    await waitForHealth(baseUrl, child);
    const alice = await register(baseUrl, '+12025550701', 'Alice');
    const bob = await register(baseUrl, '+12025550702', 'Bob');
    const aliceSocket = await connect(baseUrl, alice.cookies);
    const bobSocket = await connect(baseUrl, bob.cookies);
    sockets.push(aliceSocket, bobSocket);

    const chat = await request(baseUrl, '/api/chats', {
      method: 'POST',
      body: JSON.stringify({ peerId: bob.user.id, kind: 'regular' }),
    }, alice.cookies);
    assert.equal(chat.status, 200);
    const chatId = Number(chat.body!.chat.id);

    const bobRinging = new Promise<Json>((resolve) => bobSocket.once('call:ringing', resolve));
    const aliceInitiated = new Promise<Json>((resolve) => aliceSocket.once('call:initiated', resolve));

    aliceSocket.emit('call:init', { chatId, callType: 'audio' });

    const ringing = await bobRinging;
    const initiated = await aliceInitiated;
    console.log('Bob call:ringing:', JSON.stringify(ringing));
    console.log('Alice call:initiated:', JSON.stringify(initiated));
    assert.ok(ringing.callId, 'Bob should receive a callId in call:ringing');
    assert.equal(ringing.chatId, chatId);
    assert.equal(ringing.calleeShouldBe, undefined, 'sanity');
    assert.equal(initiated.callId, ringing.callId, 'callId must match between caller and callee');
    console.log('CALL SIGNALING OK — Bob receives ringing');
  } catch (error) {
    throw new Error(`${(error as Error).message}\nServer output:\n${logs}`);
  }
});

test('debug: group message delivery + echo to sender', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'messenger-debug-'));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['dist-server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(tempDir, 'messenger.db'),
      SERVER_SECRET: 'debug-secret',
      EXPOSE_DEV_CODE: 'true',
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout?.on('data', (c) => { logs += String(c); });
  child.stderr?.on('data', (c) => { logs += String(c); });

  const sockets: Socket[] = [];
  t.after(async () => {
    sockets.forEach((s) => s.disconnect());
    child.kill();
    await new Promise((r) => setTimeout(r, 500));
    await rm(tempDir, { recursive: true, force: true });
  });

  try {
    await waitForHealth(baseUrl, child);

    const alice = await register(baseUrl, '+12025550901', 'Alice');
    const bob = await register(baseUrl, '+12025550902', 'Bob');

    const aliceSocket = await connect(baseUrl, alice.cookies);
    const bobSocket = await connect(baseUrl, bob.cookies);
    sockets.push(aliceSocket, bobSocket);

    const group = await request(baseUrl, '/api/groups', {
      method: 'POST',
      body: JSON.stringify({ title: 'Debug group', userIds: [bob.user.id] }),
    }, alice.cookies);
    assert.equal(group.status, 200);
    const groupId = Number(group.body!.chat.chat.id);
    console.log('GROUP created id=', groupId);

    const aliceReceived: Json[] = [];
    const bobReceived: Json[] = [];
    aliceSocket.on('message:new', (m) => aliceReceived.push(m));
    bobSocket.on('message:new', (m) => bobReceived.push(m));

    const sent = await emitAck(aliceSocket, 'message:send', {
      chatId: groupId,
      text: 'hello group',
      clientId: 'dbg-group-0001',
    });
    console.log('SEND ack:', JSON.stringify(sent));

    await new Promise((r) => setTimeout(r, 300));

    console.log('Alice received count:', aliceReceived.length, JSON.stringify(aliceReceived));
    console.log('Bob received count:', bobReceived.length, JSON.stringify(bobReceived));

    assert.equal(sent.ok, true);
    assert.equal(aliceReceived.length, 1, `Alice should receive echo, got ${aliceReceived.length}\nserver:\n${logs}`);
    assert.equal(bobReceived.length, 1, `Bob should receive delivery, got ${bobReceived.length}\nserver:\n${logs}`);
    assert.equal(aliceReceived[0].id, sent.message.id);
    assert.equal(bobReceived[0].id, sent.message.id);

    console.log('GROUP DELIVERY OK');
  } catch (error) {
    throw new Error(`${(error as Error).message}\nServer output:\n${logs}`);
  }
});

test('debug: voice-recording indicator relays to chat peer', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'messenger-rec-'));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['dist-server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(tempDir, 'messenger.db'),
      SERVER_SECRET: 'rec-secret',
      EXPOSE_DEV_CODE: 'true',
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout?.on('data', (c) => { logs += String(c); });
  child.stderr?.on('data', (c) => { logs += String(c); });
  const sockets: Socket[] = [];
  t.after(async () => {
    sockets.forEach((s) => s.disconnect());
    child.kill();
    await new Promise((r) => setTimeout(r, 500));
    await rm(tempDir, { recursive: true, force: true });
  });
  try {
    await waitForHealth(baseUrl, child);
    const alice = await register(baseUrl, '+12025551001', 'Alice');
    const bob = await register(baseUrl, '+12025551002', 'Bob');
    const aliceSocket = await connect(baseUrl, alice.cookies);
    const bobSocket = await connect(baseUrl, bob.cookies);
    sockets.push(aliceSocket, bobSocket);

    const chat = await request(baseUrl, '/api/chats', {
      method: 'POST',
      body: JSON.stringify({ peerId: bob.user.id, kind: 'regular' }),
    }, alice.cookies);
    assert.equal(chat.status, 200);
    const chatId = Number(chat.body!.chat.id);

    const bobRecording: Json[] = [];
    bobSocket.on('recording', (p) => bobRecording.push(p));

    aliceSocket.emit('recording', { chatId, isRecording: true });
    await new Promise((r) => setTimeout(r, 300));
    aliceSocket.emit('recording', { chatId, isRecording: false });
    await new Promise((r) => setTimeout(r, 300));

    console.log('Bob recording events:', JSON.stringify(bobRecording));
    assert.equal(bobRecording.length, 2, `Bob should receive both recording events\nserver:\n${logs}`);
    assert.equal(bobRecording[0].chatId, chatId);
    assert.equal(bobRecording[0].userId, alice.user.id);
    assert.equal(bobRecording[0].isRecording, true);
    assert.equal(bobRecording[1].isRecording, false);
    console.log('RECORDING INDICATOR OK — Bob receives recording start/stop');
  } catch (error) {
    throw new Error(`${(error as Error).message}\nServer output:\n${logs}`);
  }
});
