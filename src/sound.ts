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
