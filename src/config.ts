const isProduction = process.env.NODE_ENV === 'production';
const serverSecret = process.env.SERVER_SECRET || (isProduction ? '' : 'local-development-only-secret');

if (!serverSecret) {
  throw new Error('SERVER_SECRET is required when NODE_ENV=production');
}

export const config = {
  isProduction,
  port: Number(process.env.PORT || (isProduction ? 80 : 3001)),
  dbPath: process.env.DB_PATH || (isProduction ? 'data/messenger.db' : 'data/messenger.dev.db'),
  dbDriver: (process.env.DB_DRIVER || 'sqlite') as 'sqlite' | 'postgres',
  databaseUrl: process.env.DATABASE_URL || '',
  redisUrl: process.env.REDIS_URL || '',
  serverSecret,
  exposeDevCode: process.env.EXPOSE_DEV_CODE === 'true',
  smsWebhookUrl: process.env.SMS_WEBHOOK_URL || '',
  smsWebhookToken: process.env.SMS_WEBHOOK_TOKEN || '',
  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'http://127.0.0.1:5173,http://localhost:5173,http://messenger.local:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  codeTtlMs: 5 * 60 * 1000,
  sessionTtlDays: 30,
  /** Cookie attributes for session and CSRF tokens. */
  sessionCookieMaxAge: 30 * 24 * 3600, // 30 days in seconds
  csrfCookieMaxAge: 30 * 24 * 3600,
  sessionCookieName: 'session_token',
  csrfCookieName: 'csrf_token',
  // SMS provider: console | twilio | smsru | none
  smsProvider: process.env.SMS_PROVIDER || 'console',
  // Twilio
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || '',
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || '',
  twilioFrom: process.env.TWILIO_FROM || '',
  // SMS.ru
  smsRuApiKey: process.env.SMS_RU_API_KEY || '',
  smsRuFrom: process.env.SMS_RU_FROM || '',
  // Web Push (VAPID)
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || '',
  vapidSubject: process.env.VAPID_SUBJECT || 'mailto:admin@messenger.local',
  // Data retention
  dataRetentionDays: Number(process.env.DATA_RETENTION_DAYS || '365'),
  // Tenor GIF API. LIVDSRZULELA is the widely-published Tenor *prototype*/doc key
  // (used across countless open-source demos); replace with your own key from
  // https://developers.google.com/tenor/guides/quickstart for production use.
  tenorApiKey: process.env.TENOR_API_KEY || 'LIVDSRZULELA',
  // Feature flags. Enabled everywhere: voice/video calls work through built-in
  // socket signaling (public STUN by default, TURN via VITE_TURN_* for
  // restrictive NATs), and secret chats use the client-side E2E ratchet.
  features: {
    calls: true,
    e2eSecretChats: true,
    scheduledMessages: true,
    folders: true,
  },
  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
};
