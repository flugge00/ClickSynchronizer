import QRCode from 'qrcode';
import './style.css';
import { Clock } from './clock';
import { changePoint, nextTick, withSegment, type Accent, type Segment, type Settings } from './grid';
import { Metronome, type Sound } from './metronome';
import { hostRoom, joinRoom, type Transport } from './transport';

type Msg =
  | { t: 'ping'; c0: number }
  | { t: 'pong'; c0: number; h: number }
  | { t: 'state'; rev: number; segments: Segment[] }
  | { t: 'info'; name: string; rtt: number; spread: number };

type Player = { name: string; rtt: number; spread: number };
type Link = 'connecting' | 'notfound' | 'connected' | 'reconnecting' | 'live' | 'offline';

const LEAD_MS = { solo: 60, host: 400 }; // how far ahead changes take effect
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ---------- preferences ----------
const prefs = {
  bpm: 120,
  beatsPerBar: 4,
  subdivision: 1,
  accents: [2, 1, 1, 1] as Accent[],
  volume: 0.8,
  sound: 'beep' as Sound,
  /** Saved latency calibrations, one per pair of headphones. */
  profiles: [{ name: 'Wired / speaker', latency: 0 }],
  profile: 0,
  flash: false,
  name: '',
};
try {
  Object.assign(prefs, JSON.parse(localStorage.getItem('clicksync') ?? '{}'));
} catch {}
const save = () => {
  try {
    localStorage.setItem('clicksync', JSON.stringify(prefs));
  } catch {}
};

// ---------- state ----------
const clock = new Clock();
const metro = new Metronome(clock.now);
metro.setVolume(prefs.volume);
metro.sound = prefs.sound;
const profile = () => prefs.profiles[prefs.profile] ?? prefs.profiles[0];
metro.latencyMs = profile().latency;

let role: 'solo' | 'host' | 'listener' = 'solo';
let net: Transport<Msg> | undefined;
let code = '';
let link: Link = 'connecting';
let rev = 0;
const players = new Map<string, Player>();

const stoppedGrid = (): Segment[] => [
  { bpm: prefs.bpm, beatsPerBar: prefs.beatsPerBar, subdivision: prefs.subdivision, accents: prefs.accents, playing: false, start: 0 },
];
let segments = stoppedGrid();
const current = () => segments[segments.length - 1];

// ---------- controlling the grid (solo / host) ----------
function change(patch: Partial<Settings> & { playing?: boolean }) {
  if (role === 'listener') return;
  const cur = current();
  const next: Segment = { ...cur, ...patch };
  if (patch.beatsPerBar) {
    next.accents = Array.from({ length: patch.beatsPerBar }, (_, i) => cur.accents[i] ?? (i ? 1 : 2));
  }
  const now = clock.now();
  const t = now + LEAD_MS[role];
  next.start = cur.playing && next.playing ? changePoint(segments, t) : t;
  segments = withSegment(segments, next, now);
  rev++;
  metro.setSegments(segments);
  net?.send({ t: 'state', rev, segments });

  const { bpm, beatsPerBar, subdivision, accents } = next;
  Object.assign(prefs, { bpm, beatsPerBar, subdivision, accents });
  save();
  render();
}

const setBpm = (bpm: number) => change({ bpm: clamp(Math.round(bpm), 30, 300) });

// ---------- hosting ----------
function newCode() {
  return Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

function startHost(roomCode = newCode(), reclaimTries = 0) {
  role = 'host';
  code = roomCode;
  link = 'connecting';
  players.clear();
  const room = hostRoom<Msg>(roomCode, {
    onReady() {
      link = 'live';
      sessionStorage.setItem('hostCode', roomCode);
      render();
    },
    onJoin(id) {
      players.set(id, { name: '', rtt: 0, spread: 0 });
      room.send({ t: 'state', rev, segments }, id);
      render();
    },
    onLeave(id) {
      players.delete(id);
      render();
    },
    onMessage(m, from) {
      if (m.t === 'ping') room.send(clock.pong(m.c0), from);
      if (m.t === 'info') {
        players.set(from, { name: String(m.name).slice(0, 20), rtt: m.rtt, spread: m.spread });
        render();
      }
    },
    onError(type) {
      if (net !== room) return;
      if (type === 'unavailable-id') {
        // After a reload our old code may still be registered for a few seconds.
        room.close();
        if (reclaimTries < 5) setTimeout(() => net === room && startHost(roomCode, reclaimTries + 1), 2000);
        else startHost();
        return;
      }
      link = 'offline';
      render();
    },
  });
  net = room;
  render();
  showQr();
}

async function showQr() {
  $('qr').innerHTML = await QRCode.toString(shareUrl(), { type: 'svg', margin: 0, color: { dark: '#000', light: '#fff' } });
}

const shareUrl = () => `${location.origin}${location.pathname}#/join/${code}`;

// ---------- listening ----------
function startListener(roomCode: string) {
  metro.unlock();
  role = 'listener';
  code = roomCode;
  link = 'connecting';
  rev = -1;
  clock.reset();
  segments = stoppedGrid();
  metro.setSegments(segments);
  const room = joinRoom<Msg>(roomCode, {
    onJoin() {
      link = 'connected';
      rev = -1;
      burstPing();
      render();
    },
    onLeave() {
      link = 'reconnecting';
      render();
    },
    onMessage(m) {
      if (m.t === 'pong') {
        clock.onPong(m.c0, m.h);
        room.send({ t: 'info', name: prefs.name, rtt: Math.round(clock.rtt), spread: Math.round(clock.spread) });
      }
      if (m.t === 'state' && m.rev > rev) {
        rev = m.rev;
        segments = m.segments;
      }
      if (clock.synced) metro.setSegments(segments);
      render();
    },
    onError(type) {
      if (type === 'peer-unavailable' && link !== 'reconnecting') link = 'notfound';
      render();
    },
  });
  net = room;
  render();
}

function burstPing() {
  for (let i = 0; i < 10; i++) setTimeout(() => net?.send(clock.ping()), i * 60);
}

function leave() {
  net?.close();
  net = undefined;
  sessionStorage.removeItem('hostCode');
  history.replaceState(null, '', location.pathname);
  if (role === 'listener') {
    clock.reset();
    metro.muted.clear();
    segments = stoppedGrid();
    metro.setSegments(segments);
    rev = 0;
  }
  role = 'solo';
  players.clear();
  render();
}

// Listeners re-sync every 2 s; the host re-sends the grid as a heartbeat.
setInterval(() => {
  if (role === 'listener') net?.send(clock.ping());
  if (role === 'host') net?.send({ t: 'state', rev, segments });
}, 2000);

// ---------- rendering ----------
const beatsEl = $('beats');

function render() {
  const s = current();
  const readonly = role === 'listener';
  $('bpm').textContent = String(s.bpm);
  $<HTMLInputElement>('bpmRange').value = String(s.bpm);
  $('beatsPerBar').textContent = String(s.beatsPerBar);
  document.querySelectorAll<HTMLElement>('[data-sub]').forEach((b) => {
    b.setAttribute('aria-pressed', String(Number(b.dataset.sub) === s.subdivision));
  });
  const play = $('play');
  play.textContent = s.playing ? 'Stop' : 'Start';
  play.classList.toggle('playing', s.playing);

  if (beatsEl.children.length !== s.beatsPerBar) {
    beatsEl.replaceChildren(
      ...Array.from({ length: s.beatsPerBar }, (_, i) => {
        const b = document.createElement('button');
        b.className = 'beat';
        b.dataset.i = String(i);
        b.setAttribute('aria-label', `Beat ${i + 1}`);
        return b;
      }),
    );
  }
  [...beatsEl.children].forEach((b, i) => {
    const el = b as HTMLElement;
    el.dataset.accent = String(s.accents[i] ?? 1);
    el.classList.toggle('muted', metro.muted.has(i));
    if (!s.playing) el.classList.remove('now');
  });

  $('metro').classList.toggle('readonly', readonly);
  document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('.host-control').forEach((el) => (el.disabled = readonly));
  document.querySelectorAll<HTMLElement>('[data-view]').forEach((v) => (v.hidden = v.dataset.view !== role));
  $('hostCode').textContent = $('listenCode').textContent = code;

  renderStatus();
  if (role === 'host') renderPlayers();
  updateWakeLock();
}

function renderStatus() {
  const el = $('status');
  let text = '';
  let tone = 'ok';
  if (role === 'host') {
    text = link === 'live' ? `Hosting · ${players.size}` : link === 'offline' ? 'Offline – retrying' : 'Starting…';
    tone = link === 'live' ? 'good' : 'ok';
  } else if (role === 'listener') {
    const map: Record<string, [string, string]> = {
      connecting: ['Connecting…', 'ok'],
      notfound: ['Host not found – retrying', 'bad'],
      reconnecting: ['Reconnecting…', 'bad'],
      connected: clock.synced ? ['Synced', 'good'] : ['Syncing…', 'ok'],
    };
    [text, tone] = map[link] ?? ['', 'ok'];
  }
  el.hidden = !text;
  el.textContent = text;
  el.dataset.tone = tone;
}

function renderPlayers() {
  $('playerCount').textContent = players.size ? `(${players.size})` : '';
  const list = $('players');
  if (!players.size) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Waiting for players to join…';
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(
    ...[...players.values()].map((p) => {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      const name = document.createElement('span');
      const meta = document.createElement('span');
      const synced = p.rtt > 0;
      dot.className = 'dot';
      dot.dataset.tone = !synced ? 'ok' : p.spread <= 3 ? 'good' : p.spread <= 10 ? 'ok' : 'bad';
      name.className = 'name';
      name.textContent = p.name || 'Player';
      meta.className = 'meta';
      meta.textContent = synced ? `${p.rtt} ms · ±${p.spread} ms` : 'Syncing…';
      li.append(dot, name, meta);
      return li;
    }),
  );
}

metro.onTick = (t) => {
  if (t.sub) return;
  [...beatsEl.children].forEach((b, i) => b.classList.toggle('now', i === t.beat));
  if (prefs.flash && t.accent && !metro.muted.has(t.beat)) {
    $('flash').animate([{ opacity: t.accent === 2 ? 0.9 : 0.45 }, { opacity: 0 }], { duration: 160, easing: 'ease-out' });
  }
};

// ---------- wake lock ----------
let wakeLock: Promise<WakeLockSentinel | undefined> | undefined;
function updateWakeLock() {
  const want = (role !== 'solo' || current().playing) && document.visibilityState === 'visible';
  if (want && !wakeLock) {
    wakeLock = navigator.wakeLock?.request('screen').catch(() => undefined);
    wakeLock?.then((l) => l?.addEventListener('release', () => (wakeLock = undefined)));
    if (!wakeLock) wakeLock = Promise.resolve(undefined);
  } else if (!want && wakeLock) {
    wakeLock.then((l) => l?.release());
    wakeLock = undefined;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  metro.resume();
  if (role === 'listener') burstPing();
  render();
});

// ---------- controls ----------
$('play').addEventListener('click', () => {
  metro.unlock();
  change({ playing: !current().playing });
});

document.querySelectorAll<HTMLElement>('[data-bpm]').forEach((b) =>
  b.addEventListener('click', () => setBpm(current().bpm + Number(b.dataset.bpm))),
);
$<HTMLInputElement>('bpmRange').addEventListener('input', (e) => setBpm(Number((e.target as HTMLInputElement).value)));

document.querySelectorAll<HTMLElement>('[data-beats]').forEach((b) =>
  b.addEventListener('click', () => change({ beatsPerBar: clamp(current().beatsPerBar + Number(b.dataset.beats), 1, 12) })),
);
document.querySelectorAll<HTMLElement>('[data-sub]').forEach((b) =>
  b.addEventListener('click', () => change({ subdivision: Number(b.dataset.sub) })),
);

// Beat dots: host cycles accent → normal → silent; listeners mute beats locally.
beatsEl.addEventListener('click', (e) => {
  const i = Number((e.target as HTMLElement).closest<HTMLElement>('.beat')?.dataset.i);
  if (Number.isNaN(i)) return;
  if (role === 'listener') {
    if (!metro.muted.delete(i)) metro.muted.add(i);
    render();
  } else {
    const accents = [...current().accents];
    accents[i] = ((accents[i] + 2) % 3) as Accent;
    change({ accents });
  }
});

let taps: number[] = [];
$('tap').addEventListener('pointerdown', (e) => {
  if (taps.length && e.timeStamp - taps[taps.length - 1] > 2000) taps = [];
  taps = [...taps, e.timeStamp].slice(-5);
  if (taps.length > 1) setBpm(60000 / ((taps[taps.length - 1] - taps[0]) / (taps.length - 1)));
});

document.addEventListener('keydown', (e) => {
  if (role === 'listener' || (e.target as HTMLElement).matches('input, textarea, dialog *')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    $('play').click();
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowRight') setBpm(current().bpm + 1);
  if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') setBpm(current().bpm - 1);
});

// ---------- session controls ----------
$('host').addEventListener('click', () => startHost());
$('end').addEventListener('click', leave);
$('leave').addEventListener('click', leave);

$('share').addEventListener('click', async () => {
  const url = shareUrl();
  if (navigator.share) return navigator.share({ title: 'ClickSync', text: `Join my ClickSync session ${code}`, url }).catch(() => {});
  await navigator.clipboard.writeText(url);
  $('share').textContent = 'Link copied';
  setTimeout(() => ($('share').textContent = 'Share link'), 1500);
});

const joinDialog = $<HTMLDialogElement>('joinDialog');
function openJoin(roomCode: string) {
  if (role !== 'solo') return;
  $('joinCode').textContent = roomCode;
  $<HTMLInputElement>('joinName').value = prefs.name;
  joinDialog.showModal();
}

$('joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const c = $<HTMLInputElement>('code').value.trim().toUpperCase();
  if (c.length === 5) openJoin(c);
  else $('code').focus();
});
$('joinDialogForm').addEventListener('submit', () => {
  prefs.name = $<HTMLInputElement>('joinName').value.trim();
  save();
  startListener($('joinCode').textContent!);
});
joinDialog.querySelector('[data-close]')!.addEventListener('click', () => joinDialog.close());

const routeCode = () => location.hash.match(/^#\/join\/([A-Z0-9]{5})$/i)?.[1].toUpperCase();
window.addEventListener('hashchange', () => {
  const c = routeCode();
  if (c) openJoin(c);
});

// ---------- settings ----------
const settings = $<HTMLDialogElement>('settings');
const volume = $<HTMLInputElement>('volume');
const latency = $<HTMLInputElement>('latency');
const profileSelect = $<HTMLSelectElement>('profile');
const flashToggle = $<HTMLInputElement>('flashToggle');

function renderSettings() {
  volume.value = String(prefs.volume);
  const ms = (v: number) => `${v > 0 ? '+' : ''}${v} ms`;
  profileSelect.replaceChildren(...prefs.profiles.map((p, i) => new Option(`${p.name} (${ms(p.latency)})`, String(i))));
  profileSelect.value = String(prefs.profile);
  $<HTMLButtonElement>('deleteProfile').disabled = prefs.profiles.length < 2;
  latency.value = String(profile().latency);
  $('latencyOut').textContent = ms(profile().latency);
  flashToggle.checked = prefs.flash;
  document.querySelectorAll<HTMLElement>('[data-sound]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.sound === prefs.sound));
  });
  $('reported').textContent = metro.unlocked ? `The browser reports ${metro.outputLatencyMs} ms, which is already included.` : '';
}

$('openSettings').addEventListener('click', () => {
  renderSettings();
  settings.showModal();
});
for (const d of [settings, joinDialog]) d.addEventListener('click', (e) => e.target === d && d.close());

volume.addEventListener('input', () => {
  prefs.volume = Number(volume.value);
  metro.setVolume(prefs.volume);
  save();
});
latency.addEventListener('input', () => setLatency(Number(latency.value)));
flashToggle.addEventListener('change', () => {
  prefs.flash = flashToggle.checked;
  save();
});
document.querySelectorAll<HTMLElement>('[data-sound]').forEach((b) =>
  b.addEventListener('click', () => {
    prefs.sound = metro.sound = b.dataset.sound as Sound;
    save();
    renderSettings();
  }),
);

function setLatency(ms: number) {
  profile().latency = clamp(Math.round(ms), -100, 400);
  applyProfile();
}

function applyProfile() {
  metro.latencyMs = profile().latency;
  save();
  renderSettings();
}

profileSelect.addEventListener('change', () => {
  prefs.profile = Number(profileSelect.value);
  applyProfile();
});
$('addProfile').addEventListener('click', () => {
  const name = prompt('Name these headphones, e.g. "AirPods"')?.trim();
  if (!name) return;
  prefs.profiles.push({ name: name.slice(0, 30), latency: 0 });
  prefs.profile = prefs.profiles.length - 1;
  applyProfile();
  $('tapResult').textContent = 'Now calibrate them with the tap test or the slider.';
});
$('deleteProfile').addEventListener('click', () => {
  if (prefs.profiles.length < 2 || !confirm(`Delete "${profile().name}"?`)) return;
  prefs.profiles.splice(prefs.profile, 1);
  prefs.profile = 0;
  applyProfile();
});

// Tap test: compare taps with the beats this device should be playing.
const TAPS_NEEDED = 10;
let calib: number[] = [];
const tapTest = $('tapTest');
tapTest.addEventListener('pointerdown', (e) => {
  if (!current().playing || !metro.playing) {
    $('tapResult').textContent = 'Start the click first, then tap along with it.';
    return;
  }
  const t = e.timeStamp - performance.now() + clock.now();
  let nearest = Infinity;
  for (let k = nextTick(segments, t - 2500); k && k.time < t + 2500; k = nextTick(segments, k.time)) {
    if (k.sub === 0 && Math.abs(k.time - t) < Math.abs(nearest - t)) nearest = k.time;
  }
  if (!Number.isFinite(nearest)) return;
  calib.push(t - nearest);
  if (calib.length < TAPS_NEEDED) {
    tapTest.textContent = `Keep tapping… ${TAPS_NEEDED - calib.length}`;
    return;
  }
  const sorted = calib.slice(2).sort((a, b) => a - b);
  const median = Math.round(sorted[Math.floor(sorted.length / 2)]);
  calib = [];
  setLatency(profile().latency + median);
  tapTest.textContent = 'Tap along to calibrate';
  $('tapResult').textContent = `Adjusted by ${median > 0 ? '+' : ''}${median} ms and saved to "${profile().name}". Fine-tune by ear with the slider.`;
});

// ---------- start ----------
render();
const savedHost = sessionStorage.getItem('hostCode');
if (savedHost) startHost(savedHost);
else if (routeCode()) openJoin(routeCode()!);

if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('./sw.js');
