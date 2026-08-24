import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startServer, stopServer, register, req, connectSocket, emitAck, testPhone } from './test-helpers.js';

test('load: group with many messages', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'messenger-load-'));
  const server = await startServer(tempDir);
  try {
    const alice = await register(server.baseUrl, testPhone(), 'LoadHost');
    const bob = await register(server.baseUrl, testPhone(), 'LoadMember');

    const groupResp = await req(server.baseUrl, '/api/groups', { method: 'POST', body: JSON.stringify({ title: 'Load Test Group', kind: 'group' }) }, alice.cookies);
    assert.equal(groupResp.status, 200, 'Group creation failed');
    const chatId = groupResp.body!.chat.chat.id;

    const inviteResp = await req(server.baseUrl, `/api/groups/${chatId}/invite-links`, { method: 'POST' }, alice.cookies);
    const joinResp = await req(server.baseUrl, `/api/groups/join/${inviteResp.body!.token}`, { method: 'POST' }, bob.cookies);
    assert.ok(joinResp.status < 400, 'Join failed');

    const socketAlice = await connectSocket(server.baseUrl, alice.cookies);
    const socketBob = await connectSocket(server.baseUrl, bob.cookies);

    // Send 20 messages via socket
    const sendPromises = [];
    for (let i = 0; i < 20; i++) {
      sendPromises.push(
        emitAck(socketAlice, 'message:send', { chatId, text: `Load test message ${i}` }),
      );
    }
    const results = await Promise.all(sendPromises);
    const failures = results.filter((r) => !r.ok);
    assert.equal(failures.length, 0, `${failures.length} messages failed to send`);

    // Verify messages are visible
    const msgsRes = await req(server.baseUrl, `/api/chats/${chatId}/messages`, {}, bob.cookies);
    const messages = Array.isArray(msgsRes.body) ? msgsRes.body : (msgsRes.body!.messages ?? []);
    assert.ok(messages.length >= 20, `Expected >= 20 messages, got ${messages.length}`);

    socketAlice.disconnect();
    socketBob.disconnect();
  } finally {
    await stopServer(server);
  }
});

test('load: concurrent user creation and chat creation', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'messenger-load-'));
  const server = await startServer(tempDir);
  try {
    const userPromises = [];
    for (let i = 0; i < 5; i++) {
      userPromises.push(register(server.baseUrl, testPhone(), `LoadUser${i}`));
    }
    const users = await Promise.all(userPromises);
    const userIds = users.map((u) => u.user.id);

    const chatPromises = [];
    for (let i = 0; i < userIds.length - 1; i++) {
      chatPromises.push(
        req(server.baseUrl, '/api/chats', { method: 'POST', body: JSON.stringify({ peerId: userIds[i + 1] }) }, users[i].cookies),
      );
    }
    const chats = await Promise.all(chatPromises);
    const chatFailures = chats.filter((c) => c.status >= 400);
    assert.equal(chatFailures.length, 0, `${chatFailures.length} chat creations failed`);

    const listRes = await req(server.baseUrl, '/api/chats', {}, users[0].cookies);
    assert.ok(listRes.body!.chats.length >= 1, 'Chat list should not be empty');
  } finally {
    await stopServer(server);
  }
});
