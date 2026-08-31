import { useEffect, useState, useRef, useCallback } from 'react';
import { api } from '../api';
import type { MediaDTO } from '../api';
import { CloseIcon, FileIcon, GlobeIcon, ImageIcon } from './icons';
import { useEscapeKey } from '../hooks';
import { formatBytes, getMediaUrl } from '../media';
import { t } from '../i18n';
import { Lightbox } from './Lightbox';

type Tab = 'photos' | 'files' | 'links';

interface LinkItem {
  message_id: number;
  sender_id: number;
  url: string;
  created_at: string;
}

function fmtTime(iso: string) {
  try {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch { return ''; }
}

export function MediaGallery({ chatId, onClose, initialMedia }: { chatId: number; onClose: () => void; initialMedia?: MediaDTO }) {
  useEscapeKey(onClose);
  const [tab, setTab] = useState<Tab>('photos');
  const [media, setMedia] = useState<MediaDTO[]>([]);
  const [links, setLinks] = useState<LinkItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [lightbox, setLightbox] = useState<MediaDTO | null>(null);
  const [urlCache, setUrlCache] = useState<Record<number, string>>({});
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const doneRef = useRef(false);

  const loadMedia = useCallback(async (before?: number) => {
    if (loadingRef.current || doneRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const items = await api.chatMedia(chatId, 50, before);
      if (items.length === 0) { doneRef.current = true; return; }
      setMedia((prev) => (before ? [...prev, ...items] : items));
      if (items.length < 50) doneRef.current = true;
    } catch { doneRef.current = true; } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }, [chatId]);

  const loadLinks = useCallback(async () => {
    if (loadingRef.current || doneRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const res = await fetch(`/api/chats/${chatId}/links?limit=50`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setLinks(data.links ?? []);
        if ((data.links ?? []).length < 50) doneRef.current = true;
      } else {
        doneRef.current = true;
      }
    } catch { doneRef.current = true; } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }, [chatId]);

  useEffect(() => {
    setMedia([]);
    setLinks([]);
    setLoading(false);
    doneRef.current = false;
    loadingRef.current = false;
    if (tab === 'photos' || tab === 'files') loadMedia();
    else loadLinks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, tab]);

  useEffect(() => {
    if (tab === 'links') return;
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && media.length > 0) {
        loadMedia(media[media.length - 1].id);
      }
    }, { rootMargin: '200px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [media, loadMedia, tab]);

  // Load blob URLs for the gallery grid via the shared, cached media pipeline.
  useEffect(() => {
    if (tab !== 'photos') return;
    for (const m of media) {
      if (urlCache[m.id]) continue;
      getMediaUrl(m.id).then((url) => {
        setUrlCache((prev) => (prev[m.id] ? prev : { ...prev, [m.id]: url }));
      }).catch(() => {});
    }
  }, [media, tab]);

  // Open the lightbox on the requested photo immediately.
  useEffect(() => {
    if (initialMedia) setLightbox(initialMedia);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const images = media.filter((m) => m.kind === 'photo');
  const files = media.filter((m) => m.kind !== 'photo');

  return (
    <div className="gallery-overlay" role="dialog" aria-modal="true" aria-label={t('Media')}>
      <div className="gallery-header">
        <div className="gallery-tabs">
          <button className={`gallery-tab${tab === 'photos' ? ' active' : ''}`} onClick={() => setTab('photos')}>
            <ImageIcon size={15} /> {t('Photos')}
          </button>
          <button className={`gallery-tab${tab === 'files' ? ' active' : ''}`} onClick={() => setTab('files')}>
            <FileIcon size={15} /> {t('Files')}
          </button>
          <button className={`gallery-tab${tab === 'links' ? ' active' : ''}`} onClick={() => setTab('links')}>
            <GlobeIcon size={15} /> {t('Links')}
          </button>
        </div>
        <button className="icon-btn" onClick={onClose}><CloseIcon size={20} /></button>
      </div>

      {tab === 'photos' && (
        <div className="gallery-grid">
          {images.map((m) => (
            <div key={m.id} className="gallery-thumb" onClick={() => setLightbox(m)}>
              {urlCache[m.id] ? <img src={urlCache[m.id]} alt={m.name} loading="lazy" /> : <span className="media-img-loading" />}
            </div>
          ))}
          {images.length > 0 && <div ref={sentinelRef} className="gallery-sentinel" />}
          {loading && <div className="gallery-loading">{t('Loading…')}</div>}
          {!loading && images.length === 0 && <div className="gallery-empty">{t('No media')}</div>}
        </div>
      )}

      {tab === 'files' && (
        <div className="gallery-file-list">
          {files.map((m) => (
            <div key={m.id} className="gallery-file-item">
              <FileIcon size={20} />
              <div className="gallery-file-info">
                <span className="gallery-file-name">{m.name}</span>
                <span className="gallery-file-meta">{formatBytes(m.size)} · {m.mime}</span>
              </div>
              <button className="icon-btn" title={t('Download')} onClick={() => getMediaUrl(m.id).then((url) => {
                const a = document.createElement('a');
                a.href = url;
                a.download = m.name || 'file';
                a.click();
              })}>
                <FileIcon size={16} />
              </button>
            </div>
          ))}
          {files.length > 0 && <div ref={sentinelRef} className="gallery-sentinel" />}
          {loading && <div className="gallery-loading">{t('Loading…')}</div>}
          {!loading && files.length === 0 && <div className="gallery-empty">{t('No files')}</div>}
        </div>
      )}

      {tab === 'links' && (
        <div className="gallery-link-list">
          {links.map((l, i) => (
            <a key={`${l.message_id}-${i}`} href={l.url} target="_blank" rel="noopener noreferrer" className="gallery-link-item">
              <GlobeIcon size={16} />
              <div className="gallery-link-info">
                <span className="gallery-link-url">{l.url.length > 80 ? l.url.slice(0, 80) + '…' : l.url}</span>
                <span className="gallery-link-date">{fmtTime(l.created_at)}</span>
              </div>
            </a>
          ))}
          {links.length > 0 && <div ref={sentinelRef} className="gallery-sentinel" />}
          {loading && <div className="gallery-loading">{t('Loading…')}</div>}
          {!loading && links.length === 0 && <div className="gallery-empty">{t('No links')}</div>}
        </div>
      )}

      {lightbox && (
        <Lightbox
          media={lightbox}
          onClose={() => {
            const closingInitial = initialMedia && lightbox.id === initialMedia.id;
            setLightbox(null);
            // If the lightbox was opened straight from the chat-details panel
            // on a specific photo, closing it should return to the chat (not
            // leave the gallery grid behind on a "grey screen").
            if (closingInitial) onClose();
          }}
        />
      )}
    </div>
  );
}
