import { useEffect, useRef, useState, type ReactElement } from 'react';
import { api, type User, type Session } from '../api';
import { store } from '../store';
import { Avatar } from './Avatar';
import { currentTheme, setTheme, type ThemeName } from '../theme';
import { useFocusTrap, useEscapeKey } from '../hooks';
import { loadImage, resizeToDataUrl } from '../lib/image';
import { BirthdayPicker, formatBirthday } from './BirthdayPicker';
import { t, tx, useLang, setLang } from '../i18n';
import {
  UserIcon,
  SettingsIcon,
  BoltIcon,
  BellIcon,
  ShieldIcon,
  DatabaseIcon,
  FolderIcon,
  GlobeIcon,
  StickerIcon,
  QuestionIcon,
  MessageCircleIcon,
  BotIcon,
  InfoIcon,
  LogOutIcon,
  ChevronLeftIcon,
  PhoneIcon,
  GiftIcon,
  LockIcon,
  KeyIcon,
  CheckIcon,
  CloseIcon,
  EyeIcon,
  ImageIcon,
  UsersIcon,
  ForwardIcon,
  BanIcon,
  DownloadIcon,
  SearchIcon,
  TrashIcon,
} from './icons';
import type { PrivacyValue } from '../api';
import { clearE2EKeyCache } from '../crypto/ensureKeys';
import { clearMediaCache } from '../media';

type Tab =
  | 'profile'
  | 'appearance'
  | 'animations'
  | 'notifications'
  | 'privacy'
  | 'storage'
  | 'folders'
  | 'bots'
  | 'lang'
  | 'stickers'
  | 'questions'
  | 'about'
  | 'policy'
  | 'account';

const BASIC: Array<{ id: Tab; label: string; icon: (p: { size?: number }) => ReactElement }> = [
  { id: 'profile', label: 'My profile', icon: UserIcon },
  { id: 'appearance', label: 'Appearance', icon: SettingsIcon },
  { id: 'animations', label: 'Animations & speed', icon: BoltIcon },
  { id: 'notifications', label: 'Notifications', icon: BellIcon },
  { id: 'privacy', label: 'Confidentiality', icon: ShieldIcon },
  { id: 'storage', label: 'Data & memory', icon: DatabaseIcon },
  { id: 'folders', label: 'Chat folders', icon: FolderIcon },
  { id: 'bots', label: 'Bots & webhooks', icon: BotIcon },
  { id: 'lang', label: 'Language', icon: GlobeIcon },
  { id: 'stickers', label: 'Stickers & emoji', icon: StickerIcon },
];

const ABOUT: Array<{ id: Tab; label: string; icon: (p: { size?: number }) => ReactElement }> = [
  { id: 'questions', label: 'Ask a question', icon: QuestionIcon },
  { id: 'about', label: 'About Messenger', icon: MessageCircleIcon },
  { id: 'policy', label: 'Privacy policy', icon: InfoIcon },
];

function labelOf(item: { id: Tab; label: string }): string {
  return t(item.label);
}

export function SettingsModal({ onClose }: { onClose: () => void }) {
  useLang();
  useEscapeKey(onClose);
  const trapRef = useFocusTrap(true);
  const me = store.get().me!;
  const features = store.get().features;
  const [tab, setTab] = useState<Tab>('profile');

  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={t('Settings')}>
      <div className="modal settings-modal" ref={trapRef} onClick={(e) => e.stopPropagation()}>
        <div className="settings-sidebar">
          <button className="settings-back icon-btn" onClick={onClose} title={t('Close')}>
            <ChevronLeftIcon size={22} />
          </button>
          <div className="settings-groups">
            <div className="settings-group">
              {BASIC.filter((item) => item.id !== 'folders' || features?.folders !== false).map((item) => (
                <button key={item.id} className={`settings-nav-item${tab === item.id ? ' active' : ''}`} onClick={() => setTab(item.id)}>
                  <span className="settings-item-icon"><item.icon size={20} /></span>
                  {labelOf(item)}
                </button>
              ))}
            </div>
            <div className="settings-group">
              {ABOUT.map((item) => (
                <button key={item.id} className={`settings-nav-item${tab === item.id ? ' active' : ''}`} onClick={() => setTab(item.id)}>
                  <span className="settings-item-icon"><item.icon size={20} /></span>
                  {labelOf(item)}
                </button>
              ))}
            </div>
            <div className="settings-group">
              <button className={`settings-nav-item danger-text${tab === 'account' ? ' active' : ''}`} onClick={() => setTab('account')}>
                <span className="settings-item-icon"><LogOutIcon size={20} /></span>
                {t('Account')}
              </button>
            </div>
            {me.is_admin ? (
              <div className="settings-group">
                <button className="settings-nav-item" onClick={() => { onClose(); store.set({ adminOpen: true }); }}>
                  <span className="settings-item-icon"><ShieldIcon size={20} /></span>
                  {t('Admin panel')}
                </button>
              </div>
            ) : null}
          </div>
        </div>
        <div className="settings-panel">
          <div className="settings-panel-head">
            <h2>{labelOf([...BASIC, ...ABOUT].find((i) => i.id === tab) ?? { id: 'account', label: 'Account' })}</h2>
          </div>
          <div className="settings-panel-body">
            {tab === 'profile' && <ProfileTab me={me} />}
            {tab === 'appearance' && <AppearanceTab me={me} />}
            {tab === 'animations' && <AnimationsTab me={me} />}
            {tab === 'notifications' && <NotificationsTab me={me} />}
            {tab === 'privacy' && <PrivacyTab me={me} />}
            {tab === 'storage' && <StorageTab />}
            {tab === 'folders' && features?.folders !== false && <FoldersTab />}
            {tab === 'bots' && <BotsTab />}
            {tab === 'lang' && <LangTab me={me} />}
            {tab === 'stickers' && <StickersTab />}
            {tab === 'questions' && <QuestionsTab />}
            {tab === 'about' && <AboutTab />}
            {tab === 'policy' && <PolicyTab />}
            {tab === 'account' && <AccountTab me={me} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingsToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="session-row">
      <span>{label}</span>
      <span className={`toggle ${value ? 'on' : ''}`} onClick={() => onChange(!value)} role="switch" aria-checked={value} />
    </div>
  );
}

async function patchSettings(patch: Record<string, unknown>) {
  const me = await api.updateSettings(patch as any);
  store.set({ me });
  return me;
}

function AvatarInput({ value, onChange }: { value: string | null; onChange: (dataUrl: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const img = await loadImage(file);
      const data = resizeToDataUrl(img, 512, 0.85);
      onChange(data);
    } catch {
      // ignore bad image
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="avatar-input">
      <Avatar user={{ photo: value }} size={96} />
      <button className="mini" onClick={() => inputRef.current?.click()} disabled={busy}>
        {busy ? t('Loading…') : t('Change')}
      </button>
      {value && <button className="mini danger" onClick={() => onChange(null)}>{t('Remove')}</button>}
      <input ref={inputRef} type="file" accept="image/*" hidden onChange={handleFile} />
    </div>
  );
}

async function patchMe(patch: Record<string, unknown>) {
  const me = await api.updateProfile(patch as any);
  store.set({ me });
  return me;
}

function ProfileTab({ me }: { me: User }) {
  const [photo, setPhoto] = useState<string | null>(me.photo);
  const [first, setFirst] = useState(me.first_name);
  const [last, setLast] = useState(me.last_name);
  const [bio, setBio] = useState(me.bio);
  const [username, setUsername] = useState(me.username);
  const [birthday, setBirthday] = useState<string | null>(me.birthday);
  const [showBirthday, setShowBirthday] = useState(false);
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);
  useLang();

  const save = async () => {
    setSaving(true);
    setMsg('');
    try {
      await patchMe({ photo: photo ?? null, first_name: first, last_name: last, bio, username, birthday: birthday || null });
      setMsg(t('Saved'));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-tab">
      <AvatarInput value={photo} onChange={setPhoto} />
      <div className="form-row">
        <label>{t('First name')} <span className="required">*</span></label>
        <input value={first} onChange={(e) => setFirst(e.target.value)} placeholder={t('Required')} />
        <span className="field-hint">{t('First name is required')}</span>
      </div>
      <div className="form-row">
        <label>{t('Last name')}</label>
        <input value={last} onChange={(e) => setLast(e.target.value)} placeholder={t('Optional')} />
        <span className="field-hint">{t('Last name is optional')}</span>
      </div>
      <div className="form-row">
        <label>{t('Bio')}</label>
        <textarea value={bio} onChange={(e) => setBio(e.target.value)} />
      </div>
      <div className="form-row">
        <label>{t('Username')}</label>
        <input value={username} onChange={(e) => setUsername(e.target.value)} />
      </div>
      <div className="form-row">
        <label>{t('Birthday')}</label>
        <button className="birthday-field" onClick={() => setShowBirthday(true)}>
          <span className="birthday-field-icon"><GiftIcon size={16} /></span>
          <span className={formatBirthday(birthday) ? '' : 'muted'}>
            {formatBirthday(birthday) || t('Set birthday')}
          </span>
          {birthday && (
            <span
              className="birthday-clear"
              onClick={(e) => { e.stopPropagation(); setBirthday(null); }}
              title={t('Remove birthday')}
            >
              <CloseIcon size={14} />
            </span>
          )}
        </button>
      </div>
      <div className="row-buttons">
        <button className="mini" onClick={save} disabled={saving}>{saving ? t('Saving…') : t('Save')}</button>
        {msg && <span className="notice">{msg}</span>}
      </div>
      {showBirthday && (
        <BirthdayPicker
          value={birthday}
          onSave={(v) => { setBirthday(v); setShowBirthday(false); }}
          onRemove={() => { setBirthday(null); setShowBirthday(false); }}
          onClose={() => setShowBirthday(false)}
        />
      )}
    </div>
  );
}

function PrivacyRow({
  icon,
  title,
  desc,
  value,
  open,
  onToggle,
  onPick,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  value: PrivacyValue;
  open: boolean;
  onToggle: () => void;
  onPick: (v: PrivacyValue) => void;
}) {
  useLang();
  const valueLabel = value === 'contacts' ? t('My contacts') : value === 'nobody' ? t('Nobody') : t('Everybody');
  const options = [
    { value: 'everybody' as const, label: t('Everybody') },
    { value: 'contacts' as const, label: t('My contacts') },
    { value: 'nobody' as const, label: t('Nobody') },
  ];
  return (
    <div className={`privacy-row${open ? ' open' : ''}`}>
      <button className="privacy-row-main" onClick={onToggle}>
        <span className="settings-item-icon">{icon}</span>
        <span className="privacy-title">{title}</span>
        <span className="privacy-value">{valueLabel}</span>
      </button>
      {open && (
        <div className="privacy-picker">
          <p className="muted privacy-desc">{desc}</p>
          {options.map((o) => (
            <button key={o.value} className={`privacy-option${value === o.value ? ' active' : ''}`} onClick={() => onPick(o.value)}>
              <span>{o.label}</span>
              {value === o.value && <CheckIcon size={18} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type PrivacyKey = 'last_seen' | 'phone' | 'photo' | 'bio' | 'birthday' | 'groups' | 'forwarded' | 'find_me';

function PrivacyTab({ me }: { me: User }) {
  const [pwd, setPwd] = useState('');
  const [rec, setRec] = useState(me.recovery_email ?? '');
  const [turnOff, setTurnOff] = useState('');
  const [msg, setMsg] = useState('');
  const [with2FA, setWith2FA] = useState(me.has_2fa);
  const [blocks, setBlocks] = useState<User[]>([]);
  const [open, setOpen] = useState<PrivacyKey | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [recoveryCount, setRecoveryCount] = useState<number | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [privacy, setPrivacy] = useState<Record<PrivacyKey, PrivacyValue>>({
    last_seen: 'everybody',
    phone: 'everybody',
    photo: 'everybody',
    bio: 'everybody',
    birthday: 'everybody',
    groups: 'everybody',
    forwarded: 'everybody',
    find_me: 'everybody',
    ...(me.settings?.privacy ?? {}),
  });
  useLang();

  useEffect(() => {
    api.getBlocks().then((list) => setBlocks(list)).catch(() => {});
  }, []);

  useEffect(() => {
    if (me.has_2fa) {
      api.getRecoveryCodes().then((r) => setRecoveryCount(r.count)).catch(() => {});
    }
  }, [me.has_2fa]);

  const setPrivacyKey = async (key: PrivacyKey, v: PrivacyValue) => {
    const next = { ...privacy, [key]: v };
    setPrivacy(next);
    setMsg('');
    try {
      const updated = await api.updateSettings({ privacy: next });
      store.set({ me: updated });
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const enable2FA = async () => {
    if (pwd.length < 4) { setMsg(t('Password too short')); return; }
    try {
      const res = await api.setup2FA({ password: pwd, recovery_email: rec || undefined });
      setMsg(t('2FA enabled'));
      setWith2FA(true);
      store.set({ me: res.user });
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const changePass = async () => {
    const cur = prompt(t('Current password'));
    if (cur === null) return;
    const next = prompt(t('New password'));
    if (next === null || next.length < 4) { setMsg(t('New password too short')); return; }
    try {
      const res = await api.setup2FA({ password: next, recovery_email: rec || undefined, current_password: cur || undefined });
      setMsg(t('Password changed'));
      store.set({ me: res.user });
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const disable2FA = async () => {
    try {
      const res = await api.disable2FA(turnOff);
      setWith2FA(false);
      setMsg(t('2FA disabled'));
      store.set({ me: res.user });
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <div className="settings-tab">
      <h4><ShieldIcon size={18} /> {t('Confidentiality')}</h4>
      <div className="privacy-section">
        <PrivacyRow
          icon={<EyeIcon size={20} />}
          title={t('Last seen & online')}
          desc={t('Who can see when you are online and when you were last seen.')}
          value={privacy.last_seen}
          open={open === 'last_seen'}
          onToggle={() => setOpen(open === 'last_seen' ? null : 'last_seen')}
          onPick={(v) => setPrivacyKey('last_seen', v)}
        />
        <PrivacyRow
          icon={<PhoneIcon size={20} />}
          title={t('Phone number')}
          desc={t('Who can see your phone number.')}
          value={privacy.phone}
          open={open === 'phone'}
          onToggle={() => setOpen(open === 'phone' ? null : 'phone')}
          onPick={(v) => setPrivacyKey('phone', v)}
        />
        <PrivacyRow
          icon={<ImageIcon size={20} />}
          title={t('Profile photo')}
          desc={t('Who can see your profile photo.')}
          value={privacy.photo}
          open={open === 'photo'}
          onToggle={() => setOpen(open === 'photo' ? null : 'photo')}
          onPick={(v) => setPrivacyKey('photo', v)}
        />
        <PrivacyRow
          icon={<InfoIcon size={20} />}
          title={t('Bio')}
          desc={t('Who can see your bio.')}
          value={privacy.bio}
          open={open === 'bio'}
          onToggle={() => setOpen(open === 'bio' ? null : 'bio')}
          onPick={(v) => setPrivacyKey('bio', v)}
        />
        <PrivacyRow
          icon={<UsersIcon size={20} />}
          title={t('Add me to groups')}
          desc={t('Who can add you to groups and channels.')}
          value={privacy.groups}
          open={open === 'groups'}
          onToggle={() => setOpen(open === 'groups' ? null : 'groups')}
          onPick={(v) => setPrivacyKey('groups', v)}
        />
        <PrivacyRow
          icon={<ForwardIcon size={20} />}
          title={t('Forwarded messages')}
          desc={t('Who can forward your messages.')}
          value={privacy.forwarded}
          open={open === 'forwarded'}
          onToggle={() => setOpen(open === 'forwarded' ? null : 'forwarded')}
          onPick={(v) => setPrivacyKey('forwarded', v)}
        />
        <PrivacyRow
          icon={<GiftIcon size={20} />}
          title={t('Birthday')}
          desc={t('Who can see your birthday.')}
          value={privacy.birthday}
          open={open === 'birthday'}
          onToggle={() => setOpen(open === 'birthday' ? null : 'birthday')}
          onPick={(v) => setPrivacyKey('birthday', v)}
        />
        <PrivacyRow
          icon={<SearchIcon size={20} />}
          title={t('Who can find me')}
          desc={t('Who can find you by phone number or username.')}
          value={privacy.find_me}
          open={open === 'find_me'}
          onToggle={() => setOpen(open === 'find_me' ? null : 'find_me')}
          onPick={(v) => setPrivacyKey('find_me', v)}
        />
      </div>
      {msg && <div className="notice">{msg}</div>}

      <h4><LockIcon size={18} /> {t('Password protection')}</h4>
      {with2FA ? (
        <>
          <div className="notice">{t('2FA is enabled')}</div>
          <button className="mini" onClick={changePass}>{t('Change password')}</button>
          <input placeholder={t('Password to disable')} value={turnOff} onChange={(e) => setTurnOff(e.target.value)} />
          <button className="mini danger" onClick={disable2FA}>{t('Disable 2FA')}</button>
        </>
      ) : (
        <>
          <input placeholder={t('New 2FA password (min 4)')} type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} />
          <input placeholder={t('Recovery email (optional)')} value={rec} onChange={(e) => setRec(e.target.value)} />
          <button className="mini" onClick={enable2FA}>{t('Enable 2FA')}</button>
        </>
      )}

      <h4><KeyIcon size={18} /> {t('Recovery codes')}</h4>
      {recoveryCodes ? (
        <div className="recovery-codes-box">
          <p className="muted">{t('Recovery codes shown once. Save them now.')}</p>
          <div className="recovery-codes-list">
            {recoveryCodes.map((c, i) => (
              <code key={i} className="recovery-code">{c}</code>
            ))}
          </div>
          <div className="row-buttons">
            <button className="mini" onClick={() => {
              navigator.clipboard.writeText(recoveryCodes.join('\n')).then(() => setMsg(t('Copied!'))).catch(() => {});
            }}>{t('Copy')}</button>
            <button className="mini" onClick={() => {
              const blob = new Blob([recoveryCodes.join('\n')], { type: 'text/plain' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url; a.download = 'messenger-recovery-codes.txt'; a.click();
              URL.revokeObjectURL(url);
            }}>{t('Download')}</button>
          </div>
          <button className="mini" onClick={() => setRecoveryCodes(null)}>{t('Close')}</button>
        </div>
      ) : (
        <>
          {recoveryCount !== null && (
            <p className="muted">{tx('Remaining recovery codes: {n}', { n: recoveryCount })}</p>
          )}
          <button className="mini" onClick={async () => {
            setRegenerating(true);
            try {
              const res = await api.regenerateRecoveryCodes(me.has_2fa ? pwd || undefined : undefined);
              setRecoveryCodes(res.codes);
              setRecoveryCount(res.codes.length);
            } catch (e) {
              setMsg((e as Error).message);
            } finally {
              setRegenerating(false);
            }
          }} disabled={regenerating}>{regenerating ? t('Generating…') : t('Generate recovery codes')}</button>
        </>
      )}
      <h4><KeyIcon size={18} /> {t('Active sessions')}</h4>
      <SessionsList />
      <h4><BanIcon size={18} /> {t('Blocked users')}</h4>
      {blocks.length ? (
        blocks.map((u) => (
          <div className="session-row" key={u.id}>
            <Avatar user={u} size={36} />
            <div className="session-info">
              <b>{[u.first_name, u.last_name].filter(Boolean).join(' ')}</b>
              <span className="muted">@{u.username}</span>
            </div>
            <button
              className="mini"
              onClick={async () => {
                await api.removeBlock(u.id);
                setBlocks(blocks.filter((x) => x.id !== u.id));
              }}
            >
              {t('Unblock')}
            </button>
          </div>
        ))
      ) : (
        <div className="muted">{t('No blocked users')}</div>
      )}
    </div>
  );
}

function SessionsList() {
  useLang();
  const [sessions, setSessions] = useState<Session[]>([]);
  useEffect(() => {
    api.getSessions().then(setSessions).catch(() => {});
  }, []);
  return (
    <div>
      {sessions.map((s) => (
        <div className="session-row" key={s.id}>
          <Avatar user={{ first_name: s.label || t('Device') }} size={36} />
          <div className="session-info">
            <b>{s.label || t('Unknown device')}</b>
            <span className="muted">{s.current ? t('this device') : s.last_seen_at || t('never')}</span>
          </div>
          {!s.current && (
            <button
              className="mini danger"
              onClick={async () => {
                await api.terminateSession(s.id);
                setSessions(sessions.filter((x) => x.id !== s.id));
              }}
            >
              {t('Terminate')}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function NotificationsTab({ me }: { me: User }) {
  const n = me.settings.notifications ?? { enabled: true, sound: true };
  const [enabled, setEnabled] = useState(n.enabled);
  const [sound, setSound] = useState(n.sound);
  const [qhStart, setQhStart] = useState(me.quiet_hours_start ?? '');
  const [qhEnd, setQhEnd] = useState(me.quiet_hours_end ?? '');
  useLang();

  const toggle = async (patch: Partial<{ enabled: boolean; sound: boolean }>) => {
    const next = { enabled, sound, ...patch };
    setEnabled(next.enabled);
    setSound(next.sound);
    await patchSettings({ notifications: next });
  };

  const saveQuietHours = async () => {
    const s = qhStart || null;
    const e = qhEnd || null;
    if ((s && !e) || (!s && e)) return;
    try {
      await api.setQuietHours(s, e);
    } catch { /* ignore */ }
  };

  return (
    <div className="settings-tab">
      <h4>{t('Notifications')}</h4>
      <SettingsToggleRow label={t('Enable notifications')} value={enabled} onChange={(v) => toggle({ enabled: v })} />
      <SettingsToggleRow label={t('Sound')} value={sound} onChange={(v) => toggle({ sound: v })} />
      <div style={{ marginTop: '1rem' }}>
        <b style={{ fontSize: '0.85rem' }}>{t('Quiet hours')}</b>
        <p className="muted" style={{ fontSize: '0.8rem', margin: '4px 0 8px' }}>{t('No notifications during this time')}</p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="time" value={qhStart} onChange={(e) => setQhStart(e.target.value)} style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }} />
          <span className="muted">—</span>
          <input type="time" value={qhEnd} onChange={(e) => setQhEnd(e.target.value)} style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }} />
          <button className="btn mini" onClick={() => void saveQuietHours()}>{t('Save')}</button>
        </div>
      </div>
    </div>
  );
}

function AppearanceTab({ me }: { me: User }) {
  const theme = me.settings.theme ?? currentTheme();
  useLang();
  const apply = async (t: ThemeName) => {
    const updated = await api.updateSettings({ theme: t });
    setTheme(t);
    store.set({ me: updated });
  };
  return (
    <div className="settings-tab">
      <h4>{t('Appearance')}</h4>
      <SettingsToggleRow label={t('Dark mode')} value={theme === 'dark'} onChange={(v) => apply(v ? 'dark' : 'light')} />
    </div>
  );
}

function AnimationsTab({ me }: { me: User }) {
  const animations = me.settings.animations !== false;
  const effects = me.settings.effects !== false;
  const [highContrast, setHighContrast] = useState(() => {
    try { return document.documentElement.getAttribute('data-contrast') === 'high'; } catch { return false; }
  });
  const [reducedMotion, setReducedMotion] = useState(() => {
    try { return document.documentElement.classList.contains('no-effects'); } catch { return false; }
  });
  useLang();

  const setAnimations = async (v: boolean) => {
    const updated = await patchSettings({ animations: v });
    document.body.classList.toggle('no-animations', !v);
    store.set({ me: updated });
  };
  const setEffects = async (v: boolean) => {
    const updated = await patchSettings({ effects: v });
    document.body.classList.toggle('no-effects', !v);
    store.set({ me: updated });
  };

  const toggleHighContrast = (v: boolean) => {
    setHighContrast(v);
    document.documentElement.setAttribute('data-contrast', v ? 'high' : 'normal');
    try { localStorage.setItem('highContrast', v ? '1' : '0'); } catch { /* ignore */ }
  };

  const toggleReducedMotion = (v: boolean) => {
    setReducedMotion(v);
    document.body.classList.toggle('no-effects', v);
    try { localStorage.setItem('reducedMotion', v ? '1' : '0'); } catch { /* ignore */ }
  };

  return (
    <div className="settings-tab">
      <h4>{t('Animations & speed')}</h4>
      <SettingsToggleRow label={t('Animations')} value={animations} onChange={setAnimations} />
      <SettingsToggleRow label={t('Interface effects')} value={effects} onChange={setEffects} />
      <p className="muted hint">{t('Turning animations off reduces motion; effects control decorative visual effects.')}</p>
      <SettingsToggleRow label={t('High contrast')} value={highContrast} onChange={toggleHighContrast} />
      <SettingsToggleRow label={t('Reduce motion')} value={reducedMotion} onChange={toggleReducedMotion} />
    </div>
  );
}

const LANGS = [
  { code: 'en', name: 'English' },
  { code: 'ru', name: 'Русский' },
];

function LangTab({ me }: { me: User }) {
  const [lang, setLangState] = useState(me.settings.lang ?? 'en');
  const [rtl, setRtl] = useState(me.settings.rtl ?? false);
  const [msg, setMsg] = useState('');
  useLang();
  const set = async (code: string) => {
    setLangState(code);
    setMsg('');
    try {
      await patchSettings({ lang: code });
      setLang(code);
      setMsg(t('Saved'));
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const toggleRtl = async () => {
    const next = !rtl;
    setRtl(next);
    document.documentElement.dir = next ? 'rtl' : 'ltr';
    try {
      await patchSettings({ rtl: next });
      setMsg(t('Saved'));
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <div className="settings-tab">
      <h4><GlobeIcon size={18} /> {t('Language')}</h4>
      {LANGS.map((l) => (
        <div className="session-row clickable" key={l.code} onClick={() => set(l.code)}>
          <span>{l.name}</span>
          {lang === l.code ? <CheckIcon size={18} className="checked" /> : null}
        </div>
      ))}
      <div className="session-row clickable" onClick={toggleRtl}>
        <span>{t('Right-to-left (RTL)')}</span>
        <span className={`toggle ${rtl ? 'on' : ''}`} />
      </div>
      {msg && <div className="notice">{msg}</div>}
    </div>
  );
}

function StorageTab() {
  useLang();
  const chats = store.get().chats;
  const [exporting, setExporting] = useState(false);

  const exportAll = async () => {
    setExporting(true);
    try {
      const all = [];
      for (const c of chats) {
        const msgs = await api.getMessages(c.chat.id);
        const out = [];
        for (const m of msgs) out.push(m.text ?? '[encrypted]');
        all.push({ chat: c.peer?.username ?? c.chat.title ?? c.chat.id, type: c.chat.kind, messages: out });
      }
      const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'messenger-export.json';
      a.click();
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="settings-tab">
      <h4>{t('Data & storage')}</h4>
      <div className="session-row">
        <span>{tx('chats_loaded', { n: store.get().messages ? Object.keys(store.get().messages).length : 0 })}</span>
      </div>
      <button className="mini" onClick={exportAll} disabled={exporting}>
        {exporting ? t('Exporting…') : t('Export all chats (JSON)')}
      </button>
    </div>
  );
}

function FoldersTab() {
  useLang();
  const [folders, setFolders] = useState<Array<{ id: number; name: string; emoji: string | null; chat_ids: number[]; sort_order: number }>>([]);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<Record<string, number[]>>({});

  const FILTER_CRITERIA = [
    { key: 'unread', label: 'Unread only' },
    { key: 'non_muted', label: 'Non-muted only' },
    { key: 'has_media', label: 'Has media' },
    { key: 'has_links', label: 'Has links' },
  ];

  useEffect(() => {
    api.getFolders().then(setFolders).catch(() => {}).finally(() => setLoading(false));
    api.getFolderFilters().then(setFilters).catch(() => {});
  }, []);

  const addFolder = async () => {
    if (!newName.trim()) return;
    try {
      const res = await api.createFolder(newName.trim());
      setFolders((f) => [...f, { id: res.id, name: newName.trim(), emoji: null, chat_ids: [], sort_order: f.length }]);
      setNewName('');
    } catch { /* ignore */ }
  };

  const saveEdit = async (id: number) => {
    if (!editName.trim()) return;
    try {
      await api.updateFolder(id, { name: editName.trim() });
      setFolders((f) => f.map((fo) => fo.id === id ? { ...fo, name: editName.trim() } : fo));
      setEditingId(null);
    } catch { /* ignore */ }
  };

  const deleteFolder = async (id: number) => {
    try {
      await api.deleteFolder(id);
      setFolders((f) => f.filter((fo) => fo.id !== id));
    } catch { /* ignore */ }
  };

  if (loading) return <div className="settings-tab"><h4>{t('Chat folders')}</h4><p className="muted">{t('Loading…')}</p></div>;

  return (
    <div className="settings-tab">
      <h4>{t('Chat folders')}</h4>
      {folders.length === 0 && <p className="muted hint">{t('Create folders to organize your chats.')}</p>}
      <div className="folder-list">
        {folders.map((f) => (
          <div key={f.id} className="folder-row">
            {editingId === f.id ? (
              <input className="folder-name-input" value={editName} onChange={(e) => setEditName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(f.id); if (e.key === 'Escape') setEditingId(null); }} autoFocus />
            ) : (
              <span className="folder-name">{f.emoji ? `${f.emoji} ` : ''}{f.name}</span>
            )}
            <span className="folder-count muted">{f.chat_ids.length}</span>
            <div className="folder-actions">
              {editingId === f.id ? (
                <button className="mini" onClick={() => saveEdit(f.id)}>{t('Save')}</button>
              ) : (
                <button className="mini" onClick={() => { setEditingId(f.id); setEditName(f.name); }}>{t('Edit')}</button>
              )}
              <button className="mini danger-text" onClick={() => { if (confirm(t('Delete folder?'))) deleteFolder(f.id); }}>{t('Delete')}</button>
            </div>
          </div>
        ))}
      </div>
      <div className="folder-add">
        <input placeholder={t('Folder name')} value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addFolder(); }} />
        <button className="mini" onClick={addFolder} disabled={!newName.trim()}>{t('Add')}</button>
      </div>
      {folders.length > 0 && (
        <div className="folder-filters" style={{ marginTop: '1rem', borderTop: '1px solid var(--border, #ccc)', paddingTop: '0.75rem' }}>
          <h5>{t('Custom filters')}</h5>
          <p className="muted hint" style={{ fontSize: 12, marginBottom: '0.5rem' }}>{t('Apply filters to automatically include chats in folders.')}</p>
          {FILTER_CRITERIA.map((fc) => (
            <label key={fc.key} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.25rem 0', fontSize: 14 }}>
              <input
                type="checkbox"
                checked={filters[fc.key]?.length > 0}
                onChange={async (e) => {
                  const updated = { ...filters };
                  if (e.target.checked) updated[fc.key] = folders.map((f) => f.id);
                  else delete updated[fc.key];
                  setFilters(updated);
                  try { await api.setFolderFilters(updated); } catch { /* ignore */ }
                }}
              />
              {t(fc.label)}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function StickersTab() {
  useLang();
  return (
    <div className="settings-tab">
      <h4>{t('Stickers & emoji')}</h4>
      <p className="muted hint">{t('Stickers and emoji are available in every chat. More packs coming soon.')}</p>
    </div>
  );
}

function QuestionsTab() {
  useLang();
  return (
    <div className="settings-tab">
      <h4>{t('Ask a question')}</h4>
      <p className="muted hint">{t('Common questions about Messenger:')}</p>
      <ul className="faq-list">
        <li><b>{t('Is my data private?')}</b> — {t('q1_a')}</li>
        <li><b>{t('How do I set a password?')}</b> — {t('q2_a')}</li>
        <li><b>{t('How do I export data?')}</b> — {t('q3_a')}</li>
      </ul>
    </div>
  );
}

function AboutTab() {
  useLang();
  return (
    <div className="settings-tab">
      <h4>{t('About Messenger')}</h4>
      <div className="about-card">
        <b>Messenger</b>
        <span className="muted">{t('Fast, private and reliable messaging.')}</span>
        <span className="muted">{t('Version 1.0.0')}</span>
      </div>
    </div>
  );
}

function PolicyTab() {
  useLang();
  return (
    <div className="settings-tab">
      <h4>{t('Privacy policy')}</h4>
      <p className="muted hint">{t('policy_text')}</p>
    </div>
  );
}

function AccountTab({ me }: { me: User }) {
  const [pwd, setPwd] = useState('');
  const [msg, setMsg] = useState('');
  const [changingPhone, setChangingPhone] = useState(false);
  const [newPhone, setNewPhone] = useState('');
  const [phoneStep, setPhoneStep] = useState<'idle' | 'code'>('idle');
  const [phoneCode, setPhoneCode] = useState('');
  const [phoneLoading, setPhoneLoading] = useState(false);
  useLang();

  const logoutAndClear = async () => {
    try {
      await api.logout();
    } catch {
      // Ignore errors — we clear local state regardless
    }
    clearE2EKeyCache(me.id);
    clearMediaCache();
    store.set({ me: null, chats: [], messages: {}, activeChatId: null, online: {}, typing: {} });
  };

  const del = async () => {
    const ask = confirm(t('Delete account permanently?'));
    if (!ask) return;
    try {
      await api.deleteAccount(pwd || undefined);
      logoutAndClear();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <div className="settings-tab">
      <h4>{t('Account')}</h4>
      <div className="session-row"><PhoneIcon size={16} /><span>{me.phone}</span>
        {!changingPhone && (
          <button className="mini" onClick={() => setChangingPhone(true)}>{t('Change')}</button>
        )}
      </div>
      {changingPhone && (
        <div className="phone-change-box">
          {phoneStep === 'idle' ? (
            <>
              <input placeholder={t('New phone number')} value={newPhone} onChange={(e) => setNewPhone(e.target.value)} />
              {me.has_2fa && <input type="password" placeholder={t('Password')} value={pwd} onChange={(e) => setPwd(e.target.value)} />}
              <div className="row-buttons">
                <button className="mini" onClick={async () => {
                  setPhoneLoading(true); setMsg('');
                  try {
                    await api.requestPhoneChange(newPhone, me.has_2fa ? pwd || undefined : undefined);
                    setPhoneStep('code');
                  } catch (e) { setMsg((e as Error).message); } finally { setPhoneLoading(false); }
                }} disabled={phoneLoading || !newPhone.trim()}>{phoneLoading ? t('Sending…') : t('Send code')}</button>
                <button className="mini" onClick={() => { setChangingPhone(false); setNewPhone(''); setPhoneStep('idle'); }}>{t('Cancel')}</button>
              </div>
            </>
          ) : (
            <>
              <p className="muted">{t('Code sent to')} {newPhone}</p>
              <input placeholder={t('Code')} value={phoneCode} onChange={(e) => setPhoneCode(e.target.value)} autoFocus />
              <div className="row-buttons">
                <button className="mini" onClick={async () => {
                  setPhoneLoading(true); setMsg('');
                  try {
                    const res = await api.confirmPhoneChange(phoneCode);
                    store.set({ me: res.user });
                    setChangingPhone(false); setNewPhone(''); setPhoneStep('idle'); setPhoneCode('');
                    setMsg(t('Phone number changed'));
                  } catch (e) { setMsg((e as Error).message); } finally { setPhoneLoading(false); }
                }} disabled={phoneLoading || !phoneCode.trim()}>{phoneLoading ? t('Checking…') : t('Confirm')}</button>
                <button className="mini" onClick={() => { setPhoneStep('idle'); setPhoneCode(''); }}>{t('Back')}</button>
              </div>
            </>
          )}
        </div>
      )}
      {me.birthday && <div className="session-row"><GiftIcon size={16} /><span>{formatBirthday(me.birthday)}</span></div>}
      <div className="row-buttons">
        <button className="mini" onClick={async () => {
          try {
            const data = await api.exportAccount();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = `messenger-export-${new Date().toISOString().slice(0, 10)}.json`; a.click();
            URL.revokeObjectURL(url);
            setMsg(t('Export downloaded'));
          } catch (e) { setMsg((e as Error).message); }
        }}><DownloadIcon size={16} /> {t('Export data')}</button>
        <button className="mini" onClick={logoutAndClear}>
          <LogOutIcon size={16} /> {t('Log out')}
        </button>
      </div>
      <input type="password" placeholder={t('Password (if 2FA)')} value={pwd} onChange={(e) => setPwd(e.target.value)} />
      <button className="mini danger" onClick={del}>{t('Delete account')}</button>
      {msg && <div className="notice">{msg}</div>}
    </div>
  );
}

function BotsTab() {
  useLang();
  const [bots, setBots] = useState<Array<{ id: number; name: string; description: string; webhook_url: string; is_active: number; created_at: string; bot_user_id: number; username: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [newBotToken, setNewBotToken] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getBots().then(setBots).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const createBot = async () => {
    if (!name.trim()) return;
    setError('');
    try {
      const res = await api.createBot(name.trim(), description.trim(), webhookUrl.trim());
      setBots((prev) => [{ id: res.id, name: res.name, description: res.description, webhook_url: res.webhook_url, is_active: 1, created_at: new Date().toISOString(), bot_user_id: res.bot_user_id, username: res.username }, ...prev]);
      setNewBotToken(res.token);
      setName('');
      setDescription('');
      setWebhookUrl('');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const deleteBot = async (id: number) => {
    if (!confirm(t('Delete this bot?'))) return;
    try {
      await api.deleteBot(id);
      setBots((prev) => prev.filter((b) => b.id !== id));
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const updateWebhook = async (id: number, url: string) => {
    try {
      await api.setBotWebhook(id, url);
      setBots((prev) => prev.map((b) => b.id === id ? { ...b, webhook_url: url } : b));
    } catch (e) {
      alert((e as Error).message);
    }
  };

  if (loading) return <div className="settings-tab"><h4>{t('Bots & webhooks')}</h4><p className="muted">{t('Loading…')}</p></div>;

  return (
    <div className="settings-tab">
      <h4>{t('Bots & webhooks')}</h4>
      {newBotToken && (
        <div className="notice" style={{ marginBottom: 12 }}>
          <b>{t('Bot token')}:</b> <code>{newBotToken}</code>
          <button className="mini" style={{ marginLeft: 8 }} onClick={() => {
            navigator.clipboard.writeText(newBotToken).catch(() => {});
          }}>{t('Copy')}</button>
          <button className="mini" style={{ marginLeft: 4 }} onClick={() => setNewBotToken(null)}>✕</button>
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
        <input placeholder={t('Bot name')} value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder={t('Description')} value={description} onChange={(e) => setDescription(e.target.value)} />
        <input placeholder={t('Webhook URL (optional)')} value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} />
        <button className="btn primary" onClick={createBot} disabled={!name.trim()}>{t('Create bot')}</button>
        {error && <div className="notice error">{error}</div>}
      </div>
      {bots.length === 0 ? (
        <p className="muted">{t('No bots yet.')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {bots.map((bot) => (
            <div key={bot.id} className="settings-section" style={{ padding: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <b>{bot.name}</b> <span className="muted">@{bot.username}</span>
                </div>
                <button className="icon-btn danger" title={t('Delete')} onClick={() => deleteBot(bot.id)}>
                  <TrashIcon size={14} />
                </button>
              </div>
              {bot.description && <p className="muted" style={{ margin: '4px 0', fontSize: 13 }}>{bot.description}</p>}
              <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 6 }}>
                <input
                  style={{ flex: 1 }}
                  placeholder={t('Webhook URL')}
                  defaultValue={bot.webhook_url}
                  onBlur={(e) => updateWebhook(bot.id, e.target.value)}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
