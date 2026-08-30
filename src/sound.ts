let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  try {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

// Web Audio requires a user gesture first — prepare the context on first interaction
if (typeof window !== 'undefined') {
  const warmup = () => getCtx();
  window.addEventListener('pointerdown', warmup, { once: true, passive: true });
  window.addEventListener('keydown', warmup, { once: true, passive: true });
}

export function playNotificationSound() {
  const ac = getCtx();
  if (!ac) return;
  const now = ac.currentTime;
  const notes = [784, 1046.5];
  for (let i = 0; i < notes.length; i++) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(notes[i], now + i * 0.06);
    gain.gain.setValueAtTime(0.001, now + i * 0.06);
    gain.gain.exponentialRampToValueAtTime(0.14, now + i * 0.06 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.06 + 0.22);
    osc.connect(gain).connect(ac.destination);
    osc.start(now + i * 0.06);
    osc.stop(now + i * 0.06 + 0.3);
  }
}

// In-call ringing/dial tones (generated via Web Audio, no assets needed).
// Returns a stop() function; safe to call even if the tone already stopped.
export function startCallTone(kind: 'outgoing' | 'incoming'): () => void {
  const ac = getCtx();
  if (!ac) return () => {};
  let stopped = false;

  const beep = (freq: number, at: number, dur: number, peak: number) => {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, at);
    gain.gain.setValueAtTime(0.001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, at + dur);
    osc.connect(gain).connect(ac.destination);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  };

  const playPattern = () => {
    if (stopped) return;
    const now = ac.currentTime;
    if (kind === 'incoming') {
      // classic double ring: ring-ring, pause
      beep(440, now, 0.18, 0.16);
      beep(440, now + 0.32, 0.32, 0.16);
    } else {
      // outgoing: two short beeps
      beep(520, now, 0.16, 0.1);
      beep(520, now + 0.24, 0.24, 0.1);
    }
  };

  playPattern();
  const timer = setInterval(() => playPattern(), kind === 'incoming' ? 3200 : 3600);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
