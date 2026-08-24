import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { io, type Socket } from 'socket.io-client';

type Json = Record<string, any>;

function extractCookies(raw: string | string[] | null | undefined): string {
  if (!raw) return '';
  const arr = Array.isArray(raw) ? raw : [raw];
  const cookies: string[] = [];
  for (const s of arr) {
    for (const part of s.split(',')) {
      const c = part.trim().split(';')[0];
      if (c.startsWith('session_token=') || c.startsWith('csrf_token=')) cookies.push(c);
    }
  }
  return cookies.join('; ');
}

export async function freePort(): Promise<number> {
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
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited with code ${child.exitCode}`);
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Server did not become healthy');
}

export function mergeCookies(a?: string, b?: string): string {
  if (!b) return a ?? '';
  if (!a) return b;
  const m = new Map<string, string>();
  for (const p of a.split('; ')) { const [k, ...v] = p.split('='); m.set(k, v.join('=')); }
  for (const p of b.split('; ')) { const [k, ...v] = p.split('='); m.set(k, v.join('=')); }
  return Array.from(m.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

function getSetCookieHeaders(resp: Response): string[] {
  const anyResp = resp as any;
  if (typeof anyResp.headers.getSetCookie === 'function') {
    return anyResp.headers.getSetCookie();
  }
  const raw = resp.headers.get('set-cookie');
  if (!raw) return [];
  return raw.split(/(?<=\S),\s*(?=\S)/);
}

export async function req(baseUrl: string, route: string, opts: RequestInit = {}, cookies?: string) {
  const headers = new Headers(opts.headers as Record<string, string> | undefined);
  if (opts.body && !(opts.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  if (cookies) headers.set('Cookie', cookies);
  const method = (opts.method ?? 'GET').toUpperCase();
  if (cookies && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const csrfMatch = cookies.split('; ').find((c) => c.startsWith('csrf_token='));
    if (csrfMatch) headers.set('X-CSRF-Token', csrfMatch.split('=').slice(1).join('='));
  }
  const response = await fetch(`${baseUrl}${route}`, { ...opts, headers, redirect: 'manual' });
  const body = await response.json().catch(() => null) as Json | null;
  const setCookies = getSetCookieHeaders(response);
  const nc = extractCookies(setCookies);
  return { status: response.status, body, cookies: mergeCookies(cookies, nc) };
}

let phoneCounter = 0;
export function testPhone(): string {
  phoneCounter++;
  return `+1202555${String(phoneCounter).padStart(4, '0')}`;
}

export async function register(baseUrl: string, phone: string, firstName: string) {
  const codeResp = await req(baseUrl, '/api/auth/sendCode', { method: 'POST', body: JSON.stringify({ phone }) });
  if (codeResp.status !== 200) {
    throw new Error(`sendCode failed: ${codeResp.status} ${JSON.stringify(codeResp.body)}`);
  }
  const signup = await req(baseUrl, '/api/auth/signUp', {
    method: 'POST',
    body: JSON.stringify({ phone, code: codeResp.body!.dev_code, phone_code_hash: codeResp.body!.phone_code_hash, first_name: firstName }),
  }, codeResp.cookies);
  if (signup.status !== 200) {
    throw new Error(`signUp failed for ${phone}: ${signup.status} ${JSON.stringify(signup.body)}`);
  }
  return { user: signup.body!.user, cookies: signup.cookies };
}

export async function signIn(baseUrl: string, phone: string) {
  const codeResp = await req(baseUrl, '/api/auth/sendCode', { method: 'POST', body: JSON.stringify({ phone }) });
  if (codeResp.status !== 200) {
    throw new Error(`sendCode for signIn failed: ${codeResp.status} ${JSON.stringify(codeResp.body)}`);
  }
  const login = await req(baseUrl, '/api/auth/signIn', {
    method: 'POST',
    body: JSON.stringify({ phone, code: codeResp.body!.dev_code, phone_code_hash: codeResp.body!.phone_code_hash }),
  }, codeResp.cookies);
  if (login.status !== 200) {
    throw new Error(`signIn failed for ${phone}: ${login.status} ${JSON.stringify(login.body)}`);
  }
  return { user: login.body!.user, cookies: login.cookies };
}

export async function connectSocket(baseUrl: string, cookies: string): Promise<Socket> {
  const token = cookies.split('; ').find(c => c.startsWith('session_token='))?.split('=').slice(1).join('') || '';
  const socket = io(baseUrl, { auth: { token }, reconnection: false, extraHeaders: { Cookie: cookies } });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket timeout')), 5000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', (e) => { clearTimeout(timer); reject(e); });
  });
  return socket;
}

export function emitAck(socket: Socket, event: string, payload: Json): Promise<Json> {
  return new Promise((resolve, reject) => {
    socket.timeout(5000).emit(event, payload, (timeoutError: Error | null, response: Json) => {
      if (timeoutError) reject(timeoutError); else resolve(response);
    });
  });
}

export async function startServer(tempDir: string) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['dist-server/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), DB_PATH: path.join(tempDir, 'db.sqlite'), SERVER_SECRET: 'test-secret-not-for-production', EXPOSE_DEV_CODE: 'true', NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForHealth(baseUrl, child);
  return { port, baseUrl, child, tempDir };
}

export async function stopServer(server: { child: ChildProcess; tempDir: string }) {
  server.child.kill();
  await new Promise<void>((resolve) => {
    server.child.on('exit', () => resolve());
    setTimeout(() => resolve(), 3000);
  });
  await new Promise((r) => setTimeout(r, 500));
  try {
    await rm(server.tempDir, { recursive: true, force: true });
  } catch {
    // Windows: retry once after a short delay
    await new Promise((r) => setTimeout(r, 500));
    try { await rm(server.tempDir, { recursive: true, force: true }); } catch {}
  }
}
