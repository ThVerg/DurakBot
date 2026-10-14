// Generated sound effects (WebAudio, no assets). All calls are no-ops when
// muted or when audio is unavailable.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let enabled = true;
let noiseBuf: AudioBuffer | null = null;

export function setSoundEnabled(on: boolean) {
  enabled = on;
}

function ac(): AudioContext | null {
  if (!enabled) return null;
  try {
    if (!ctx) {
      const C = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!C) return null;
      ctx = new C();
      master = ctx.createGain();
      master.gain.value = 0.55;
      const comp = ctx.createDynamicsCompressor();
      master.connect(comp).connect(ctx.destination);
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** Call from a user gesture so later sounds are allowed to play. */
export function unlockAudio() {
  ac();
}

function noise(c: AudioContext): AudioBuffer {
  if (noiseBuf && noiseBuf.sampleRate === c.sampleRate) return noiseBuf;
  const len = Math.floor(c.sampleRate * 1.0);
  const b = c.createBuffer(1, len, c.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  noiseBuf = b;
  return b;
}

function burst(opts: {
  at?: number;
  dur: number;
  freq: number;
  q?: number;
  gain: number;
  type?: BiquadFilterType;
  sweepTo?: number;
}) {
  const c = ac();
  if (!c || !master) return;
  const t = c.currentTime + (opts.at ?? 0);
  const src = c.createBufferSource();
  src.buffer = noise(c);
  const f = c.createBiquadFilter();
  f.type = opts.type ?? "bandpass";
  f.frequency.setValueAtTime(opts.freq, t);
  if (opts.sweepTo) f.frequency.exponentialRampToValueAtTime(opts.sweepTo, t + opts.dur);
  f.Q.value = opts.q ?? 1;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(opts.gain, t + Math.min(0.012, opts.dur / 4));
  g.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);
  src.connect(f).connect(g).connect(master);
  src.start(t, Math.random() * 0.5);
  src.stop(t + opts.dur + 0.05);
}

function tone(opts: { at?: number; dur: number; freq: number; gain: number; type?: OscillatorType; slideTo?: number }) {
  const c = ac();
  if (!c || !master) return;
  const t = c.currentTime + (opts.at ?? 0);
  const o = c.createOscillator();
  o.type = opts.type ?? "sine";
  o.frequency.setValueAtTime(opts.freq, t);
  if (opts.slideTo) o.frequency.exponentialRampToValueAtTime(opts.slideTo, t + opts.dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(opts.gain, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + opts.dur + 0.05);
}

export const sfx = {
  /** A card slapped onto the table. */
  snap() {
    burst({ dur: 0.07, freq: 2600, q: 0.8, gain: 0.6, type: "bandpass" });
    burst({ dur: 0.05, freq: 380, q: 1.2, gain: 0.35, type: "lowpass" });
  },
  /** Soft tick for dealt / drawn cards. */
  deal(at = 0) {
    burst({ at, dur: 0.045, freq: 3600, q: 1.4, gain: 0.22 });
  },
  shuffle() {
    for (let i = 0; i < 14; i++) burst({ at: i * 0.032 + Math.random() * 0.01, dur: 0.04, freq: 2600 + Math.random() * 1800, q: 1.5, gain: 0.18 });
    for (let i = 0; i < 10; i++) burst({ at: 0.55 + i * 0.03, dur: 0.04, freq: 2400 + Math.random() * 1800, q: 1.5, gain: 0.16 });
  },
  /** Table swept to the discard pile. */
  swoosh() {
    burst({ dur: 0.38, freq: 700, sweepTo: 4200, q: 0.9, gain: 0.32, type: "bandpass" });
  },
  /** Defender picks up the table. */
  take() {
    burst({ dur: 0.3, freq: 1800, sweepTo: 500, q: 0.8, gain: 0.3 });
    tone({ at: 0.04, dur: 0.22, freq: 150, slideTo: 90, gain: 0.25, type: "triangle" });
  },
  click() {
    tone({ dur: 0.05, freq: 880, gain: 0.06, type: "triangle" });
  },
  hint() {
    tone({ dur: 0.18, freq: 660, gain: 0.08 });
    tone({ at: 0.09, dur: 0.24, freq: 990, gain: 0.07 });
  },
  out() {
    [523, 659, 784].forEach((f, i) => tone({ at: i * 0.07, dur: 0.22, freq: f, gain: 0.08, type: "triangle" }));
  },
  win() {
    [523, 659, 784, 1047, 1319].forEach((f, i) => tone({ at: i * 0.09, dur: 0.4, freq: f, gain: 0.09, type: "triangle" }));
    burst({ at: 0.45, dur: 0.6, freq: 6000, q: 0.5, gain: 0.08, type: "highpass" });
  },
  lose() {
    tone({ dur: 0.18, freq: 70, gain: 0.5, type: "sine" });
    burst({ dur: 0.25, freq: 200, q: 0.7, gain: 0.5, type: "lowpass" });
    [392, 370, 349, 262].forEach((f, i) => tone({ at: 0.25 + i * 0.22, dur: 0.38, freq: f, gain: 0.08, type: "sawtooth" }));
  },
};
