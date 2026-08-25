import { useEffect, useRef, useState } from 'react';
import type { MediaDTO } from '../api';
import { getMediaUrl, formatDuration, computeWaveform } from '../media';
import { PlayIcon, PauseIcon } from './icons';
import { t } from '../i18n';
import { decryptFile, importFileKey } from '../crypto/e2e';

const SPEED_OPTIONS = [1, 1.5, 2];

export function VoicePlayer({ media, e2eFileKey }: { media: MediaDTO; e2eFileKey?: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(media.duration ?? 0);
  const [wave, setWave] = useState<number[]>([]);
  const [speed, setSpeed] = useState(1);

  useEffect(() => {
    let alive = true;
    const loadAudio = async () => {
      try {
        let audioUrl: string;
        if (e2eFileKey) {
          const { api } = await import('../api');
          const blob = await api.fetchMediaBlob(media.id);
          if (!alive) return;
          const arrayBuf = await blob.arrayBuffer();
          const fileKey = await importFileKey(e2eFileKey);
          const decrypted = await decryptFile(arrayBuf, new ArrayBuffer(0), fileKey);
          const decBlob = new Blob([decrypted], { type: media.mime || 'audio/webm' });
          audioUrl = URL.createObjectURL(decBlob);
        } else {
          audioUrl = await getMediaUrl(media.id);
        }
        if (!alive) { if (e2eFileKey) URL.revokeObjectURL(audioUrl); return; }
        setUrl(audioUrl);
        const response = await fetch(audioUrl);
        const buf = await response.arrayBuffer();
        const Ctx = window.AudioContext || (window as any).webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        const decoded = await ctx.decodeAudioData(buf);
        const bars = computeWaveform(decoded.getChannelData(0), 48);
        if (alive) {
          setWave(bars);
          if (!duration) setDuration(decoded.duration);
        }
        ctx.close();
      } catch { /* ignore */ }
    };
    void loadAudio();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media.id, e2eFileKey]);

  useEffect(() => {
    return () => { if (url && url.startsWith('blob:')) URL.revokeObjectURL(url); };
  }, [url]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) audio.playbackRate = speed;
  }, [speed]);

  const cycleSpeed = () => {
    setSpeed((s) => {
      const idx = SPEED_OPTIONS.indexOf(s);
      return SPEED_OPTIONS[(idx + 1) % SPEED_OPTIONS.length];
    });
  };

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play();
      setPlaying(true);
    } else {
      audio.pause();
      setPlaying(false);
    }
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * (audio.duration || duration);
    setCurrent(audio.currentTime);
  };

  const bars = wave.length ? wave : new Array(48).fill(0.35);
  const progress = duration ? current / duration : 0;
  const played = Math.round(progress * bars.length);

  return (
    <div className="voice">
      <audio
        ref={audioRef}
        src={url ?? undefined}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onEnded={() => {
          setPlaying(false);
          setCurrent(0);
        }}
        preload="metadata"
      />
      <button className={`voice-play${playing ? ' playing' : ''}`} onClick={toggle} title={playing ? 'Pause' : 'Play'}>
        {playing ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
      </button>
      <div className="voice-wave" onClick={seek}>
        {bars.map((h, i) => (
          <span
            key={i}
            className={`voice-bar${i < played ? ' played' : ''}`}
            style={{ height: `${Math.max(8, Math.round(h * 100))}%` }}
          />
        ))}
      </div>
      <span className="voice-time">
        {formatDuration(current)} / {formatDuration(duration)}
      </span>
      <button className="voice-speed" onClick={cycleSpeed} title={t('Playback speed')}>
        {speed}x
      </button>
    </div>
  );
}
