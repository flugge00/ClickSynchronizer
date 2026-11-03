// ICE (STUN/TURN) servers. TURN credentials come from our Cloudflare Worker, which keeps the
// secret key. We ask for them only when a session starts and cache them in localStorage, so the
// Worker sees roughly one request per device per day. If anything fails we fall back to STUN only
// (direct connections still work, relayed ones don't).
const WORKER_URL = import.meta.env.VITE_TURN_URL ?? 'https://click-synchronizer.flugge00.workers.dev';
const KEY = 'clicksync-ice';
const REFRESH_MARGIN_MS = 2 * 3600_000; // fetch fresh credentials when less than this is left
const FETCH_TIMEOUT_MS = 4000;

const FALLBACK: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];

type Cached = { exp: number; iceServers: RTCIceServer[] };
let memory: Cached | undefined;

function stored(): Cached | undefined {
  try {
    const c = memory ?? (JSON.parse(localStorage.getItem(KEY) ?? 'null') as Cached | null);
    if (c && c.exp - Date.now() > REFRESH_MARGIN_MS) return c;
  } catch {}
  return undefined;
}

export async function getIceServers(): Promise<RTCIceServer[]> {
  const hit = stored();
  if (hit) return hit.iceServers;
  try {
    const res = await fetch(WORKER_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(String(res.status));
    const { iceServers, ttl } = (await res.json()) as { iceServers: RTCIceServer[]; ttl: number };
    memory = { exp: Date.now() + ttl * 1000, iceServers };
    try {
      localStorage.setItem(KEY, JSON.stringify(memory));
    } catch {}
    return iceServers;
  } catch {
    return FALLBACK;
  }
}
