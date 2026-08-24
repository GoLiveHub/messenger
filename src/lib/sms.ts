/**
 * Pluggable SMS delivery provider.
 *
 * Set env:
 *   SMS_PROVIDER=console   (dev — prints code to console)
 *   SMS_PROVIDER=twilio     (production)
 *   SMS_PROVIDER=smsru      (sms.ru)
 *   SMS_PROVIDER=none       (disabled)
 */

import { config } from '../config.js';

export interface SmsProvider {
  send(to: string, body: string): Promise<void>;
}

// --- Console provider (dev) ---

class ConsoleSmsProvider implements SmsProvider {
  async send(to: string, body: string): Promise<void> {
    console.log(`[SMS → ${to}] ${body}`);
  }
}

// --- Twilio provider ---

class TwilioSmsProvider implements SmsProvider {
  private accountSid: string;
  private authToken: string;
  private from: string;

  constructor() {
    this.accountSid = config.twilioAccountSid ?? '';
    this.authToken = config.twilioAuthToken ?? '';
    this.from = config.twilioFrom ?? '';
    if (!this.accountSid || !this.authToken || !this.from) {
      console.warn('[SMS] Twilio credentials missing. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM');
    }
  }

  async send(to: string, body: string): Promise<void> {
    if (!this.accountSid || !this.authToken || !this.from) {
      throw new Error('Twilio credentials not configured');
    }
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    const params = new URLSearchParams({ To: to, From: this.from, Body: body });
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Twilio error ${resp.status}: ${err}`);
    }
  }
}

// --- SMS.ru provider ---

class SmsRuProvider implements SmsProvider {
  private apiKey: string;
  private from: string;

  constructor() {
    this.apiKey = config.smsRuApiKey ?? '';
    this.from = config.smsRuFrom ?? '';
    if (!this.apiKey) {
      console.warn('[SMS] SMS.ru API key missing. Set SMS_RU_API_KEY');
    }
  }

  async send(to: string, body: string): Promise<void> {
    if (!this.apiKey) throw new Error('SMS.ru API key not configured');
    const params = new URLSearchParams({
      api_id: this.apiKey,
      to,
      msg: body,
      json: '1',
      ...(this.from ? { from: this.from } : {}),
    });
    const resp = await fetch('https://sms.ru/sms/send', {
      method: 'POST',
      body: params.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const data = await resp.json() as any;
    if (data.status !== 'OK') throw new Error(`SMS.ru error: ${JSON.stringify(data)}`);
  }
}

// --- No-op provider ---

class NoopSmsProvider implements SmsProvider {
  async send(_to: string, _body: string): Promise<void> {
    console.warn('[SMS] SMS disabled (provider=none). Code not sent.');
  }
}

// --- Factory ---

let instance: SmsProvider | null = null;

export function getSmsProvider(): SmsProvider {
  if (instance) return instance;
  const provider = (config.smsProvider ?? 'console').toLowerCase();
  switch (provider) {
    case 'twilio':
      instance = new TwilioSmsProvider();
      break;
    case 'smsru':
      instance = new SmsRuProvider();
      break;
    case 'none':
      instance = new NoopSmsProvider();
      break;
    case 'console':
    default:
      instance = new ConsoleSmsProvider();
      break;
  }
  console.log(`[SMS] provider: ${provider}`);
  return instance;
}
