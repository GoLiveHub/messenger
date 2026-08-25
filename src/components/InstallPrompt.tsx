import { useEffect, useState } from 'react';
import { t, useLang } from '../i18n';
import { DownloadIcon, CloseIcon } from './icons';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function InstallPrompt() {
  useLang();
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = useState(false);
  const [installed, setInstalled] = useState(
    typeof window !== 'undefined' && window.matchMedia('(display-mode: standalone)').matches,
  );

  useEffect(() => {
    if (installed) return;
    if (localStorage.getItem('install_dismissed') === '1') return;
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      setVisible(true);
    };
    const onInstalled = () => {
      setInstalled(true);
      setVisible(false);
      setDeferred(null);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, [installed]);

  if (!visible || !deferred) return null;

  const install = async () => {
    try {
      await deferred.prompt();
      const choice = await deferred.userChoice;
      if (choice.outcome === 'accepted') setInstalled(true);
    } catch { /* user dismissed or browser refused */ }
    setVisible(false);
    setDeferred(null);
  };

  return (
    <div className="install-prompt" role="dialog" aria-label={t('Install app')}>
      <DownloadIcon size={22} />
      <span className="install-prompt-text">{t('Install Messenger on your device')}</span>
      <button type="button" className="btn btn-primary btn-sm" onClick={install}>
        {t('Install')}
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label={t('Close')}
        onClick={() => {
          setVisible(false);
          setDeferred(null);
          localStorage.setItem('install_dismissed', '1');
        }}
      >
        <CloseIcon size={16} />
      </button>
    </div>
  );
}
