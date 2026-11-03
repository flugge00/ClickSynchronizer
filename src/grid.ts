// The beat grid: a short list of segments, each starting on a downbeat at a
// host-clock time. Every device derives the exact same ticks from it, so
// changes are sent ahead of time instead of sending individual clicks.

/** 2 = accent, 1 = normal, 0 = silent */
export type Accent = 0 | 1 | 2;

export interface Settings {
  bpm: number;
  beatsPerBar: number;
  subdivision: number;
  accents: Accent[];
}

export interface Segment extends Settings {
  /** Host-clock ms of the first downbeat. */
  start: number;
  playing: boolean;
}

export interface Tick {
  /** Host-clock ms. */
  time: number;
  /** Beat within the bar (0-based). */
  beat: number;
  /** Subdivision within the beat (0 = on the beat). */
  sub: number;
  accent: Accent;
}

const tickMs = (s: Segment) => 60000 / s.bpm / s.subdivision;
const barMs = (s: Segment) => (60000 / s.bpm) * s.beatsPerBar;

function indexAt(segs: Segment[], t: number): number {
  let i = 0;
  while (i + 1 < segs.length && segs[i + 1].start <= t) i++;
  return i;
}

export const segmentAt = (segs: Segment[], t: number) => segs[indexAt(segs, t)];

/** First tick strictly after `after`, or null if nothing plays. */
export function nextTick(segs: Segment[], after: number): Tick | null {
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const end = segs[i + 1]?.start ?? Infinity;
    if (!s.playing || end <= after) continue;
    const len = tickMs(s);
    const k = Math.max(0, Math.floor((after - s.start) / len + 1e-6) + 1);
    const time = s.start + k * len;
    if (time >= end) continue;
    const beat = Math.floor(k / s.subdivision) % s.beatsPerBar;
    return { time, beat, sub: k % s.subdivision, accent: s.accents[beat] ?? 1 };
  }
  return null;
}

/** Earliest moment at or after `t` where a change keeps the grid continuous (next downbeat). */
export function changePoint(segs: Segment[], t: number): number {
  const i = indexAt(segs, t);
  const s = segs[i];
  const bar = barMs(s);
  const at = s.playing ? s.start + Math.max(0, Math.ceil((t - s.start) / bar - 1e-6)) * bar : t;
  const next = segs[i + 1]?.start;
  return next !== undefined && next < at ? next : at;
}

/** New segment list where `seg` takes over from seg.start; drops history before `now`. */
export function withSegment(segs: Segment[], seg: Segment, now: number): Segment[] {
  const kept = segs.filter((s) => s.start < seg.start);
  while (kept.length > 1 && kept[1].start <= now) kept.shift();
  return [...kept, seg];
}
