import { nextTick, type Segment, type Tick } from './grid';

export type Sound = 'beep' | 'wood' | 'tick';

const SOUNDS: Record<Sound, { type: OscillatorType; freq: number; decay: number }> = {
  beep: { type: 'sine', freq: 1000, decay: 0.06 },
  wood: { type: 'triangle', freq: 620, decay: 0.035 },
  tick: { type: 'square', freq: 1800, decay: 0.015 },
};

const LOOKAHEAD_S = 0.12; // schedule audio this far ahead
const TIMER_MS = 25;

/**
 * Plays the beat grid with the Web Audio scheduler. Tick times are in host-clock ms;
 * `hostNow` maps them to this device.
 */
export class Metronome {
  volume = 0.8;
  sound: Sound = 'beep';
  /** Manual calibration: positive = this device's audio is heard late, so play earlier. */
  latencyMs = 0;
  muted = new Set<number>();
  /** Fires when a tick is heard (for visuals). */
  onTick: (t: Tick) => void = () => {};

  private silenced = false;
  private ctx?: AudioContext;
  private out?: GainNode;
  private segments: Segment[] = [];
  private cursor = 0;
  private audioOffset = 0; // seconds: audioTime = perfMs / 1000 + audioOffset
  private offsets: number[] = [];
  private queue: { tick: Tick; nodes: AudioScheduledSourceNode[] }[] = [];

  constructor(private hostNow: () => number) {}

  /** Must run inside a user gesture. */
  unlock() {
    const nav = navigator as Navigator & { audioSession?: { type: string } };
    if (nav.audioSession) nav.audioSession.type = 'playback'; // iOS: play even with silent switch on
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.out = this.ctx.createGain();
      this.out.gain.value = this.silenced ? 0 : this.volume;
      this.out.connect(this.ctx.destination);
      setInterval(() => this.schedule(), TIMER_MS);
      const frame = () => {
        this.flushVisuals();
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }
    this.ctx.resume();
  }

  resume() {
    this.ctx?.resume();
  }

  get unlocked() {
    return this.ctx?.state === 'running';
  }

  /** Latency the browser reports for the audio output, in ms. */
  get outputLatencyMs() {
    return this.ctx ? Math.round(((this.ctx.outputLatency || 0) + this.ctx.baseLatency) * 1000) : 0;
  }

  get playing() {
    return this.segments.some((s) => s.playing);
  }

  setSegments(segs: Segment[]) {
    const changed = JSON.stringify(segs) !== JSON.stringify(this.segments);
    this.segments = segs;
    if (!changed || !segs.length) return;
    // Undo anything already scheduled from the newest change onwards.
    const from = segs[segs.length - 1].start - 0.5;
    this.queue = this.queue.filter((q) => {
      if (q.tick.time < from) return true;
      q.nodes.forEach((n) => n.stop());
      return false;
    });
    this.cursor = Math.min(this.cursor, from);
  }

  setVolume(v: number) {
    this.volume = v;
    this.applyGain();
  }

  /** Silences everything on this device, including clicks that are already scheduled. */
  setMuted(m: boolean) {
    this.silenced = m;
    this.applyGain();
  }

  private applyGain() {
    if (!this.out || !this.ctx) return;
    // A very short ramp avoids an audible pop when muting in the middle of a click.
    this.out.gain.setTargetAtTime(this.silenced ? 0 : this.volume, this.ctx.currentTime, 0.005);
  }

  private schedule() {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const toPerf = performance.now() - this.hostNow(); // host ms -> local performance ms
    this.updateAudioOffset(ctx);
    this.cursor = Math.max(this.cursor, this.hostNow() - 1000);
    for (;;) {
      const tick = nextTick(this.segments, this.cursor);
      if (!tick) break;
      const at = (tick.time + toPerf - this.latencyMs) / 1000 + this.audioOffset;
      if (at > ctx.currentTime + LOOKAHEAD_S) break;
      this.cursor = tick.time;
      const nodes = at >= ctx.currentTime ? this.click(ctx, at, tick) : [];
      this.queue.push({ tick, nodes });
    }
  }

  /** Keeps a filtered mapping from performance.now() to the time audio is actually heard. */
  private updateAudioOffset(ctx: AudioContext) {
    const ts = ctx.getOutputTimestamp?.();
    const offset = ts?.performanceTime
      ? ts.contextTime! - ts.performanceTime / 1000
      : ctx.currentTime - performance.now() / 1000 - (ctx.outputLatency || ctx.baseLatency || 0);
    // Rolling median (~0.5 s) ignores jitter but settles fast after the device starts.
    this.offsets = [...this.offsets.slice(-19), offset];
    this.audioOffset = [...this.offsets].sort((a, b) => a - b)[this.offsets.length >> 1];
  }

  private click(ctx: AudioContext, at: number, tick: Tick): AudioScheduledSourceNode[] {
    if (tick.accent === 0 || this.muted.has(tick.beat)) return [];
    const s = SOUNDS[this.sound];
    const accent = tick.sub === 0 && tick.accent === 2;
    const level = tick.sub ? 0.35 : accent ? 1 : 0.6;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = s.type;
    osc.frequency.value = s.freq * (accent ? 1.5 : tick.sub ? 0.8 : 1);
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(level, at + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + s.decay);
    osc.connect(gain).connect(this.out!);
    osc.start(at);
    osc.stop(at + s.decay + 0.01);
    return [osc];
  }

  private flushVisuals() {
    const now = this.hostNow();
    while (this.queue.length && this.queue[0].tick.time <= now) this.onTick(this.queue.shift()!.tick);
  }
}
