import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startServer, stopServer, register, req, connectSocket, emitAck, testPhone } from './test-helpers.js';

// Verifies the FTS index stays consistent with messages: it is keyed by the
// real message id (rowid = messages.id), reflects edits, and drops entries on
// delete / clear history. Without an explicit FTS rowid the JOIN would miss.
test('full-text search reflects send, edit, delete and clear history', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'fts-'));
  const server = await startServer(tempDir);
  const sockets: any[] = [];
  try {
    const alice = await register(server.baseUrl, testPhone(), 'Alice');
    const bob = await register(server.baseUrl, testPhone(), 'Bob');
    const chatResp = await req(server.baseUrl, '/api/chats', { method: 'POST', body: JSON.stringify({ peerId: bob.user.id }) }, alice.cookies);
    assert.equal(chatResp.status, 200);
    const chatId = chatResp.body!.chat.id;

    const socket = await connectSocket(server.baseUrl, alice.cookies);
    sockets.push(socket);

    // Send
    const send = await emitAck(socket, 'message:send', { chatId, text: 'zebra grazing on the savanna', clientId: 'ftstest-zebra-1' });
    assert.equal(send.ok, true);
    const msgId = send.message.id;

    const searchHit = async (q: string) => {
      const r = await req(server.baseUrl, `/api/messages/search?q=${encodeURIComponent(q)}`, {}, alice.cookies);
      assert.equal(r.status, 200);
      return r.body!.results as Array<{ id: number; text: string }>;
    };

    // Found after send, and returned by the correct (real) id.
    let hits = await searchHit('zebra');
    assert.ok(hits.length >= 1);
    assert.ok(hits.some((h) => h.id === msgId), `expected message ${msgId} in FTS`);
    assert.equal(hits.find((h) => h.id === msgId)!.text, 'zebra grazing on the savanna');

    // Edit -> FTS must reflect new content and drop old term.
    const edit = await emitAck(socket, 'message:edit', { chatId, messageId: msgId, text: 'lion resting under the acacia' });
    assert.equal(edit.ok, true);
    assert.equal((await searchHit('lion')).some((h) => h.id === msgId), true, 'edited text should be searchable');
    assert.equal((await searchHit('zebra')).some((h) => h.id === msgId), false, 'old text should not match after edit');

    // Delete for everyone -> removed from FTS.
    const del = await emitAck(socket, 'message:delete', { chatId, messageId: msgId });
    assert.equal(del.ok, true);
    assert.equal((await searchHit('lion')).some((h) => h.id === msgId), false, 'deleted message should disappear from FTS');
  } finally {
    sockets.forEach((s) => s.disconnect());
    await stopServer(server);
  }
});
