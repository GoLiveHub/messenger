import { useEffect, useState } from 'react';
import { api, type MediaDTO } from '../api';
import { CloseIcon, DownloadIcon } from './icons';
import { getMediaUrl, downloadMedia } from '../media';
import { importFileKey, decryptFile } from '../crypto/e2e';
import { t } from '../i18n';

export function Lightbox({ media, onClose, fileKey, caption }: { media: MediaDTO; onClose: () => void; fileKey?: string; caption?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (fileKey) {
      (async () => {
        try {
          const blob = await api.fetchMediaBlob(media.id);
          const arrayBuf = await blob.arrayBuffer();
          const key = await importFileKey(fileKey);
          const decrypted = await decryptFile(arrayBuf, new ArrayBuffer(0), key);
          const decBlob = new Blob([decrypted], { type: media.mime || 'application/octet-stream' });
          if (alive) setUrl(URL.createObjectURL(decBlob));
        } catch { /* ignore */ }
      })();
    } else {
      getMediaUrl(media.id).then((u) => alive && setUrl(u)).catch(() => {});
    }
    return () => { alive = false; };
  }, [media.id, fileKey]);

  const download = () => {
    if (fileKey) {
      (async () => {
        try {
          const blob = await api.fetchMediaBlob(media.id);
          const arrayBuf = await blob.arrayBuffer();
          const key = await importFileKey(fileKey);
          const decrypted = await decryptFile(arrayBuf, new ArrayBuffer(0), key);
          const decBlob = new Blob([decrypted], { type: media.mime || 'application/octet-stream' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(decBlob);
          a.download = media.name || 'file';
          a.click();
          URL.revokeObjectURL(a.href);
        } catch { /* ignore */ }
      })();
    } else {
      void downloadMedia(media);
    }
  };

  return (
    <div className="lightbox" onClick={onClose}>
      <button className="icon-btn lightbox-close" onClick={onClose} title={t('Close')}>
        <CloseIcon size={22} />
      </button>
      <div className="lightbox-media" onClick={(e) => e.stopPropagation()}>
        {url ? <img src={url} alt={media.name} /> : <div className="lightbox-loading">{t('Loading…')}</div>}
        {caption && <div className="lightbox-caption">{caption}</div>}
      </div>
      <button className="lightbox-download icon-btn" title={t('Download')} onClick={download}>
        <DownloadIcon size={20} />
      </button>
    </div>
  );
}
