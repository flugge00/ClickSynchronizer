const localNow = () => performance.timeOrigin + performance.now();

const WINDOW = 15; // recent samples kept (~30 s at one ping every 2 s)
const BEST = 5; // lowest-RTT samples used for the estimate

/** NTP-style estimate of the host's clock. On the host itself the offset stays 0. */
export class Clock {
  offset = 0;
  rtt = 0;
  /** Spread of the best offset samples (ms): a measure of sync quality. */
  spread = 0;
  private samples: { rtt: number; offset: number }[] = [];

  now = () => localNow() + this.offset;

  get synced() {
    return this.samples.length >= BEST;
  }

  ping() {
    return { t: 'ping', c0: localNow() } as const;
  }

  pong(c0: number) {
    return { t: 'pong', c0, h: this.now() } as const;
  }

  onPong(c0: number, h: number) {
    const c1 = localNow();
    this.samples.push({ rtt: c1 - c0, offset: h - (c0 + c1) / 2 });
    if (this.samples.length > WINDOW) this.samples.shift();

    const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, BEST);
    const offsets = best.map((s) => s.offset).sort((a, b) => a - b);
    const target = offsets[Math.floor(offsets.length / 2)];
    this.rtt = best[0].rtt;
    this.spread = offsets[offsets.length - 1] - offsets[0];

    // Jump while syncing or after a big change; otherwise slew gently so clicks never jump.
    const diff = target - this.offset;
    this.offset += this.samples.length < 10 || Math.abs(diff) > 30 ? diff : Math.max(-1, Math.min(1, diff));
  }

  reset() {
    this.samples = [];
    this.offset = 0;
    this.rtt = this.spread = 0;
  }
}
