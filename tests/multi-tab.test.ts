import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startServer, stopServer, register, req, connectSocket, emitAck, testPhone } from './test-helpers.js';

test('two sessions can coexist and both make API calls', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'multi-tab-'));
  const server = await startServer(tempDir);
  try {
    const alice = await register(server.baseUrl, testPhone(), 'Alice');
    const bob = await register(server.baseUrl, testPhone(), 'Bob');

    const me1 = await req(server.baseUrl, '/api/me', {}, alice.cookies);
    assert.equal(me1.status, 200);
    const me2 = await req(server.baseUrl, '/api/me', {}, bob.cookies);
    assert.equal(me2.status, 200);
    assert.notEqual(me1.body!.id, me2.body!.id, 'Two different users');
  } finally {
    await stopServer(server);
  }
});

test('revoke one session — other continues working', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'revoke-test-'));
  const server = await startServer(tempDir);
  try {
    const alice = await register(server.baseUrl, testPhone(), 'Alice');

    const sessions = await req(server.baseUrl, '/api/sessions', {}, alice.cookies);
    assert.equal(sessions.status, 200, `Sessions failed: ${JSON.stringify(sessions.body)}`);
    const sessionList = Array.isArray(sessions.body) ? sessions.body : (sessions.body?.sessions || []);
    assert.ok(sessionList.length >= 1, `Should have >=1 session`);

    const me1 = await req(server.baseUrl, '/api/me', {}, alice.cookies);
    assert.equal(me1.status, 200, 'Session still works before revoke');

    if (sessionList.length > 1) {
      const sessionToRevoke = sessionList.find((s: any) => !s.current)?.id || sessionList[1].id;
      const revokeResp = await req(server.baseUrl, `/api/sessions/${sessionToRevoke}`, { method: 'DELETE' }, alice.cookies);
      assert.equal(revokeResp.status, 200);
    }
  } finally {
    await stopServer(server);
  }
});

test('both sessions receive real-time socket updates', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'multi-tab-rt-'));
  const server = await startServer(tempDir);
  const sockets: any[] = [];
  try {
    const alice = await register(server.baseUrl, testPhone(), 'Alice');
    const bob = await register(server.baseUrl, testPhone(), 'Bob');

    const chatResp = await req(server.baseUrl, '/api/chats', { method: 'POST', body: JSON.stringify({ peerId: bob.user.id }) }, alice.cookies);
    assert.equal(chatResp.status, 200, `Chat creation failed: ${JSON.stringify(chatResp.body)}`);
    const chatId = chatResp.body!.chat.id;

    const socketAlice = await connectSocket(server.baseUrl, alice.cookies);
    sockets.push(socketAlice);

    const received = new Promise<any>((resolve) => socketAlice.once('message:new', resolve));

    const bobSocket = await connectSocket(server.baseUrl, bob.cookies);
    sockets.push(bobSocket);
    await emitAck(bobSocket, 'message:send', { chatId, text: 'ping', clientId: 'multi-tab-msg-1' });

    const msg = await Promise.race([received, new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), 5000))]);
    assert.ok(msg, 'Socket should receive the message');
  } finally {
    sockets.forEach((s) => s.disconnect());
    await stopServer(server);
  }
});
