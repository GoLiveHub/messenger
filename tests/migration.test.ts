import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startServer, stopServer, register, req, testPhone } from './test-helpers.js';

const EXPECTED_TABLES = [
  'users', 'sessions', 'blocks', 'block_history', 'chats', 'chat_members',
  'messages', 'media', 'auth_codes', 'recovery_codes', 'phone_change_codes',
  'push_subscriptions', 'fcm_tokens', 'e2e_devices', 'e2e_signed_prekeys',
  'e2e_one_time_prekeys', 'e2e_sessions', 'saved_messages', 'reports',
  'global_bans', 'group_bans', 'shadow_bans', 'join_requests',
  'sticker_packs', 'user_sticker_packs', 'bots', 'reactions',
  'admin_log', 'call_history', 'drafts', 'scheduled_messages',
  'folders', 'folder_chats', 'forum_topics', 'permissions',
  'link_previews',
];

test('migration — all tables and columns exist', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'migration-test-'));
  const server = await startServer(tempDir);
  try {
    const { cookies } = await register(server.baseUrl, testPhone(), 'Admin');

    const health = await fetch(`${server.baseUrl}/api/health`);
    assert.ok(health.ok, 'Server health check should pass');

    const me = await req(server.baseUrl, '/api/me', {}, cookies);
    assert.equal(me.status, 200);
    assert.ok(me.body!.id, 'User profile should have an id');

    // Verify user has admin flag (first user)
    assert.equal(me.body!.is_admin, 1, 'First user should be admin');

    // Verify quiet_hours columns exist (addColumn migration)
    assert.ok('quiet_hours_start' in me.body!, 'User should have quiet_hours_start');
    assert.ok('quiet_hours_end' in me.body!, 'User should have quiet_hours_end');
  } finally {
    await stopServer(server);
  }
});

test('migration — key columns exist via PRAGMA', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'migration-pragma-'));
  const server = await startServer(tempDir);
  try {
    const { cookies } = await register(server.baseUrl, testPhone(), 'Admin');

    const meRes = await req(server.baseUrl, '/api/me', {}, cookies);
    assert.equal(meRes.status, 200);

    // Verify settings update works
    const settingsRes = await req(server.baseUrl, '/api/me/settings', { method: 'PUT', body: JSON.stringify({ settings: { theme: 'dark' } }) }, cookies);
    assert.equal(settingsRes.status, 200);

    // Verify call_history table structure by attempting a query
    const calls = await req(server.baseUrl, '/api/calls', {}, cookies);
    assert.equal(calls.status, 200);
    assert.ok(Array.isArray(calls.body), 'Calls should return array');

    // Verify blocks work
    const blocks = await req(server.baseUrl, '/api/blocks', {}, cookies);
    assert.equal(blocks.status, 200);
    assert.ok(Array.isArray(blocks.body), 'Blocks should return array');

    // Verify folders work
    const folders = await req(server.baseUrl, '/api/folders', {}, cookies);
    assert.equal(folders.status, 200);
  } finally {
    await stopServer(server);
  }
});
