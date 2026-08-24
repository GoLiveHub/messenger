import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startServer, stopServer, register, req, testPhone } from './test-helpers.js';

test('network: server stays healthy after rapid socket connect/disconnect', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'messenger-net-'));
  const server = await startServer(tempDir);
  try {
    // Rapid connect/disconnect via socket.io-client
    const { io } = await import('socket.io-client');
    const sockets = [];
    for (let i = 0; i < 5; i++) {
      const s = io(server.baseUrl, { reconnection: false, extraHeaders: {} });
      sockets.push(s);
      setTimeout(() => s.disconnect(), 50 + Math.random() * 100);
    }
    await new Promise((r) => setTimeout(r, 2000));

    const health = await fetch(`${server.baseUrl}/api/health`);
    assert.ok(health.ok, 'Server should be healthy after rapid disconnects');
  } finally {
    await stopServer(server);
  }
});

test('network: server handles malformed requests gracefully', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'messenger-net-'));
  const server = await startServer(tempDir);
  try {
    const res = await fetch(`${server.baseUrl}/api/me`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"incomplete',
    });
    assert.ok(res.status >= 400, `Expected error status, got ${res.status}`);

    const health = await fetch(`${server.baseUrl}/api/health`);
    assert.ok(health.ok, 'Server should survive malformed request');
  } finally {
    await stopServer(server);
  }
});

test('network: concurrent large payloads do not crash server', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'messenger-net-'));
  const server = await startServer(tempDir);
  try {
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(
        fetch(`${server.baseUrl}/api/me`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: 'x'.repeat(10_000) }),
        }).catch(() => null),
      );
    }
    await Promise.all(promises);

    const health = await fetch(`${server.baseUrl}/api/health`);
    assert.ok(health.ok, 'Server should survive large payloads');
  } finally {
    await stopServer(server);
  }
});
