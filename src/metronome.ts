import { nextTick, type Segment, type Tick } from './grid';

export type Sound = 'sharp' | 'beep' | 'wood' | 'tick';
type Kind = 'accent' | 'beat' | 'sub';

/** 'blocked' = the phone has paused or broken our audio and a tap is needed to bring it back. */
export type AudioHealth = 'ok' | 'blocked';

interface Voice {
  /** Base pitch in Hz. */
  freq: number;
  /** Partials: [frequency ratio, amplitude, extra decay in s (0 = same as the body)]. */
  partials: [number, number, number][];
  attack: number;
  /** Time at full level before the decay: this, more than the peak, is what makes a click sound loud. */
  hold: number;
  /** Exponential decay time constant (s). */
  decay: number;
  length: number;
  /** Short noise burst at the start for a crisp edge. */
  noise: number;
}

// Square-ish waves (odd partials) carry more energy than a sine at the same peak, and 2-4 kHz is
// where the ear is most sensitive and where a band leaves the most room.
const SQUARE: [number, number, number][] = [1, 3, 5, 7, 9].map((n) => [n, 1 / n, 0]);
const VOICES: Record<Sound, Voice> = {
  sharp: { freq: 2000, partials: SQUARE, attack: 0.0005, hold: 0.012, decay: 0.01, length: 0.06, noise: 0.5 },
  beep: { freq: 1000, partials: [[1, 1, 0]], attack: 0.001, hold: 0.018, decay: 0.018, length: 0.09, noise: 0 },
  wood: { freq: 900, partials: [[1, 1, 0], [2.76, 0.6, 0.008], [5.4, 0.25, 0.004]], attack: 0.0005, hold: 0.003, decay: 0.014, length: 0.07, noise: 0.25 },
  tick: { freq: 1800, partials: SQUARE, attack: 0.0003, hold: 0.002, decay: 0.006, length: 0.03, noise: 0.6 },
};

const LOOKAHEAD_S = 0.12; // schedule audio this far ahead
const HIDDEN_LOOKAHEAD_S = 1.5; // background pages only get timers about once a second
const TIMER_MS = 25;
const MAX_PER_PASS = 256; // hard stop so a grid bug can never hang the page again
const KEEP_ALIVE_LEVEL = 3e-4; // -70 dBFS at 15 Hz: inaudible, but the phone sees "playing audio"
const KNEE = 0.85; // soft-clip threshold: below it the click is untouched

/** Soft clipper: linear up to KNEE, then curves smoothly into 1.0. Over-gain becomes loudness, not distortion spikes. */
function softClip(x: number) {
  const a = Math.abs(x);
  if (a <= KNEE) return x;
  return Math.sign(x) * (KNEE + (1 - KNEE) * Math.tanh((a - KNEE) / (1 - KNEE)));
}

/**
 * Plays the beat grid with the Web Audio scheduler. Tick times are in host-clock ms;
 * `hostNow` maps them to this device.
 */
export class Metronome {
  /** 0–3 (0–300 %). Above 1 the click is driven into a soft limiter: louder without exceeding full scale. */
  volume = 1;
  /** 0–1: how much accented beats stand out (pitch up, the other beats quieter). */
  accentStrength = 0.5;
  sound: Sound = 'sharp';
  /** Manual calibration: positive = this device's audio is heard late, so play earlier. */
  latencyMs = 0;
  muted = new Set<number>();
  /** Fires when a tick is heard (for visuals). Driven by the clock, so it keeps going even if audio fails. */
  onTick: (t: Tick) => void = () => {};
  /** Fires when the audio health changes. */
  onHealth: (h: AudioHealth) => void = () => {};

  private silenced = false;
  private active = false; // a session is open or the click is playing: keep audio alive
  private ctx?: AudioContext;
  private out?: GainNode;
  private keepAlive?: GainNode;
  private buffers = new Map<string, AudioBuffer>();
  private segments: Segment[] = [];
  private cursor = 0;
  private visCursor = 0;
  private audioOffset = 0; // seconds: audioTime = perfMs / 1000 + audioOffset
  private offsets: number[] = [];
  private scheduled: { time: number; node: AudioBufferSourceNode }[] = [];
  private lastNode?: AudioBufferSourceNode;
  private lastPreview = 0;
  // health watchdog
  private health: AudioHealth = 'ok';
  private check = { perf: 0, ctx: 0 };
  private stalled = false;
  private badSince = 0;
  private lastRebuild = 0;
  private autoRebuilds = 0;

  constructor(private hostNow: () => number) {
    // A worker timer keeps ticking when the page is in the background (main-thread timers get
    // throttled); the main-thread timer is a fallback. Running both is harmless.
    try {
      const src = `setInterval(() => postMessage(0), ${TIMER_MS})`;
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      w.onmessage = () => this.tick();
    } catch {}
    setInterval(() => this.tick(), TIMER_MS);
    const frame = () => {
      this.flushVisuals();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  /** Must run inside a user gesture. Creates the audio, or rebuilds it if the phone broke it. */
  unlock() {
    const nav = navigator as Navigator & { audioSession?: { type: string } };
    try {
      if (nav.audioSession) nav.audioSession.type = 'playback'; // iOS: play even with silent switch on
    } catch {}
    if (!this.ctx || this.ctx.state === 'closed' || this.stalled || (this.ctx.state as string) === 'interrupted') {
      this.build();
    } else if (this.ctx.state !== 'running') {
      this.ctx.resume().catch(() => {});
    }
  }

  /** Called on any tap: fixes audio if it is broken, otherwise does nothing. */
  heal() {
    if (this.ctx ? this.health !== 'ok' || this.ctx.state !== 'running' : this.active) this.unlock();
  }

  resume() {
    this.ctx?.resume().catch(() => {});
  }

  get unlocked() {
    return this.ctx?.state === 'running';
  }

  get audioHealth() {
    return this.health;
  }

  /** Latency the browser reports for the audio output, in ms. */
  get outputLatencyMs() {
    return this.ctx ? Math.round(((this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0)) * 1000) : 0;
  }

  get playing() {
    return this.segments.some((s) => s.playing);
  }

  /** While active, an inaudible signal keeps the audio output open (see README: "Audio robustness"). */
  setActive(on: boolean) {
    if (on === this.active) return;
    this.active = on;
    if (this.keepAlive && this.ctx) this.keepAlive.gain.setTargetAtTime(on ? KEEP_ALIVE_LEVEL : 0, this.ctx.currentTime, 0.05);
    if (!on) this.setHealth('ok');
  }

  setSegments(segs: Segment[]) {
    const changed = JSON.stringify(segs) !== JSON.stringify(this.segments);
    this.segments = segs;
    if (!changed || !segs.length) return;
    // Undo anything already scheduled from the newest change onwards, then reschedule right away
    // (in the background the lookahead is long, so waiting for the next timer could miss clicks).
    const from = segs[segs.length - 1].start - 0.5;
    this.scheduled = this.scheduled.filter((q) => {
      if (q.time < from) return true;
      try {
        q.node.stop();
      } catch {}
      return false;
    });
    this.lastNode = undefined;
    this.cursor = Math.min(this.cursor, from);
    this.schedule();
  }

  setVolume(v: number) {
    this.volume = v;
    this.buffers.clear();
  }

  setSound(s: Sound) {
    this.sound = s;
    this.buffers.clear();
  }

  setAccentStrength(v: number) {
    this.accentStrength = v;
    this.buffers.clear();
  }

  /** Silences everything on this device, including clicks that are already scheduled. */
  setMuted(m: boolean) {
    this.silenced = m;
    if (!this.out || !this.ctx) return;
    // A very short ramp avoids an audible pop when muting in the middle of a click.
    this.out.gain.setTargetAtTime(m ? 0 : 1, this.ctx.currentTime, 0.005);
  }

  /** Plays a few sample clicks so a setting can be heard (only while stopped). */
  preview(kinds: Kind[] = ['accent', 'beat', 'beat']) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || this.playing || this.silenced) return;
    if (performance.now() - this.lastPreview < 400) return;
    this.lastPreview = performance.now();
    kinds.forEach((k, i) => this.play(ctx, ctx.currentTime + 0.05 + i * 0.32, k));
  }

  // ---------- audio graph ----------

  private build() {
    const old = this.ctx;
    this.ctx = undefined;
    old?.close().catch(() => {});
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ latencyHint: 'interactive' });
    } catch {
      return;
    }
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = this.silenced ? 0 : 1;
    this.out.connect(ctx.destination);
    // Keep-alive goes straight to the output, so it keeps working while muted.
    const osc = ctx.createOscillator();
    osc.frequency.value = 15;
    this.keepAlive = ctx.createGain();
    this.keepAlive.gain.value = this.active ? KEEP_ALIVE_LEVEL : 0;
    osc.connect(this.keepAlive).connect(ctx.destination);
    osc.start();

    this.buffers.clear(); // the sample rate may differ
    this.offsets = [];
    this.scheduled = [];
    this.lastNode = undefined;
    this.cursor = this.hostNow(); // reschedule everything not heard yet on the new context
    this.check = { perf: performance.now(), ctx: 0 };
    this.stalled = false;
    this.badSince = 0;
    this.lastRebuild = performance.now();
    ctx.onstatechange = () => this.watch(true);
    ctx.resume().catch(() => {});
  }

  private buffer(ctx: AudioContext, kind: Kind): AudioBuffer {
    const key = `${this.sound}|${kind}`;
    let buf = this.buffers.get(key);
    if (buf) return buf;
    const v = VOICES[this.sound];
    const s = this.accentStrength;
    const pitch = kind === 'accent' ? 1 + s : kind === 'sub' ? 0.8 : 1;
    const beatLevel = 1 - 0.5 * s;
    const level = kind === 'accent' ? 1 : kind === 'sub' ? beatLevel * 0.6 : beatLevel;
    const sr = ctx.sampleRate;
    const n = Math.ceil(v.length * sr);
    const data = new Float32Array(n);
    const f = v.freq * pitch;
    const maxHz = Math.min(sr * 0.45, 16000); // drop partials that would alias
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const body = t < v.attack ? t / v.attack : t < v.attack + v.hold ? 1 : Math.exp(-(t - v.attack - v.hold) / v.decay);
      let x = 0;
      for (const [ratio, amp, extra] of v.partials) {
        if (f * ratio > maxHz) continue;
        x += amp * Math.sin(2 * Math.PI * f * ratio * t) * (extra ? Math.exp(-t / extra) : 1);
      }
      x *= body;
      if (v.noise && t < 0.002) x += v.noise * (Math.random() * 2 - 1) * (1 - t / 0.002);
      const fade = Math.min(1, (v.length - t) / 0.003); // no click at the end
      data[i] = x * fade;
      peak = Math.max(peak, Math.abs(data[i]));
    }
    // Normalise to full scale, apply the volume (over-gain goes into the soft clipper), then the level.
    for (let i = 0; i < n; i++) data[i] = softClip((data[i] / (peak || 1)) * this.volume) * level;
    buf = ctx.createBuffer(1, n, sr);
    buf.copyToChannel(data, 0);
    this.buffers.set(key, buf);
    return buf;
  }

  private play(ctx: AudioContext, at: number, kind: Kind) {
    const src = ctx.createBufferSource();
    src.buffer = this.buffer(ctx, kind);
    src.connect(this.out!);
    src.start(at);
    // One click at a time: cut the previous tail so fast subdivisions never pile up and clip.
    try {
      this.lastNode?.stop(at);
    } catch {}
    this.lastNode = src;
    return src;
  }

  // ---------- scheduling ----------

  private tick() {
    const ctx = this.ctx;
    if (!ctx) return;
    this.watch();
    if (ctx.state === 'running') this.schedule();
  }

  private schedule() {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const toPerf = performance.now() - this.hostNow(); // host ms -> local performance ms
    this.updateAudioOffset(ctx);
    const lookahead = document.hidden ? HIDDEN_LOOKAHEAD_S : LOOKAHEAD_S;
    this.cursor = Math.max(this.cursor, this.hostNow() - 1000);
    for (let n = 0; n < MAX_PER_PASS; n++) {
      const tick = nextTick(this.segments, this.cursor);
      if (!tick || tick.time <= this.cursor) break;
      const at = (tick.time + toPerf - this.latencyMs) / 1000 + this.audioOffset;
      if (at > ctx.currentTime + lookahead) break;
      this.cursor = tick.time;
      if (at < ctx.currentTime || tick.accent === 0 || this.muted.has(tick.beat)) continue;
      const kind: Kind = tick.sub ? 'sub' : tick.accent === 2 ? 'accent' : 'beat';
      this.scheduled.push({ time: tick.time, node: this.play(ctx, at, kind) });
    }
    const old = this.hostNow() - 2000;
    while (this.scheduled.length && this.scheduled[0].time < old) this.scheduled.shift();
  }

  /** Keeps a filtered mapping from performance.now() to the time audio is actually heard. */
  private updateAudioOffset(ctx: AudioContext) {
    const now = performance.now();
    // currentTime runs ahead of what is heard by the processing + output latency.
    const fallback = ctx.currentTime - now / 1000 - ((ctx.outputLatency || 0) + (ctx.baseLatency || 0));
    let offset = fallback;
    const ts = ctx.getOutputTimestamp?.();
    // Trust the output timestamp only when it is fresh and plausible: some browsers return zeros or
    // a frozen value (e.g. after an output switch), which would push every click out of reach.
    if (ts?.contextTime && ts.performanceTime && now - ts.performanceTime < 1000 && ts.performanceTime <= now + 50) {
      const o = ts.contextTime - ts.performanceTime / 1000;
      if (Math.abs(o - fallback) < 1) offset = o;
    }
    // Rolling median (~0.5 s) ignores jitter but settles fast after the device starts.
    this.offsets = [...this.offsets.slice(-19), offset];
    this.audioOffset = [...this.offsets].sort((a, b) => a - b)[this.offsets.length >> 1];
  }

  // ---------- health watchdog ----------

  /**
   * Phones pause or break Web Audio behind our back: iOS "interrupts" it (calls, other apps, Siri,
   * headphones connecting), and some devices keep saying "running" while the clock stops. We
   * resume it, rebuild it if that does not help, and ask for a tap if the browser requires one.
   */
  private watch(force = false) {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = performance.now();
    if (!force && now - this.check.perf < 500) return;
    const wall = (now - this.check.perf) / 1000;
    const advanced = ctx.currentTime - this.check.ctx;
    if (!force) {
      this.stalled = ctx.state === 'running' && wall > 0.4 && advanced < wall * 0.5;
      this.check = { perf: now, ctx: ctx.currentTime };
    }
    const ok = ctx.state === 'running' && !this.stalled;
    if (ok) {
      this.badSince = 0;
      this.autoRebuilds = 0;
      this.setHealth('ok');
      return;
    }
    if (!this.active) return;
    this.badSince ||= now;
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    const bad = now - this.badSince;
    // Rebuild only while visible: a hidden iOS page is suspended on purpose and would just fail again.
    // A few tries per episode; after that only a tap (heal/unlock) can help.
    if (bad > 1500 && !document.hidden && now - this.lastRebuild > 5000 && this.autoRebuilds < 3) {
      this.autoRebuilds++;
      this.build();
      this.badSince = now - 1001; // keep reporting 'blocked' until the new context proves itself
    }
    if (bad > 1000) this.setHealth('blocked');
  }

  private setHealth(h: AudioHealth) {
    if (h === this.health) return;
    this.health = h;
    this.onHealth(h);
  }

  // ---------- visuals ----------

  private flushVisuals() {
    const now = this.hostNow();
    if (this.visCursor < now - 1000) this.visCursor = now - 1000;
    let last: Tick | undefined;
    for (let n = 0; n < MAX_PER_PASS; n++) {
      const t = nextTick(this.segments, this.visCursor);
      if (!t || t.time > now || t.time <= this.visCursor) break;
      this.visCursor = t.time;
      last = t;
    }
    if (last && now - last.time < 150) this.onTick(last);
  }
}
