/**
 * Zod-driven request-body validation for key mutating endpoints.
 *
 * Central registry of schemas so a route opts in with `validateBody(POST_BODY)`.
 * Errors are normalized (first issue → 400) and logged with the request id.
 */

import { z } from 'zod';
import type { Request, Response, NextFunction } from 'express';
import { log } from '../lib/logger.js';

const msgText = z.string().max(4096);
const idOrNull = z.number().int().positive().nullish();
const intId = z.number().int().positive();
const uuid4 = z.string().uuid();
const uploadId = z.string().regex(/^u_\d+_\d+_[a-z0-9]{6}$/);

// --- Auth ---
export const checkPhoneSchema = z.object({ phone: z.string().min(5).max(32) });
export const sendCodeSchema = z.object({ phone: z.string().min(5).max(32), captchaToken: z.string().nullish(), captchaId: z.string().nullish() });
export const signUpSchema = z.object({
  phone: z.string().min(5).max(32),
  code: z.string().min(1).max(16),
  first_name: z.string().max(64),
  last_name: z.string().max(64).nullish(),
  username: z.string().regex(/^[a-zA-Z0-9_]{3,32}$/).nullish(),
});
export const signInSchema = z.object({ phone: z.string().min(5).max(32), code: z.string().min(1).max(16) });
export const checkPasswordSchema = z.object({ phone: z.string().min(5).max(32), password: z.string().max(256) });
export const verifyTotpSchema = z.object({ phone: z.string().min(5).max(32), code: z.string().min(1).max(16) });
export const recoverSchema = z.object({ phone: z.string().min(5).max(32) });

// --- Messages ---
export const messageSendREST = z.object({
  chatId: intId,
  text: msgText.nullish(),
  clientId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/).nullish(),
  clientTimestamp: z.string().max(64).nullish(),
  mediaId: idOrNull,
  replyTo: idOrNull,
  threadId: idOrNull,
  topicId: idOrNull,
  expiresIn: z.number().int().min(0).max(604800).nullish(),
});

// --- Chats / Groups ---
export const createChatSchema = z.object({
  peerId: z.coerce.number().int().positive(),
  kind: z.enum(['regular', 'secret']).nullish(),
});
export const createGroupSchema = z.object({
  kind: z.enum(['group', 'channel']).nullish(),
  title: z.string().max(100).nullish(),
  about: z.string().max(512).nullish(),
  photo: z.string().max(1_500_000).nullish(),
  userIds: z.array(z.coerce.number().int().positive()).max(100).nullish(),
  slowModeSeconds: z.number().int().min(0).max(3600).nullish(),
  megagroup: z.boolean().nullish(),
  isChannel: z.boolean().nullish(),
});
export const addGroupMembersSchema = z.object({ userIds: z.array(z.coerce.number().int().positive()).max(100) });
export const editChatSchema = z.object({
  title: z.string().min(1).max(100).nullish(),
  about: z.string().max(512).nullish(),
  username: z.string().regex(/^[a-zA-Z0-9_]{3,32}$/).nullish(),
});

// --- Media ---
// Active-content types that must never be re-served inline from media storage,
// otherwise a caller could persist text/html / SVG and <script> runs on the app
// origin (stored XSS). These are download-only / rejected at ingest.
const ACTIVE_CONTENT_RE =
  /^(text\/html|text\/javascript|application\/xml|text\/xml|image\/svg\+xml|application\/xhtml\+xml|application\/x-javascript|text\/x-js|image\/x-icon|application\/pdf)$/i;

export function isActiveContentType(mime: string | null | undefined): boolean {
  return Boolean(mime && ACTIVE_CONTENT_RE.test(mime.trim().toLowerCase()));
}

export const uploadInitSchema = z.object({
  chatId: z.coerce.number().int().positive(),
  kind: z.string().max(32).nullish(),
  name: z.string().max(255).nullish(),
  mime: z
    .string()
    .max(128)
    .nullish()
    .refine((m) => !isActiveContentType(m), { message: 'Unsupported media content type' }),
  totalChunks: z.coerce.number().int().min(1).max(2048).nullish(),
  size: z.coerce.number().finite().min(0).max(8 * 1024 * 1024).nullish(),
});

/** Fallback that refuses active content even when the caller skips the schema. */
export function safeMediaMime(mime: string | null | undefined, fallback = 'application/octet-stream'): string {
  return isActiveContentType(mime) ? fallback : (mime?.trim() ? mime.trim().toLowerCase() : fallback);
}

/**
 * Magic-byte content sniffing — the mime type from the request header is NOT
 * trusted (clients can submit image/png with polyglot/HTML payloads). Returns
 * the real image type encoded in the first bytes, or null if the bytes don't
 * match a supported image signature.
 */
export function detectImageMime(buf: Buffer): string | null {
  if (buf.length < 8) return null;
  // PNG 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  // JPEG FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  // GIF87a / GIF89a
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  // WebP: RIFF....WEBP
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  // BMP 42 4D
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return null;
}
export const uploadChunkSchema = z.object({ uploadId: uploadId, chunkIndex: z.coerce.number().int().min(0).max(2048) });
export const uploadFinalizeSchema = z.object({ uploadId: uploadId });

// --- Misc ---
export const idTokenSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/) });

/**
 * Express middleware: validate `req.body` against a schema, else 400.
 * Attaches `req.validatedBody` for the handler to consume.
 */
export function validateBody(schema: z.ZodTypeAny) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const message = issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid request body';
      log.warn('body_validation_failed', { requestId: req.id, path: req.path, message });
      res.status(400).json({ error: message });
      return;
    }
    (req as any).validatedBody = parsed.data;
    next();
  };
}

export const isStructuredBody = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export { z };