# ClickSync — Plan

A web-based metronome that lets a group of musicians (about 15, ideally no hard limit) practise to the **same, tightly synced click track**, each on their own phone with their own headphones. No shared audio device and no backend of our own. Hosted as a static site on GitHub Pages (or GitLab Pages; for this project they work the same).

---

## 1. Short answer: is it feasible on GitHub/GitLab Pages?

**Yes, with one caveat.** Pages only serves static files, so it can't run a server that relays messages between phones. Browsers can still talk to each other directly with **WebRTC data channels** (peer-to-peer). The only thing WebRTC needs from outside is a short **signaling** handshake so two devices can find each other. That handshake can use a free public service, so we never run our own backend:

| Piece | What it does | Free option (no own server) |
|---|---|---|
| Static hosting | Serves the HTML/JS app | GitHub Pages / GitLab Pages |
| Signaling | Introduces the phones to each other (only at connect time) | PeerJS public cloud server, or Trystero (uses public Nostr / BitTorrent trackers / MQTT brokers) |
| STUN | Helps phones find their public address | Google / Cloudflare public STUN servers |
| TURN (optional) | Relays traffic when a direct P2P connection is blocked | Metered.ca or Cloudflare free tier (needed only on restrictive networks) |

So your preferred design, **one "main" device controlling everything while the others just listen**, works fine.

### The important insight: don't send "click now" events

If the main device sent a message on every beat ("click!"), every phone would play it late by a different, changing network delay (often 10–200 ms of jitter). Musicians hear that as sloppy. **Live event sending alone won't give tight sync.**

Instead we **combine your two ideas**:

1. **Clock sync** (from idea 2): each listener measures the offset between its clock and the host's clock with NTP-style ping-pong over the data channel, and keeps repeating it.
2. **Live control** (from idea 1): the host doesn't send clicks. It sends a **schedule**, e.g. *"120 BPM, 4/4, bar 1 beat 1 starts at host time T"*. Each phone converts T to its own clock and plays every click itself with the Web Audio API's sample-accurate scheduler.
3. Any change (tempo, start, stop, time signature) is sent as a new schedule that takes effect at a **future** moment, such as the next downbeat at least ~300 ms ahead. By then every phone has the message, so network latency doesn't matter at all.

A useful side effect: if the host's connection drops, listeners **keep playing in sync**, because they already have the schedule.

---

## 2. Sync accuracy: what to expect and what limits it

| Source of error | Typical size | Mitigation |
|---|---|---|
| Network jitter | 10–200 ms | Irrelevant because events are scheduled ahead |
| Clock offset estimate | 1–5 ms on good Wi-Fi | Many ping samples; keep the lowest-RTT ones; median filter |
| Clock drift between devices | ~1–3 ms per minute | Re-sync every few seconds; smooth corrections (no jumps) |
| **Audio output latency per device** | 5–50 ms wired, **150–300 ms Bluetooth** | Use `AudioContext.outputLatency` where available, plus a **manual per-device latency offset** (calibration screen). Strongly recommend **wired headphones**. |
| Background tab / screen off | Clicks stop or stutter | Wake Lock API keeps the screen on; warn the user |

Target: **under ~10 ms** between devices with wired headphones. Most players won't notice a difference below ~15–20 ms.

**Bluetooth headphones are the biggest real-world risk.** Their latency is large, varies between models, and browsers often don't report it correctly. The calibration feature (section 5) is therefore a core feature, not a nice-to-have.

---

## 3. Architecture

```
            ┌──────────────── Signaling (public, connect-time only) ────────────────┐
            │                                                                        │
     ┌──────▼──────┐   WebRTC data channel (clock pings + schedule msgs)   ┌────────▼───────┐
     │  HOST phone │ ◄───────────────────────────────────────────────────► │ Listener phone │ × N
     │ (controls)  │                                                       │  (plays only)  │
     └──────┬──────┘                                                       └────────┬───────┘
            │ Web Audio scheduler                                                   │ Web Audio scheduler
            ▼                                                                       ▼
        🎧 click                                                                🎧 click
```

- **Topology:** star. The host holds one data channel per listener, and listeners don't connect to each other. 15 listeners is trivial; the messages are tiny and infrequent (pings every 1–5 s, schedule changes only when something changes). A star should scale to roughly 30–60 listeners per host.
- **"No limit" path (later):** for very large groups, add relay listeners (a listener forwards the schedule to a few others, forming a tree), or swap the transport for a pub/sub relay. Clock sync can be done against any already-synced peer.
- **Transport abstraction:** hide the networking behind a small interface (`send`, `onMessage`, `onPeerJoin`, `onPeerLeave`) so PeerJS can later be swapped for Trystero, MQTT, Firebase, etc. without touching the metronome or sync code.

### Recommended stack

- **Vite + TypeScript**, built to static files
- **UI:** vanilla TS or a tiny framework (Preact or Svelte). The UI is small.
- **Networking:** **PeerJS** for the MVP (simple, works well for a star, free public signaling). Keep Trystero as plan B if the PeerJS cloud is unreliable.
- **Audio:** Web Audio API with a "lookahead scheduler" (a timer every ~25 ms schedules all clicks in the next ~100–200 ms using `osc.start(exactTime)`). Synthesised clicks or short preloaded samples.
- **QR codes:** client-side generation (e.g. the `qrcode` npm package)
- **PWA:** manifest + service worker, so the app can be installed to the home screen and loads offline (the network is still needed for group sync)
- **Deploy:** GitHub Actions workflow that builds and publishes to GitHub Pages (or `.gitlab-ci.yml` for GitLab Pages)

---

## 4. Protocol (messages over the data channel)

All times are in **host clock milliseconds** (`performance.timeOrigin + performance.now()` on the host).

```jsonc
// Clock sync (listener ↔ host), repeated: burst of ~10 at join, then every 2–5 s
{ "t": "ping", "id": 42, "c0": 123456.78 }                         // listener → host
{ "t": "pong", "id": 42, "c0": 123456.78, "h": 987654.32 }          // host → listener
// listener computes: rtt = c1 - c0, offset = h - (c0 + c1) / 2 ; keep low-RTT samples

// State / schedule (host → listeners), sent on change + on join + periodically as a heartbeat
{
  "t": "state",
  "rev": 7,                 // increasing revision number, so stale messages are ignored
  "playing": true,
  "bpm": 120,
  "beatsPerBar": 4,
  "subdivision": 1,         // 1 = quarters, 2 = eighths, ...
  "accentPattern": [1,0,0,0],
  "anchorHostTime": 987999.0,  // host time when beat index 0 happens
  "anchorBeat": 0           // beat index at the anchor (allows tempo changes mid-song)
}
```

Listener logic: `localTime = hostTime - offset`. Map that to `AudioContext.currentTime` with `audioCtx.getOutputTimestamp()` (pairs the audio clock with `performance.now()`), subtract the device's output latency plus the manual calibration offset, then schedule the clicks.

Tempo change: the host picks the next bar boundary at least ~300 ms in the future, computes the new anchor so the beat grid stays continuous, and broadcasts it. All devices switch at exactly the same beat.

---

## 5. Features

### MVP (v1)
- **Solo metronome** that works without any connection: BPM (30–300), tap tempo, time signature, accent on beat 1, volume, click sound.
- **Create session (host):** generates a short room code (e.g. 4–6 characters), a share link (`…/#/join/AB12`), and a QR code.
- **Join session (listener):** open the link, scan the QR code, or type the code. Tap "Join & enable audio" (browsers require a user tap before audio can play).
- **Host controls:** start/stop, BPM, time signature, accents. Listeners see the controls read-only.
- **Sync status per listener:** the host sees a list of connected players with their estimated sync quality (RTT / offset stability). Listeners see a "Synced ✓ / Syncing… / Disconnected" badge.
- **Latency calibration:** a per-device offset slider (± ms), saved in localStorage, plus a guided "tap along to the click" test to estimate it. The host can also play a visual flash alongside the audio to help compare.
- **Keep screen awake** (Wake Lock API) while a session is active.
- **Resilience:** listeners keep playing if the host drops; they auto-reconnect and re-sync.

### v2 ideas
- Count-in bars, and a "start at bar N" option
- Setlists / tempo maps (song with tempo changes and time-signature changes)
- Hand over host role to another device
- Visual beat indicator (big flashing screen for drummers / conductor view)
- Relay/tree mode for very large groups
- Optional "offline link" mode (see section 6)

---

## 6. Fallback: the one-time timestamp link (your idea 2) - Skip for now

Worth keeping as a **secondary mode**, but not as the main solution, because:

- It relies on each phone's wall clock (`Date.now()`). Phones are usually NTP-synced, but only to within ~10–100+ ms of each other, which is audibly off for a click track.
- There's no live control: any tempo change needs a new link or code.

Where it's useful: when WebRTC is blocked (strict corporate or school Wi-Fi with client isolation and no TURN). Encode `{bpm, sig, startEpochMs}` in the link or QR code, and give listeners **"nudge −/+ 5 ms" buttons** to align by ear. Low priority: build it after the main mode works.

---

## 7. Known risks and platform gotchas

| Risk | Impact | Plan |
|---|---|---|
| **iOS silent switch** mutes Web Audio | No sound on iPhones in silent mode | Set `navigator.audioSession.type = "playback"` (Safari 17+) and fall back to the "play a silent `<audio>` element on first tap" trick; show a hint |
| **Autoplay policy** | Audio can't start without a user tap | A clear "Tap to enable audio" button before joining |
| **Screen lock / backgrounding** | Timers get throttled and clicks stop | Wake Lock API; a warning banner; re-sync instantly when the tab is visible again |
| **Bluetooth latency** | 150–300 ms late | Calibration offset, a recommendation for wired headphones, detection where possible |
| **Wi-Fi client isolation / symmetric NAT** | P2P connection fails | STUN plus an optional free TURN server; show a clear error and suggest a phone hotspot; fallback mode from section 6 |
| **Public signaling server downtime** | Can't start new sessions (running ones are unaffected) | Transport abstraction; Trystero (multiple redundant strategies) as backup |
| **Room code collisions** | Two groups pick the same code | Prefix codes with an app namespace, use 5–6 characters, and detect "ID taken" errors and regenerate |
| **Host phone sleeps** | Control is lost (the clicks continue) | Wake Lock on the host; auto-reconnect |

Practical tip for rehearsals: all phones on the **same Wi-Fi network** (or the host's hotspot) gives the lowest and most stable RTT, and so the best clock sync.

---

## 8. Implementation phases

1. **Project setup:** Vite + TS, lint, GitHub Actions deploy to Pages, PWA manifest.
2. **Solo metronome:** Web Audio lookahead scheduler, UI, tap tempo. *Verify: stable timing over 10+ minutes, no drift against a reference.*
3. **Transport layer:** PeerJS wrapper, host creates a room, listeners join by code, link or QR. *Verify: 15 browser tabs or devices connected at once.*
4. **Clock sync:** ping/pong, offset filtering, continuous re-sync, sync-quality display. *Verify: the offset estimate stays stable within a few ms on Wi-Fi.*
5. **Scheduled playback:** state messages, anchor-based beat grid, tempo changes on bar boundaries, playback continues on disconnect.
6. **Calibration and mobile hardening:** latency offset UI, tap test, Wake Lock, iOS audio session, reconnect logic.
7. **Real-world test:** 5–15 actual phones (iOS + Android, wired + Bluetooth). Record all phones with one microphone and measure the offsets in an audio editor (e.g. Audacity).
8. **Polish and v2 features**, plus the optional timestamp-link fallback.

---

## 9. Open questions

- GitHub Pages or GitLab Pages? (Either works; this decides which CI file to write.)
  Answer: GitHub Pages
- Should listeners be able to change their **own** volume or sound (surely yes) or even mute specific beats?
  Answer: Yes
- Do you need count-ins and setlists in v1, or is plain tempo + time signature enough to start?
  Answer: Enough with tempo + time signature in v1.
- Is it acceptable to rely on a free third-party signaling service (PeerJS cloud), or would you rather add a tiny free-tier relay (e.g. a Cloudflare Worker) later for reliability?
  Answer: Free third-party is okay.