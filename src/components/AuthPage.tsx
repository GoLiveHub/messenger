import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { store } from '../store';
import { ensureE2EKeys } from '../crypto/ensureKeys';
import { COUNTRIES, formatNational, digitsOnly, detectCountry, validatePhone, type PhoneCountry } from '../phone';
import { CountrySelect } from './CountrySelect';
import { t, useLang } from '../i18n';

type Step = 'phone' | 'code' | 'signup' | '2fa' | 'totp' | 'recovery';

function defaultCountry(): PhoneCountry {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale ?? '';
    const region = locale.match(/[-_]([A-Za-z]{2})(?:$|[-_])/)?.[1]?.toUpperCase();
    return COUNTRIES.find((country) => country.iso2 === region) ?? COUNTRIES.find((country) => country.iso2 === 'US') ?? COUNTRIES[0];
  } catch {
    return COUNTRIES.find((country) => country.iso2 === 'US') ?? COUNTRIES[0];
  }
}

function deviceLabel(): string | undefined {
  try {
    const ua = navigator.userAgent;
    const m = ua.match(/\(([^)]+)\)/);
    return (m ? m[1] : ua).slice(0, 64);
  } catch {
    return undefined;
  }
}

export function AuthPage() {
  useLang();
  const [step, setStep] = useState<Step>('phone');
  const [country, setCountry] = useState<PhoneCountry>(defaultCountry);
  const [nationalDigits, setNationalDigits] = useState('');
  const [code, setCode] = useState('');
  const [phoneCodeHash, setPhoneCodeHash] = useState('');
  const [firstName, setFirstName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [captchaToken, setCaptchaToken] = useState('');
  const [captchaQuestion, setCaptchaQuestion] = useState('');
  const [captchaAnswer, setCaptchaAnswer] = useState('');
  const [showCaptcha, setShowCaptcha] = useState(false);
  const [captchaVerified, setCaptchaVerified] = useState(false);
  const codeInputRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const phone = useMemo(() => '+' + country.cc + nationalDigits, [country.cc, nationalDigits]);
  const phoneValid = validatePhone(phone) !== null;

  const fetchCaptcha = async () => {
    try {
      const res = await fetch('/api/auth/captcha/challenge', { method: 'POST' });
      const data = await res.json();
      setCaptchaToken(data.token);
      setCaptchaQuestion(data.question);
      setShowCaptcha(true);
      setCaptchaAnswer('');
    } catch { /* ignore */ }
  };

  const verifyCaptcha = async (): Promise<boolean> => {
    if (!captchaToken || !captchaAnswer) return false;
    try {
      const res = await fetch('/api/auth/captcha/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: captchaToken, answer: Number(captchaAnswer) }),
      });
      const data = await res.json();
      if (data.correct) {
        setCaptchaVerified(true);
        setShowCaptcha(false);
        return true;
      }
      setError(t('Incorrect answer. Try again.'));
      await fetchCaptcha();
      return false;
    } catch {
      return false;
    }
  };

  // Auto-send code after captcha is verified (avoids stale showCaptcha state)
  useEffect(() => {
    if (captchaVerified && step === 'phone' && phoneValid) {
      setCaptchaVerified(false);
      (async () => {
        setLoading(true);
        try {
          const res = await api.sendCode(phone);
          setPhoneCodeHash(res.phone_code_hash);
          setCode(res.dev_code ?? '');
          setStep('code');
        } catch (err) {
          const msg = (err as Error).message;
          setError(msg.includes('Wait') ? t('Please wait before requesting another code.') : msg);
        } finally {
          setLoading(false);
        }
      })();
    }
  }, [captchaVerified, step, phoneValid]);

  const onPhoneChange = (inputVal: string) => {
    const d = digitsOnly(inputVal);
    if (d.length === 0) {
      setNationalDigits('');
      return;
    }
    const pastedInternational = inputVal.trim().startsWith('+');
    const det = pastedInternational ? detectCountry(d) : null;
    if (det) {
      setCountry(det);
      setNationalDigits(d.slice(det.cc.length).slice(0, det.max));
    } else {
      setNationalDigits(d.slice(0, country.max));
    }
    setError('');
  };

  const changeCountry = (c: PhoneCountry) => {
    setCountry(c);
    setNationalDigits(nationalDigits.slice(0, c.max));
    setError('');
  };

  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!phoneValid) return;
    // Show CAPTCHA challenge if not yet verified
    if (!captchaVerified && !showCaptcha) {
      await fetchCaptcha();
      return;
    }
    if (showCaptcha) return; // waiting for CAPTCHA answer
    setLoading(true);
    try {
      const res = await api.sendCode(phone);
      setPhoneCodeHash(res.phone_code_hash);
      setCode(res.dev_code ?? '');
      setStep('code');
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg.includes('Wait') ? t('Please wait before requesting another code.') : msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (step === 'code' && codeInputRef.current) {
      codeInputRef.current.focus();
    }
  }, [step]);

  useEffect(() => {
    if (step === 'signup' && nameInputRef.current) {
      nameInputRef.current.focus();
    }
  }, [step]);

  useEffect(() => {
    if (step === 'code' && code.length === 6) {
      handleVerifyCode({ preventDefault: () => {} } as React.FormEvent);
    }
  }, [code]);

  const handleVerifyCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code || !phoneCodeHash) return;
    setError('');
    setLoading(true);
    try {
      const res = await api.signIn({ phone, code, phone_code_hash: phoneCodeHash, device: deviceLabel() });
      if (res.status === 'need_password') {
        setStep('2fa');
        return;
      }
      if (res.status === 'need_totp') {
        setStep('totp');
        return;
      }
      await finishAuth(res.user);
    } catch (err) {
      if ((err as Error).message.includes('No account')) {
        setStep('signup');
      } else {
        setError((err as Error).message);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!firstName.trim()) {
      setError(t('First name is required'));
      return;
    }
    setLoading(true);
    try {
      const res = await api.signUp({
        phone,
        code,
        phone_code_hash: phoneCodeHash,
        first_name: firstName.trim(),
        device: deviceLabel(),
      });
      await finishAuth(res.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handle2FA = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await api.checkPassword({
        phone,
        code,
        phone_code_hash: phoneCodeHash,
        password,
        device: deviceLabel(),
      });
      await finishAuth(res.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await api.verifyTotp({
        phone,
        code,
        phone_code_hash: phoneCodeHash,
        totp_token: password,
        device: deviceLabel(),
      });
      await finishAuth(res.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleRecovery = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!password.trim()) return;
    setLoading(true);
    try {
      const res = await api.recover(phone, password.trim());
      await finishAuth(res.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const finishAuth = async (user: any) => {
    // Session is now maintained via HttpOnly cookies set by the server.
    // No need to store the token in localStorage or module state.
    store.set({ me: user });
    void ensureE2EKeys(user.id).catch(() => {});
  };

  const backToPhone = () => {
    setStep('phone');
    setError('');
    setCode('');
    setPhoneCodeHash('');
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-logo">Messenger</div>

        {step === 'phone' && (
          <form onSubmit={handleSendCode}>
            <h2>{t('Sign in to Messenger')}</h2>
            <div className="auth-field">
              <CountrySelect value={country} onChange={changeCountry} />
              <div className="phone-input-wrap">
                <span className="phone-prefix">+{country.cc}</span>
                <input
                  value={formatNational(nationalDigits, country.groups)}
                  inputMode="numeric"
                  pattern="[0-9 ]*"
                  onChange={(e) => onPhoneChange(e.target.value)}
                  autoFocus
                />
              </div>
            </div>
            {showCaptcha && (
              <div className="auth-field" style={{ marginTop: '0.75rem' }}>
                <label style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)', marginBottom: '0.25rem', display: 'block' }}>
                  {t('Solve to prove you are human')}: <b>{captchaQuestion}</b>
                </label>
                <input
                  value={captchaAnswer}
                  onChange={(e) => setCaptchaAnswer(e.target.value)}
                  inputMode="numeric"
                  placeholder={t('Your answer')}
                  autoFocus
                  onKeyDown={async (e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      const ok = await verifyCaptcha();
                      if (ok) {
                        setShowCaptcha(false);
                        // Auto-submit after captcha verification
                        handleSendCode({ preventDefault: () => {} } as React.FormEvent);
                      }
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await verifyCaptcha();
                    if (ok) {
                      setShowCaptcha(false);
                      handleSendCode({ preventDefault: () => {} } as React.FormEvent);
                    }
                  }}
                  disabled={!captchaAnswer}
                  style={{ marginTop: '0.375rem' }}
                >
                  {t('Verify')}
                </button>
              </div>
            )}
            <button disabled={loading || !phoneValid}>
              {loading ? t('Sending…') : t('Next')}
            </button>
          </form>
        )}

        {step === 'code' && (
          <form onSubmit={handleVerifyCode}>
            <h2>{t('We sent you a code')}</h2>
            <p className="muted">
              to <b>{phone}</b> <button type="button" className="link" onClick={backToPhone}>{t('change')}</button>
            </p>
            <input
              ref={codeInputRef}
              placeholder={t('Code')}
              value={code}
              onChange={(e) => setCode(digitsOnly(e.target.value).slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              autoFocus
            />
            <button disabled={loading}>{loading ? t('Checking…') : t('Sign in')}</button>
          </form>
        )}

        {step === 'signup' && (
          <form onSubmit={handleSignUp}>
            <h2>{t('What is your name?')}</h2>
            <input
              ref={nameInputRef}
              placeholder={t('First name')}
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              autoFocus
            />
            <button disabled={loading}>{loading ? t('Creating…') : t('Next')}</button>
          </form>
        )}

        {step === '2fa' && (
          <form onSubmit={handle2FA}>
            <h2>{t('Two-factor password')}</h2>
            <p className="muted">{t('This account is protected by a password.')}</p>
            <input placeholder={t('Password')} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
            <button disabled={loading}>{loading ? t('Checking…') : t('Unlock')}</button>
            <p className="muted" style={{ marginTop: 8 }}>
              <button type="button" className="link" onClick={() => { setStep('recovery'); setPassword(''); setError(''); }}>
                {t('Use recovery code')}
              </button>
            </p>
          </form>
        )}

        {step === 'totp' && (
          <form onSubmit={handleTotp}>
            <h2>{t('Authenticator code')}</h2>
            <p className="muted">{t('Enter the 6-digit code from your authenticator app.')}</p>
            <input placeholder="123456" maxLength={6} inputMode="numeric" pattern="[0-9]{6}" value={password} onChange={(e) => setPassword(e.target.value.replace(/\D/g, '').slice(0, 6))} autoFocus />
            <button disabled={loading}>{loading ? t('Checking…') : t('Verify')}</button>
          </form>
        )}

        {step === 'recovery' && (
          <form onSubmit={handleRecovery}>
            <h2>{t('Account recovery')}</h2>
            <p className="muted">{t('Enter one of your recovery codes.')}</p>
            <input
              placeholder={t('Recovery code')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              autoComplete="off"
            />
            <button disabled={loading}>{loading ? t('Checking…') : t('Recover')}</button>
            <p className="muted" style={{ marginTop: 8 }}>
              <button type="button" className="link" onClick={() => { setStep('2fa'); setPassword(''); setError(''); }}>
                {t('Back to password')}
              </button>
            </p>
          </form>
        )}

        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}
