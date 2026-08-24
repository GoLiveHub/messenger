import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startServer, stopServer, register, req, testPhone, connectSocket, emitAck } from './test-helpers.js';

test('CSRF protection — mismatched token returns 403', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'csrf-test-'));
  const server = await startServer(tempDir);
  try {
    const { cookies } = await register(server.baseUrl, testPhone(), 'CSRF User');
    const csrfToken = cookies.split('; ').find((c) => c.startsWith('csrf_token='))?.split('=').slice(1).join('') || '';
    assert.ok(csrfToken, 'Should have CSRF token');
    const response = await fetch(`${server.baseUrl}/api/me`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookies,
        'X-CSRF-Token': 'totally-invalid-token',
      },
      body: JSON.stringify({ first_name: 'Hacked' }),
    });
    assert.equal(response.status, 403, `Expected 403, got ${response.status}`);
  } finally {
    await stopServer(server);
  }
});

test('SQL injection in search — users table survives', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sql-test-'));
  const server = await startServer(tempDir);
  try {
    const { cookies } = await register(server.baseUrl, testPhone(), 'SQL User');
    await req(server.baseUrl, `/api/messages/search?q=${encodeURIComponent("'; DROP TABLE users; --")}`, {}, cookies);
    const health = await fetch(`${server.baseUrl}/api/health`);
    assert.ok(health.ok, 'Server should still be healthy after SQL injection attempt');
  } finally {
    await stopServer(server);
  }
});

test('non-admin cannot access admin endpoints', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'admin-acl-test-'));
  const server = await startServer(tempDir);
  try {
    await register(server.baseUrl, testPhone(), 'Admin1');
    const nonAdmin = await register(server.baseUrl, testPhone(), 'NonAdmin');
    const resp = await req(server.baseUrl, '/api/admin/log', {}, nonAdmin.cookies);
    assert.equal(resp.status, 403, `Non-admin should be denied, got ${resp.status}`);
  } finally {
    await stopServer(server);
  }
});

test('unauthenticated requests to /api/me return 401', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'unauth-test-'));
  const server = await startServer(tempDir);
  try {
    const resp = await fetch(`${server.baseUrl}/api/me`);
    assert.equal(resp.status, 401);
  } finally {
    await stopServer(server);
  }
});

test('undo delete — message can be restored within window', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'undo-del-test-'));
  const server = await startServer(tempDir);
  try {
    const user = await register(server.baseUrl, testPhone(), 'Undo User');
    const peer = await register(server.baseUrl, testPhone(), 'Undo Peer');
    const chatResp = await req(server.baseUrl, '/api/chats', { method: 'POST', body: JSON.stringify({ peerId: peer.user.id }) }, user.cookies);
    assert.equal(chatResp.status, 200, `Chat creation failed: ${JSON.stringify(chatResp.body)}`);
    const chatId = chatResp.body!.chat.id;

    const socket = await connectSocket(server.baseUrl, user.cookies);
    try {
      const sendResult = await emitAck(socket, 'message:send', { chatId, text: 'Delete me', clientId: 'undo-test-1' });
      assert.equal(sendResult.ok, true, `Send failed: ${JSON.stringify(sendResult)}`);
    } finally {
      socket.disconnect();
    }

    const msgs = await req(server.baseUrl, `/api/chats/${chatId}/messages`, {}, user.cookies);
    assert.equal(msgs.status, 200);
    const msgList = Array.isArray(msgs.body) ? msgs.body : (msgs.body?.messages ?? []);
    const msg = msgList.find((m: any) => m.text === 'Delete me');
    assert.ok(msg, 'Should find the message');
    const msgId = msg.id;

    const socket2 = await connectSocket(server.baseUrl, user.cookies);
    try {
      await emitAck(socket2, 'message:delete', { chatId, messageId: msgId, forMe: true });
    } finally {
      socket2.disconnect();
    }

    const undeleteResp = await req(server.baseUrl, `/api/chats/${chatId}/messages/${msgId}/undelete`, { method: 'POST' }, user.cookies);
    assert.equal(undeleteResp.status, 200, `Undelete failed: ${JSON.stringify(undeleteResp.body)}`);
    assert.equal(undeleteResp.body!.ok, true);
  } finally {
    await stopServer(server);
  }
});

test('blocked user cannot send messages to blocker', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'block-msg-test-'));
  const server = await startServer(tempDir);
  try {
    const blocker = await register(server.baseUrl, testPhone(), 'Blocker');
    const blocked = await register(server.baseUrl, testPhone(), 'Blocked');
    const chatR = await req(server.baseUrl, '/api/chats', { method: 'POST', body: JSON.stringify({ peerId: blocked.user.id }) }, blocker.cookies);
    assert.equal(chatR.status, 200);
    const chatId = chatR.body!.chat.id;

    const blockResp = await req(server.baseUrl, `/api/blocks/${blocked.user.id}`, { method: 'PUT' }, blocker.cookies);
    assert.equal(blockResp.status, 200, `Block failed: ${JSON.stringify(blockResp.body)}`);

    const socket = await connectSocket(server.baseUrl, blocked.cookies);
    try {
      const sendResult = await emitAck(socket, 'message:send', { chatId, text: 'sneaky message', clientId: 'blocked-test-1' });
      assert.equal(sendResult.ok, false, `Should be blocked but got ok=true`);
    } finally {
      socket.disconnect();
    }
  } finally {
    await stopServer(server);
  }
});

test('XSS in message text is escaped', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'xss-test-'));
  const server = await startServer(tempDir);
  try {
    const user = await register(server.baseUrl, testPhone(), 'XSS User');
    const peer = await register(server.baseUrl, testPhone(), 'XSS Peer');
    const chatR = await req(server.baseUrl, '/api/chats', { method: 'POST', body: JSON.stringify({ peerId: peer.user.id }) }, user.cookies);
    assert.equal(chatR.status, 200);
    const chatId = chatR.body!.chat.id;

    const socket = await connectSocket(server.baseUrl, user.cookies);
    try {
      const sendResult = await emitAck(socket, 'message:send', { chatId, text: '<script>alert("xss")</script>', clientId: 'xss-test-1' });
      assert.equal(sendResult.ok, true, `Send failed: ${JSON.stringify(sendResult)}`);
    } finally {
      socket.disconnect();
    }

    const search = await req(server.baseUrl, `/api/messages/search?q=${encodeURIComponent('<script>')}`, {}, user.cookies);
    assert.ok(search.status === 200, `Expected 200, got ${search.status}: ${JSON.stringify(search.body)}`);
    assert.ok(Array.isArray(search.body?.results), `Expected results array`);
  } finally {
    await stopServer(server);
  }
});

test('permission matrix — set and get permissions', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'perm-test-'));
  const server = await startServer(tempDir);
  try {
    const owner = await register(server.baseUrl, testPhone(), 'Perm Owner');
    const res = await req(server.baseUrl, '/api/groups', { method: 'POST', body: JSON.stringify({ kind: 'group', title: 'Perm Group' }) }, owner.cookies);
    const chatId = res.body!.chat.chat.id;

    // Set permissions
    const setR = await req(server.baseUrl, `/api/groups/${chatId}/permissions`, {
      method: 'PUT',
      body: JSON.stringify({ permissions: [{ permission: 'send_messages', role_required: 'admin' }] }),
    }, owner.cookies);
    assert.equal(setR.status, 200);
    assert.equal(setR.body!.ok, true);

    // Get permissions
    const getR = await req(server.baseUrl, `/api/groups/${chatId}/permissions`, {}, owner.cookies);
    assert.equal(getR.status, 200);
    assert.ok(Array.isArray(getR.body));
    assert.ok(getR.body.some((p: any) => p.permission === 'send_messages'));

    // Reset permissions (owner only)
    const resetR = await req(server.baseUrl, `/api/groups/${chatId}/permissions/reset`, { method: 'POST' }, owner.cookies);
    assert.equal(resetR.status, 200);
  } finally {
    await stopServer(server);
  }
});

test('public join by username', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'public-join-test-'));
  const server = await startServer(tempDir);
  try {
    const owner = await register(server.baseUrl, testPhone(), 'Join Owner');
    // Create group with username
    const createR = await req(server.baseUrl, '/api/groups', { method: 'POST', body: JSON.stringify({ kind: 'group', title: 'Public Group' }) }, owner.cookies);
    const chatId = createR.body!.chat.chat.id;
    await req(server.baseUrl, `/api/groups/${chatId}`, { method: 'PATCH', body: JSON.stringify({ title: 'Public Group', username: 'publicgroup123' }) }, owner.cookies);

    // Lookup by username
    const lookupR = await req(server.baseUrl, '/api/groups/lookup/publicgroup123', {}, owner.cookies);
    assert.equal(lookupR.status, 200);
    assert.equal(lookupR.body!.chat_id, chatId);

    // Join by username
    const joiner = await register(server.baseUrl, testPhone(), 'Join User');
    const joinR = await req(server.baseUrl, '/api/groups/join-by-username/publicgroup123', { method: 'POST' }, joiner.cookies);
    assert.equal(joinR.status, 200);
    assert.ok(joinR.body!.chat);
  } finally {
    await stopServer(server);
  }
});

test('mute member with duration — posting restriction', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'mute-dur-test-'));
  const server = await startServer(tempDir);
  try {
    const owner = await register(server.baseUrl, testPhone(), 'Mute Owner');
    const member = await register(server.baseUrl, testPhone(), 'Mute Member');
    const res = await req(server.baseUrl, '/api/groups', { method: 'POST', body: JSON.stringify({ kind: 'group', title: 'Mute Group' }) }, owner.cookies);
    const chatId = res.body!.chat.chat.id;
    await req(server.baseUrl, `/api/groups/${chatId}/members`, { method: 'POST', body: JSON.stringify({ userIds: [member.user.id] }) }, owner.cookies);

    // Mute member for 60 seconds
    const muteR = await req(server.baseUrl, `/api/groups/${chatId}/mute-member`, {
      method: 'PUT',
      body: JSON.stringify({ userId: member.user.id, duration: 60 }),
    }, owner.cookies);
    assert.equal(muteR.status, 200);

    // Muted member should be blocked from posting
    const socket = await connectSocket(server.baseUrl, member.cookies);
    try {
      const sendResult = await emitAck(socket, 'message:send', { chatId, text: 'Should be blocked', clientId: 'mute-test-1' });
      assert.equal(sendResult.ok, false, 'Muted member should not be able to post');
      assert.ok(sendResult.error?.includes('restricted'), `Expected restriction error, got: ${sendResult.error}`);
    } finally {
      socket.disconnect();
    }

    // Unmute
    const unmuteR = await req(server.baseUrl, `/api/groups/${chatId}/mute-member`, {
      method: 'DELETE',
      body: JSON.stringify({ userId: member.user.id }),
    }, owner.cookies);
    assert.equal(unmuteR.status, 200);

    // Now member can post
    const socket2 = await connectSocket(server.baseUrl, member.cookies);
    try {
      const sendResult2 = await emitAck(socket2, 'message:send', { chatId, text: 'Should work now', clientId: 'mute-test-2' });
      assert.equal(sendResult2.ok, true, `Unmuted member should be able to post: ${JSON.stringify(sendResult2)}`);
    } finally {
      socket2.disconnect();
    }
  } finally {
    await stopServer(server);
  }
});

test('APNs token registration', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'apns-test-'));
  const server = await startServer(tempDir);
  try {
    const user = await register(server.baseUrl, testPhone(), 'APNs User');
    const res = await req(server.baseUrl, '/api/push/apns-token', {
      method: 'POST',
      body: JSON.stringify({ token: 'test-apns-token-12345' }),
    }, user.cookies);
    assert.equal(res.status, 200);
    assert.equal(res.body!.ok, true);

    // Duplicate should be fine
    const res2 = await req(server.baseUrl, '/api/push/apns-token', {
      method: 'POST',
      body: JSON.stringify({ token: 'test-apns-token-12345' }),
    }, user.cookies);
    assert.equal(res2.status, 200);
  } finally {
    await stopServer(server);
  }
});
