import { useEffect, useRef, useState } from 'react';
import type { MediaDTO } from '../api';
import { getMediaUrl } from '../media';
import { decryptFile, importFileKey } from '../crypto/e2e';

export function MediaImage({
  media,
  className,
  onClick,
  title,
  e2eFileKey,
}: {
  media: MediaDTO;
  className?: string;
  onClick?: () => void;
  title?: string;
  e2eFileKey?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [decrypting, setDecrypting] = useState(false);
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setVisible(true); observer.disconnect(); } },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    if (e2eFileKey) {
      setDecrypting(true);
      import('../api').then(({ api }) =>
        api.fetchMediaBlob(media.id).then(async (blob) => {
          if (!alive) return;
          try {
            const arrayBuf = await blob.arrayBuffer();
            const fileKey = await importFileKey(e2eFileKey);
            const decrypted = await decryptFile(arrayBuf, new ArrayBuffer(0), fileKey);
            const decBlob = new Blob([decrypted], { type: media.mime || 'application/octet-stream' });
            const objUrl = URL.createObjectURL(decBlob);
            if (alive) setUrl(objUrl);
          } catch {
            if (alive) setFailed(true);
          } finally {
            if (alive) setDecrypting(false);
          }
        })
      ).catch(() => {
        if (alive) setFailed(true);
        if (alive) setDecrypting(false);
      });
    } else {
      getMediaUrl(media.id)
        .then((u) => alive && setUrl(u))
        .catch(() => alive && setFailed(true));
    }
    return () => { alive = false; };
  }, [visible, media.id, e2eFileKey]);

  if (decrypting) {
    return <div ref={ref} className={`media-img media-img-loading ${className ?? ''}`} onClick={onClick} title={title}><span className="media-img-loading" /></div>;
  }
  if (failed) {
    return <div ref={ref} className={`media-img media-img-failed ${className ?? ''}`} onClick={onClick} title={title} />;
  }
  return (
    <div ref={ref} className={`media-img ${className ?? ''}`} onClick={onClick} title={title}>
      {url ? <img src={url} alt={media.name} loading="lazy" /> : <span className="media-img-loading" />}
    </div>
  );
}
