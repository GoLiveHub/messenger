import { LockIcon, ShieldIcon, DeviceIcon, FolderIcon, StickerIcon, DatabaseIcon, CloseIcon } from './icons';
import { t, useLang } from '../i18n';
import { useFocusTrap, useEscapeKey } from '../hooks';
import { store } from '../store';

function features() {
  const f = store.get().features;
  const items = [
    { icon: LockIcon, title: t('Password protection_title'), text: t('Password protection_text') },
    { icon: ShieldIcon, title: t('Secret chats_title'), text: t('Secret chats_text') },
    { icon: DeviceIcon, title: t('Active sessions_title'), text: t('Active sessions_text') },
    { icon: FolderIcon, title: t('Chat folders_title'), text: t('Chat folders_text') },
    { icon: StickerIcon, title: t('Stickers and emoji_title'), text: t('Stickers and emoji_text') },
    { icon: DatabaseIcon, title: t('Data export_title'), text: t('Data export_text') },
  ];
  return items.filter((item) => {
    if (item.title === t('Secret chats_title') && f?.e2eSecretChats === false) return false;
    if (item.title === t('Chat folders_title') && f?.folders === false) return false;
    return true;
  });
}

export function InfoModal({ onClose }: { onClose: () => void }) {
  useLang();
  useEscapeKey(onClose);
  const trapRef = useFocusTrap(true);
  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={t('Messenger features')}>
      <div className="modal info-modal" ref={trapRef} onClick={(e) => e.stopPropagation()}>
        <button className="modal-close icon-btn" onClick={onClose} title={t('Close')}>
          <CloseIcon size={20} />
        </button>
        <h2>{t('Messenger features')}</h2>
        <div className="info-feature-list">
          {features().map((f) => (
            <div className="info-feature" key={f.title}>
              <span className="info-feature-icon"><f.icon size={22} /></span>
              <div className="info-feature-body">
                <b>{f.title}</b>
                <span>{f.text}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
