import { useRef, useEffect, useState } from 'react';
import { t } from '../i18n';
import { api } from '../api';
import { getMediaUrl } from '../media';
import type { MediaDTO } from '../api';

const EMOJIS = [
  '😀', '😁', '😂', '🤣', '😊', '😍', '😘', '😉', '😎', '🤩',
  '🥳', '😜', '🤪', '🤗', '🤔', '😐', '😴', '🥱', '😭', '😢',
  '😅', '😱', '😳', '😡', '🤯', '😇', '🙃', '😌', '🤓', '🥰',
  '🙂', '🙁', '😬', '😷', '🤒', '🥴', '🤤', '😋', '🤑', '🤠',
  '👍', '👎', '👏', '🙌', '👊', '✊', '🤝', '🙏', '💪', '✌️',
  '🤞', '🖐️', '👌', '🤌', '💅', '👀', '👃', '👂', '👄', '👅',
  '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💔', '💖',
  '💗', '💓', '💕', '💯', '💢', '💥', '🔥', '✨', '🌟', '⭐',
  '🎉', '🎊', '🎈', '🎁', '🎂', '🍀', '🌈', '☀️', '🌙', '☁️',
  '⚡', '❄️', '💧', '🔥', '🍎', '🍌', '🍉', '🍇', '🍓', '🍕',
  '🍔', '🍟', '🌮', '🍜', '🍣', '🍰', '☕', '🍺', '🍷', '🥂',
  '⚽', '🏀', '🏈', '🎾', '🎱', '🏆', '🥇', '🚗', '🚀', '✈️',
  '🏠', '🏝️', '⛰️', '🌊', '🐶', '🐱', '🐭', '🐹', '🦊', '🐻',
  '🐼', '🐨', '🐸', '🐵', '🦁', '🐮', '🐷', '🐔', '🐧', '🦄',
  '😺', '😸', '😹', '😻', '😽', '🙀', '😿', '😾', '💀', '👻',
  '🤡', '👽', '🤖', '🎃', '👻', '💩', '🙈', '🙉', '🙊', '🐒',
];

const QUICK = ['❤️', '👍', '👏', '😮', '😂', '😢', '🙏', '🔥', '😍'];

// Animated emoji: each entry gets a looping CSS animation (see .emoji-animated-*)
const ANIMATED: Array<{ emoji: string; anim: string; label: string }> = [
  { emoji: '❤️', anim: 'beat', label: 'Beating heart' },
  { emoji: '💖', anim: 'beat', label: 'Sparkling heart' },
  { emoji: '💥', anim: 'boom', label: 'Collision' },
  { emoji: '🔥', anim: 'flicker', label: 'Fire' },
  { emoji: '✨', anim: 'twinkle', label: 'Sparkles' },
  { emoji: '⭐', anim: 'twinkle', label: 'Star' },
  { emoji: '🌟', anim: 'spin-slow', label: 'Glowing star' },
  { emoji: '💫', anim: 'spin-slow', label: 'Dizzy' },
  { emoji: '😀', anim: 'bounce', label: 'Grinning face' },
  { emoji: '😂', anim: 'shake', label: 'Laughing face' },
  { emoji: '🥳', anim: 'bounce', label: 'Party face' },
  { emoji: '😎', anim: 'tilt', label: 'Cool face' },
  { emoji: '🤩', anim: 'pulse', label: 'Star-struck' },
  { emoji: '😍', anim: 'pulse', label: 'In love' },
  { emoji: '😜', anim: 'tilt', label: 'Winking tongue' },
  { emoji: '👀', anim: 'look-around', label: 'Eyes' },
  { emoji: '👍', anim: 'nudge', label: 'Thumbs up' },
  { emoji: '👎', anim: 'nudge-down', label: 'Thumbs down' },
  { emoji: '👏', anim: 'clap', label: 'Clap' },
  { emoji: '🙌', anim: 'raise', label: 'Raising hands' },
  { emoji: '🎉', anim: 'confetti-pop', label: 'Party popper' },
  { emoji: '🎊', anim: 'confetti-pop', label: 'Confetti ball' },
  { emoji: '🎈', anim: 'float', label: 'Balloon' },
  { emoji: '⚡', anim: 'flash', label: 'Lightning' },
];

type Tab = 'emoji' | 'stickers' | 'gifs' | 'animated';

export function EmojiPicker({ onPick, onStickerPick, onGifPick }: { onPick: (emoji: string) => void; onStickerPick?: (sticker: { id: number; pack_id: number; file_id: number; emoji: string }) => void; onGifPick?: (gif: { id: string; url: string; preview: string }) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab>('emoji');
  const [packs, setPacks] = useState<Array<{ id: number; name: string; emoji: string | null; thumbnail: string | null }>>([]);
  const [selectedPack, setSelectedPack] = useState<number | null>(null);
  const [stickers, setStickers] = useState<Array<{ id: number; pack_id: number; file_id: number; emoji: string }>>([]);
  const [gifQuery, setGifQuery] = useState('');
  const [gifs, setGifs] = useState<Array<{ id: string; url: string; preview: string; width: number; height: number }>>([]);
  const [gifLoading, setGifLoading] = useState(false);

  useEffect(() => {
    api.getStickerPacks().then(setPacks).catch(() => {});
  }, []);

  useEffect(() => {
    if (selectedPack) {
      api.getStickerPackStickers(selectedPack).then(setStickers).catch(() => {});
    }
  }, [selectedPack]);

  useEffect(() => {
    setGifLoading(true);
    const timer = setTimeout(() => {
      api.searchGifs(gifQuery).then(setGifs).finally(() => setGifLoading(false)).catch(() => setGifLoading(false));
    }, 400);
    return () => clearTimeout(timer);
  }, [gifQuery]);

  return (
    <div className="emoji-picker" ref={ref} onClick={(e) => e.stopPropagation()}>
      <div className="emoji-tabs">
        <button className={`emoji-tab${tab === 'emoji' ? ' active' : ''}`} onClick={() => setTab('emoji')}>😀</button>
        <button className={`emoji-tab${tab === 'animated' ? ' active' : ''}`} onClick={() => setTab('animated')} title={t('Animated emoji')}>
          <span className="emoji-animated-anim beat">❤️</span>
        </button>
        <button className={`emoji-tab${tab === 'stickers' ? ' active' : ''}`} onClick={() => setTab('stickers')}>🎨</button>
        {onGifPick && <button className={`emoji-tab${tab === 'gifs' ? ' active' : ''}`} onClick={() => setTab('gifs')}>GIF</button>}
      </div>
      {tab === 'emoji' && (
        <>
          <div className="emoji-quick">
            {QUICK.map((e) => (
              <button key={e} className="emoji-cell" onClick={() => onPick(e)} title={t('React')}>
                {e}
              </button>
            ))}
          </div>
          <div className="emoji-grid">
            {EMOJIS.map((e) => (
              <button key={e} className="emoji-cell" onClick={() => onPick(e)}>
                {e}
              </button>
            ))}
          </div>
        </>
      )}
      {tab === 'animated' && (
        <div className="emoji-grid">
          {ANIMATED.map((item) => (
            <button
              key={item.anim + item.emoji}
              className={`emoji-cell emoji-animated emoji-animated-${item.anim}`}
              onClick={() => onPick(item.emoji)}
              title={t(item.label)}
            >
              <span>{item.emoji}</span>
            </button>
          ))}
        </div>
      )}
      {tab === 'stickers' && (
        <>
          {!selectedPack && (
            <div className="sticker-pack-list">
              {packs.length === 0 && <div className="muted" style={{ padding: 12 }}>{t('No sticker packs')}</div>}
              {packs.map((p) => (
                <button key={p.id} className="sticker-pack-row" onClick={() => setSelectedPack(p.id)}>
                  <span className="sticker-pack-emoji">{p.emoji ?? '🎨'}</span>
                  <span>{p.name}</span>
                </button>
              ))}
            </div>
          )}
          {selectedPack && (
            <>
              <button className="mini" onClick={() => { setSelectedPack(null); setStickers([]); }} style={{ margin: 6 }}>← {t('Back')}</button>
              <div className="sticker-grid">
                {stickers.map((s) => (
                  <StickerThumb key={s.id} sticker={s} onClick={() => onStickerPick?.(s)} />
                ))}
              </div>
            </>
          )}
        </>
      )}
      {tab === 'gifs' && (
        <div className="gif-panel">
          <input
            type="text"
            className="gif-search"
            placeholder={t('Search GIFs…')}
            value={gifQuery}
            onChange={(e) => setGifQuery(e.target.value)}
            autoFocus
          />
          <div className="gif-grid">
            {gifLoading && <div className="muted" style={{ padding: 12 }}>{t('Loading…')}</div>}
            {!gifLoading && gifs.length === 0 && <div className="muted" style={{ padding: 12 }}>{t('Nothing found')}</div>}
            {gifs.map((g) => (
              <div key={g.id} className="gif-thumb" onClick={() => onGifPick?.(g)}>
                <img src={g.preview} alt="" loading="lazy" />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StickerThumb({ sticker, onClick }: { sticker: { id: number; file_id: number; emoji: string }; onClick: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    getMediaUrl(sticker.file_id).then(setUrl).catch(() => {});
  }, [sticker.file_id]);
  if (!url) return <div className="sticker-thumb loading" />;
  return (
    <div className="sticker-thumb" onClick={onClick} title={sticker.emoji}>
      <img src={url} alt={sticker.emoji} />
    </div>
  );
}
