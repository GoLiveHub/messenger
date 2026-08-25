import { useCallback, useRef, useState } from 'react';
import { CheckIcon, CloseIcon, ZoomInIcon, ZoomOutIcon } from './icons';
import { t, useLang } from '../i18n';
import { useFocusTrap, useEscapeKey } from '../hooks';

const MIN_ZOOM = 1;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.25;

interface Props {
  src: string;
  onCrop: (dataUrl: string) => void;
  onClose: () => void;
}

export function PhotoCropModal({ src, onCrop, onClose }: Props) {
  useLang();
  useEscapeKey(onClose);
  const trapRef = useFocusTrap(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startY: e.clientY, origX: offset.x, origY: offset.y };
  }, [offset]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.startX;
    const dy = e.clientY - drag.current.startY;
    setOffset({ x: drag.current.origX + dx, y: drag.current.origY + dy });
  }, []);

  const onPointerUp = useCallback(() => { drag.current = null; }, []);

  const crop = () => {
    const container = containerRef.current;
    if (!container) return;
    const size = container.clientWidth;
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d')!;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const imgAspect = img.naturalWidth / img.naturalHeight;
      let drawW: number, drawH: number;
      if (imgAspect > 1) {
        drawH = size * zoom;
        drawW = drawH * imgAspect;
      } else {
        drawW = size * zoom;
        drawH = drawW / imgAspect;
      }
      const cx = (size - drawW) / 2 + offset.x;
      const cy = (size - drawH) / 2 + offset.y;
      ctx.beginPath();
      ctx.arc(256, 256, 256, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(img, cx, cy, drawW, drawH, 0, 0, 512, 512);
      onCrop(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.src = src;
  };

  const zoomIn = () => setZoom((z) => Math.min(z + ZOOM_STEP, MAX_ZOOM));
  const zoomOut = () => setZoom((z) => Math.max(z - ZOOM_STEP, MIN_ZOOM));

  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={t('Crop photo')}>
      <div className="modal photo-crop-modal" ref={trapRef} onClick={(e) => e.stopPropagation()}>
        <button className="modal-close icon-btn" onClick={onClose} title={t('Close')}>
          <CloseIcon size={20} />
        </button>
        <h2>{t('Crop photo')}</h2>
        <div
          className="crop-viewport"
          ref={containerRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <img
            src={src}
            alt=""
            draggable={false}
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
              transformOrigin: 'center center',
            }}
          />
          <div className="crop-circle" />
        </div>
        <div className="crop-controls">
          <button className="icon-btn" onClick={zoomOut} disabled={zoom <= MIN_ZOOM} title={t('Zoom out')}>
            <ZoomOutIcon size={20} />
          </button>
          <input
            type="range"
            min={MIN_ZOOM * 100}
            max={MAX_ZOOM * 100}
            value={zoom * 100}
            onChange={(e) => setZoom(Number(e.target.value) / 100)}
          />
          <button className="icon-btn" onClick={zoomIn} disabled={zoom >= MAX_ZOOM} title={t('Zoom in')}>
            <ZoomInIcon size={20} />
          </button>
        </div>
        <div className="row-buttons">
          <button className="btn primary" onClick={crop}><CheckIcon size={16} /> {t('Save')}</button>
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
        </div>
      </div>
    </div>
  );
}
