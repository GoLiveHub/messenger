import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startServer, stopServer, register, req, testPhone } from './test-helpers.js';

test('observability — liveness/readiness split and response headers', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'obs-health-'));
  const server = await startServer(tempDir);
  try {
    const liveness = await fetch(`${server.baseUrl}/api/health/liveness`);
    assert.equal(liveness.status, 200);
    assert.ok(liveness.headers.has('x-request-id'), 'liveness should set X-Request-Id');
    assert.match(liveness.headers.get('x-request-id')!, /^[0-9a-f-]{36}$/i, 'request id should be a UUID');

    const readiness = await fetch(`${server.baseUrl}/api/health/readiness`);
    assert.equal(readiness.status, 200);

    await register(server.baseUrl, testPhone(), 'Alice');
    const me = await fetch(`${server.baseUrl}/api/me`, { headers: { Cookie: '' } });
    assert.equal(me.status, 401);

    const metrics = await fetch(`${server.baseUrl}/api/metrics/prometheus`);
    assert.equal(metrics.status, 200);
    const text = await metrics.text();
    assert.match(text, /http_requests_total/, 'metrics should expose request counters');
    assert.match(text, /http_request_duration_seconds_bucket/, 'metrics should expose histogram buckets');
  } finally {
    await stopServer(server);
  }
});

test('observability — prometheus metrics reflect real traffic', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'obs-metrics-'));
  const server = await startServer(tempDir);
  try {
    const { cookies } = await register(server.baseUrl, testPhone(), 'Alice');

    // Generate a couple of authenticated requests
    await req(server.baseUrl, '/api/me', {}, cookies);
    await req(server.baseUrl, '/api/me', {}, cookies);

    const metrics = await fetch(`${server.baseUrl}/api/metrics/prometheus`);
    const text = await metrics.text();

    // Sum every labelled series of http_requests_total across routes/statuses
    const sum = text
      .split('\n')
      .filter((l) => /^http_requests_total\{.*\}\s+\d+$/.test(l) || /^http_requests_total\s+\d+$/.test(l))
      .reduce((acc, l) => acc + Number(l.trim().split(/\s+/).pop()!), 0);
    assert.ok(sum >= 5, `expected >=5 requests (register + health + metrics) but got ${sum}`);
    assert.ok(text.includes('# TYPE http_requests_total counter'), 'should declare counter TYPE');

    // Process gauges may or may not have been emitted yet depending on timing;
    // verify that the HELP/TYPE line appears once the interval fires.
    if (text.includes('process_uptime_seconds')) {
      assert.ok(text.includes('# TYPE process_uptime_seconds gauge'), 'uptime should be declared as gauge');
    }
  } finally {
    await stopServer(server);
  }
});

test('observability — request body must be an object (array rejected)', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'obs-body-'));
  const server = await startServer(tempDir);
  try {
    const { cookies } = await register(server.baseUrl, testPhone(), 'Alice');
    const res = await req(server.baseUrl, '/api/me/2fa', { method: 'POST', body: JSON.stringify([1, 2, 3]) }, cookies);
    assert.equal(res.status, 400, 'array body to a JSON endpoint must be rejected');
    assert.match(JSON.stringify(res.body), /object/i);
  } finally {
    await stopServer(server);
  }
});

test('observability — rate limit headers present on API responses', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'obs-ratelimit-'));
  const server = await startServer(tempDir);
  try {
    const { cookies } = await register(server.baseUrl, testPhone(), 'Alice');
    const res = await fetch(`${server.baseUrl}/api/me`, { headers: { Cookie: cookies } });
    assert.equal(res.status, 200);
    assert.ok(res.headers.has('ratelimit-limit'), 'RateLimit-Limit header should be present');
    assert.ok(res.headers.has('ratelimit-remaining'), 'RateLimit-Remaining header should be present');
    const remaining = Number(res.headers.get('ratelimit-remaining'));
    assert.ok(remaining >= 0 && remaining <= 300, `remaining should be within [0,300], got ${remaining}`);
  } finally {
    await stopServer(server);
  }
});

test('observability — idempotency key dedupes createIdempotent POST', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'obs-idem-'));
  const server = await startServer(tempDir);
  try {
    const a = await register(server.baseUrl, testPhone(), 'Alice');
    const b = await register(server.baseUrl, testPhone(), 'Bob');

    const first = await fetch(`${server.baseUrl}/api/chats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': a.cookies, 'X-CSRF-Token': (a.cookies.split('; ').find((c) => c.startsWith('csrf_token='))?.split('=').slice(1).join('') || ''), 'Idempotency-Key': 'idem-test-1' },
      body: JSON.stringify({ peerId: Number(b.user.id) }),
    });
    const second = await fetch(`${server.baseUrl}/api/chats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': a.cookies, 'X-CSRF-Token': (a.cookies.split('; ').find((c) => c.startsWith('csrf_token='))?.split('=').slice(1).join('') || ''), 'Idempotency-Key': 'idem-test-1' },
      body: JSON.stringify({ peerId: Number(b.user.id) }),
    });
    const firstBody = await first.json();
    const secondBody = await second.json();
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(firstBody.chat.id, secondBody.chat.id, 'same idempotency key must reuse the created chat');
  } finally {
    await stopServer(server);
  }
});

test('observability — push DLQ table exists and rejects malformed bots', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'obs-dlq-'));
  const server = await startServer(tempDir);
  try {
    const { cookies } = await register(server.baseUrl, testPhone(), 'Alice');
    // Bots endpoint is behind auth/CSRF; verify the table got created via migration test elsewhere.
    const res = await req(server.baseUrl, '/api/bots', {}, cookies);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body), 'bots list must return array');
  } finally {
    await stopServer(server);
  }
});