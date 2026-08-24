/**
 * Centralized server error codes + localized client mapping.
 *
 * Server res.json({ error: '<code>' }) uses these codes.
 * Client calls `t(code)` or `errorText(code)` to translate.
 */

export const ERROR_CODES = {
  AUTH_REQUIRED: 'auth_required',
  AUTH_INVALID: 'auth_invalid',
  AUTH_EXPIRED: 'auth_expired',
  CSRF_INVALID: 'csrf_invalid',
  RATE_LIMITED: 'rate_limited',
  NOT_FOUND: 'not_found',
  FORBIDDEN: 'forbidden',
  CHAT_NOT_FOUND: 'chat_not_found',
  MESSAGE_NOT_FOUND: 'message_not_found',
  USER_NOT_FOUND: 'user_not_found',
  MEDIA_NOT_FOUND: 'media_not_found',
  INVALID_PHONE: 'invalid_phone',
  INVALID_NAME: 'invalid_name',
  GROUP_FULL: 'group_full',
  ALREADY_MEMBER: 'already_member',
  SELF_BLOCK: 'self_block',
  BLOCKED: 'blocked',
  TWO_FA_REQUIRED: 'two_fa_required',
  INVALID_2FA: 'invalid_2fa',
  INVALID_TOTP: 'invalid_totp',
  INVALID_RECOVERY: 'invalid_recovery',
  SESSION_EXPIRED: 'session_expired',
  ADMIN_ONLY: 'admin_only',
  INVALID_INPUT: 'invalid_input',
  FILE_TOO_LARGE: 'file_too_large',
  DURATION_EXCEEDED: 'duration_exceeded',
  SLOW_MODE: 'slow_mode',
  SECRET_CHAT_LIMIT: 'secret_chat_limit',
  MEDIA_TYPE_MISMATCH: 'media_type_mismatch',
  NO_FILE: 'no_file',
  SENDER_BLOCKED: 'sender_blocked',
  CANNOT_MESSAGE: 'cannot_message',
  TOO_MANY_CONTACTS: 'too_many_contacts',
  INVITE_NOT_FOUND: 'invite_not_found',
  INVALID_LINK: 'invalid_link',
  REACTION_LIMIT: 'reaction_limit',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
