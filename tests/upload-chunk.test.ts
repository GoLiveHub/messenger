import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startServer, stopServer, register, req, testPhone } from './test-helpers.js';

function chunkFetch(baseUrl: string, route: string, cookies: string | undefined, fields: Record<string, string>, chunk: Uint8Array) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10_000);
  return fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: {
      Cookie: cookies ?? '',
      'X-CSRF-Token': (cookies ?? '').split('; ').find((c) => c.startsWith('csrf_token='))?.split('=').slice(1).join('') ?? '',
      Accept: 'application/json',
    },
    body: (() => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      fd.append('chunk', new Blob([chunk] as BlobPart[], { type: 'application/octet-stream' }), 'chunk.bin');
      return fd;
    })(),
    signal: controller.signal,
  })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
    .finally(() => clearTimeout(t));
}

test('chunked upload: validates bounds, aggregate limit and completeness', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'upload-chunk-'));
  const server = await startServer(tempDir);
  try {
    const alice = await register(server.baseUrl, testPhone(), 'Alice');
    const bob = await register(server.baseUrl, testPhone(), 'Bob');
    // Create a chat between them (required by upload-finalize).
    const chatResp = await req(server.baseUrl, '/api/chats', { method: 'POST', body: JSON.stringify({ peerId: bob.user.id }) }, alice.cookies);
    assert.equal(chatResp.status, 200);
    const chatId = chatResp.body!.chat.id;

    // 1. Invalid totalChunks rejected.
    for (const bad of [0, -1, 1.5, 99999999]) {
      const init = await req(server.baseUrl, '/api/media/upload-init', {
        method: 'POST',
        body: JSON.stringify({ chatId, kind: 'file', totalChunks: bad, size: 10 }),
      }, alice.cookies);
      assert.equal(init.status, 400, `totalChunks=${bad} should be rejected`);
    }

    // 2. Declared size exceeding 8 MB rejected.
    const big = await req(server.baseUrl, '/api/media/upload-init', {
      method: 'POST',
      body: JSON.stringify({ chatId, kind: 'file', totalChunks: 2, size: 20 * 1024 * 1024 }),
    }, alice.cookies);
    assert.equal(big.status, 400, 'oversized declared size should be rejected');

    // 3. Valid init.
    const init = await req(server.baseUrl, '/api/media/upload-init', {
      method: 'POST',
      body: JSON.stringify({ chatId, kind: 'file', name: 'x.bin', mime: 'application/octet-stream', totalChunks: 2, size: 200 }),
    }, alice.cookies);
    assert.equal(init.status, 200);
    const uploadId = init.body!.uploadId as string;

    // 4. Out-of-range chunkIndex rejected.
    const badIdx = await chunkFetch(server.baseUrl, '/api/media/upload-chunk', alice.cookies, { uploadId, chunkIndex: '5' }, new Uint8Array(100));
    assert.equal(badIdx.status, 400, 'out-of-range chunkIndex should be rejected');

    // 5. Duplicate chunk rejected.
    const ok0 = await chunkFetch(server.baseUrl, '/api/media/upload-chunk', alice.cookies, { uploadId, chunkIndex: '0' }, new Uint8Array(100));
    assert.equal(ok0.status, 200);
    const dup = await chunkFetch(server.baseUrl, '/api/media/upload-chunk', alice.cookies, { uploadId, chunkIndex: '0' }, new Uint8Array(1));
    assert.equal(dup.status, 409, 'duplicate chunk should be rejected');

    // 6. Incomplete upload cannot be finalized.
    const incomplete = await req(server.baseUrl, '/api/media/upload-finalize', {
      method: 'POST',
      body: JSON.stringify({ uploadId }),
    }, alice.cookies);
    assert.equal(incomplete.status, 400, 'incomplete upload should not finalize');

    // 7. Complete the upload and finalize successfully.
    const ok1 = await chunkFetch(server.baseUrl, '/api/media/upload-chunk', alice.cookies, { uploadId, chunkIndex: '1' }, new Uint8Array(100));
    assert.equal(ok1.status, 200);
    const fin = await req(server.baseUrl, '/api/media/upload-finalize', {
      method: 'POST',
      body: JSON.stringify({ uploadId }),
    }, alice.cookies);
    assert.equal(fin.status, 200, `finalize failed: ${JSON.stringify(fin.body)}`);
    assert.ok(fin.body!.media?.id, 'expected a media id');

    // 8. A fresh session rejects an aggregate size that exceeds the 8 MB cap.
    const init2 = await req(server.baseUrl, '/api/media/upload-init', {
      method: 'POST',
      body: JSON.stringify({ chatId, kind: 'file', totalChunks: 10, size: 9 * 1024 * 1024 }),
    }, alice.cookies);
    assert.equal(init2.status, 400, 'init itself should reject >8MB aggregate');
  } finally {
    await stopServer(server);
  }
});
