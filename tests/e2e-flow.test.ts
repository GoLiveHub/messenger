import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startServer, stopServer, register, req, connectSocket, emitAck, testPhone } from './test-helpers.js';

test('full flow: signup → chat → message → search', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'e2e-flow-'));
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
    const sendResult = await emitAck(socketAlice, 'message:send', { chatId, text: 'Hello from Alice', clientId: 'alice-e2e-1' });
    assert.equal(sendResult.ok, true, `Send failed: ${JSON.stringify(sendResult)}`);

    const search = await req(server.baseUrl, `/api/messages/search?q=${encodeURIComponent('Hello from Alice')}`, {}, alice.cookies);
    assert.equal(search.status, 200);
    assert.ok(search.body!.results.length > 0, 'Search should find the message');
  } finally {
    sockets.forEach((s) => s.disconnect());
    await stopServer(server);
  }
});

test('group flow: create → invite → message', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'e2e-group-'));
  const server = await startServer(tempDir);
  const sockets: any[] = [];
  try {
    const alice = await register(server.baseUrl, testPhone(), 'Alice');
    const bob = await register(server.baseUrl, testPhone(), 'Bob');

    const groupResp = await req(server.baseUrl, '/api/groups', { method: 'POST', body: JSON.stringify({ kind: 'group', title: 'Test Group' }) }, alice.cookies);
    assert.equal(groupResp.status, 200, `Group creation failed: ${JSON.stringify(groupResp.body)}`);
    const groupId = groupResp.body!.chat.chat.id;

    const inviteResp = await req(server.baseUrl, `/api/groups/${groupId}/invite-links`, { method: 'POST' }, alice.cookies);
    assert.equal(inviteResp.status, 200, `Invite link failed: ${JSON.stringify(inviteResp.body)}`);
    const linkToken = inviteResp.body!.token;

    const joinResp = await req(server.baseUrl, `/api/groups/join/${linkToken}`, { method: 'POST' }, bob.cookies);
    assert.equal(joinResp.status, 200, `Join failed: ${JSON.stringify(joinResp.body)}`);

    const socketAlice = await connectSocket(server.baseUrl, alice.cookies);
    sockets.push(socketAlice);
    const sendResult = await emitAck(socketAlice, 'message:send', { chatId: groupId, text: 'Group message', clientId: 'alice-group-1' });
    assert.equal(sendResult.ok, true, `Group send failed: ${JSON.stringify(sendResult)}`);
  } finally {
    sockets.forEach((s) => s.disconnect());
    await stopServer(server);
  }
});

test('channel flow: create → post → edit → delete', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'e2e-channel-'));
  const server = await startServer(tempDir);
  const sockets: any[] = [];
  try {
    const alice = await register(server.baseUrl, testPhone(), 'Alice');

    const chResp = await req(server.baseUrl, '/api/groups', { method: 'POST', body: JSON.stringify({ kind: 'channel', title: 'My Channel' }) }, alice.cookies);
    assert.equal(chResp.status, 200, `Channel creation failed: ${JSON.stringify(chResp.body)}`);
    const channelId = chResp.body!.chat.chat.id;

    const socketAlice = await connectSocket(server.baseUrl, alice.cookies);
    sockets.push(socketAlice);

    const postResult = await emitAck(socketAlice, 'message:send', { chatId: channelId, text: 'First post', clientId: 'ch-post-1' });
    assert.equal(postResult.ok, true, `Channel post failed: ${JSON.stringify(postResult)}`);
    const msgId = postResult.message.id;

    const editResult = await emitAck(socketAlice, 'message:edit', { chatId: channelId, messageId: msgId, text: 'Edited post' });
    assert.equal(editResult.ok, true, `Edit failed: ${JSON.stringify(editResult)}`);

    const deleteResult = await emitAck(socketAlice, 'message:delete', { chatId: channelId, messageId: msgId });
    assert.equal(deleteResult.ok, true, `Delete failed: ${JSON.stringify(deleteResult)}`);
  } finally {
    sockets.forEach((s) => s.disconnect());
    await stopServer(server);
  }
});

test('bot flow: create → list → delete', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'e2e-bot-'));
  const server = await startServer(tempDir);
  try {
    const alice = await register(server.baseUrl, testPhone(), 'Alice');

    const createBot = await req(server.baseUrl, '/api/bots', { method: 'POST', body: JSON.stringify({ name: 'TestBot', description: 'A test bot' }) }, alice.cookies);
    assert.equal(createBot.status, 200, `Bot creation failed: ${JSON.stringify(createBot.body)}`);
    assert.ok(createBot.body!.token, 'Response should include token');
    const botId = createBot.body!.id;

    const listBots = await req(server.baseUrl, '/api/bots', {}, alice.cookies);
    assert.equal(listBots.status, 200);
    const botList = Array.isArray(listBots.body) ? listBots.body : [];
    assert.ok(botList.length > 0);

    const delBot = await req(server.baseUrl, `/api/bots/${botId}`, { method: 'DELETE' }, alice.cookies);
    assert.equal(delBot.status, 200, `Bot delete failed: ${JSON.stringify(delBot.body)}`);
  } finally {
    await stopServer(server);
  }
});
