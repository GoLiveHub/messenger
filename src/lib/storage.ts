// Object storage abstraction: local filesystem by default, S3-compatible when
// STORAGE_DRIVER=s3. S3 requests are signed manually (AWS SigV4) and sent with
// fetch — no aws-sdk dependency.

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface StorageBackend {
  uploadFile(key: string, data: Buffer, contentType: string): Promise<string>;
  getFile(key: string): Promise<Buffer>;
  deleteFile(key: string): Promise<void>;
}

function sanitizeKey(key: string): string {
  const clean = key.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (clean.startsWith('/') || clean.split('/').includes('..')) {
    throw new Error('Invalid storage key');
  }
  return clean;
}

// ======================== LOCAL DRIVER ========================

class LocalStorage implements StorageBackend {
  private root: string;

  constructor(root?: string) {
    this.root = path.resolve(root || process.env.STORAGE_DIR || path.join(process.cwd(), 'data', 'storage'));
    fs.mkdirSync(this.root, { recursive: true });
  }

  private resolve(key: string): string {
    return path.join(this.root, sanitizeKey(key));
  }

  async uploadFile(key: string, data: Buffer, _contentType: string): Promise<string> {
    const target = this.resolve(key);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, data);
    return key;
  }

  async getFile(key: string): Promise<Buffer> {
    return fsp.readFile(this.resolve(key));
  }

  async deleteFile(key: string): Promise<void> {
    await fsp.rm(this.resolve(key), { force: true });
  }
}

// ======================== S3 DRIVER (SigV4 over fetch) ========================

function hmac(key: crypto.BinaryLike | Buffer, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function sha256Hex(data: crypto.BinaryLike | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

interface S3Config {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
}

function getS3Config(): S3Config {
  const endpoint = process.env.S3_ENDPOINT || '';
  const bucket = process.env.S3_BUCKET || '';
  const accessKey = process.env.S3_ACCESS_KEY || '';
  const secretKey = process.env.S3_SECRET_KEY || '';
  if (!endpoint || !bucket || !accessKey || !secretKey) {
    throw new Error('S3 storage requires S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY and S3_SECRET_KEY');
  }
  return { endpoint, bucket, accessKey, secretKey, region: process.env.S3_REGION || 'us-east-1' };
}

async function s3Request(method: 'PUT' | 'GET' | 'DELETE', key: string, body?: Buffer, contentType?: string): Promise<Response> {
  const cfg = getS3Config();
  const cleanKey = sanitizeKey(key);
  const encodedKey = cleanKey.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  const url = new URL(`${cfg.endpoint.replace(/\/+$/, '')}/${cfg.bucket}/${encodedKey}`);

  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body ?? Buffer.alloc(0));

  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (contentType) headers['content-type'] = contentType;

  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map((h) => `${h}:${headers[h]}\n`).join('');
  const canonicalRequest = [method, url.pathname, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(Buffer.from(canonicalRequest))].join('\n');

  const kDate = hmac(`AWS4${cfg.secretKey}`, dateStamp);
  const kRegion = hmac(kDate, cfg.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  headers['authorization'] =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return fetch(url, { method, headers, body: method === 'PUT' ? body : undefined });
}

class S3Storage implements StorageBackend {
  async uploadFile(key: string, data: Buffer, contentType: string): Promise<string> {
    const res = await s3Request('PUT', key, data, contentType || 'application/octet-stream');
    if (!res.ok) throw new Error(`S3 upload failed: HTTP ${res.status}`);
    return key;
  }

  async getFile(key: string): Promise<Buffer> {
    const res = await s3Request('GET', key);
    if (!res.ok) throw new Error(`S3 get failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async deleteFile(key: string): Promise<void> {
    const res = await s3Request('DELETE', key);
    if (!res.ok && res.status !== 404) throw new Error(`S3 delete failed: HTTP ${res.status}`);
  }
}

export function getStorage(): StorageBackend {
  const driver = String(process.env.STORAGE_DRIVER || 'local').toLowerCase();
  if (driver === 's3') return new S3Storage();
  return new LocalStorage();
}

const defaultStorage = getStorage();

export function uploadFile(key: string, data: Buffer, contentType: string): Promise<string> {
  return defaultStorage.uploadFile(key, data, contentType);
}

export function getFile(key: string): Promise<Buffer> {
  return defaultStorage.getFile(key);
}

export function deleteFile(key: string): Promise<void> {
  return defaultStorage.deleteFile(key);
}
