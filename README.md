# ClickSync

A metronome that keeps a whole group on the **same, tightly synced click**, each musician on their own phone and headphones. It is a static web app (GitHub Pages) with no backend of its own.

## How it works

- **One host, many listeners.** The host connects to each listener over a WebRTC data channel (PeerJS). The free PeerJS cloud is used only to introduce the devices to each other.
- **Clock sync, not "click now" messages.** Each listener estimates the host's clock with NTP-style ping/pong every 2 s. It uses the lowest-RTT samples and takes their median.
- **Scheduled beat grid.** The host sends a short list of segments (`bpm`, meter, subdivision, accents, start time in host-clock ms). A change takes effect on the next downbeat at least 400 ms ahead, so every device switches on the same beat. Each device plays its own clicks with the Web Audio scheduler.
- **Resilient.** If the host drops, listeners keep playing the grid they already have, and they reconnect automatically. If the host reloads, it reclaims its session code.
- **Latency calibration.** Each device has a latency-offset slider and a tap-along test. The output latency the browser reports is already taken into account.

| File | Role |
|---|---|
| [src/grid.ts](src/grid.ts) | Pure beat-grid math: next tick, change points, segments |
| [src/metronome.ts](src/metronome.ts) | Web Audio lookahead scheduler and click sounds |
| [src/clock.ts](src/clock.ts) | Clock-offset estimation |
| [src/transport.ts](src/transport.ts) | PeerJS wrapper and connection-route detection (swap this file to change the transport) |
| [src/ice.ts](src/ice.ts) | Fetches TURN credentials from the Worker, with STUN fallback |
| [worker/turn-worker.js](worker/turn-worker.js) | Cloudflare Worker that issues TURN credentials |
| [src/main.ts](src/main.ts) | App state and UI |

## Develop

```sh
npm install
npm run dev      # http://localhost:5173 (also on your LAN with --host)
npm run build    # typecheck + build to dist/
```

## Deploy

Every push to `main` builds and publishes the app with [.github/workflows/deploy.yml](.github/workflows/deploy.yml). One-time setup: in the repository, go to **Settings → Pages → Source** and select **GitHub Actions**.

## Deploying the TURN Worker

Most phones connect straight to each other. On some networks (school or office Wi-Fi, some mobile carriers) that is blocked, and the traffic has to go through a **TURN relay**. ClickSync uses Cloudflare's free TURN service. The TURN secret must not live in the web app, so a tiny Cloudflare Worker ([worker/turn-worker.js](worker/turn-worker.js)) hands out short-lived credentials.

Without the Worker the app still works, using STUN only. Devices that can't connect directly then fail to join.

1. In the Cloudflare dashboard, go to **Realtime → TURN** and create a TURN key. Note the **Token ID** and the **API token**. Keep them out of git. `TURN_SERVER_KEYS.md` is gitignored for this purpose.
2. Go to **Workers & Pages → Create → Worker**, paste in [worker/turn-worker.js](worker/turn-worker.js) and deploy.
3. In the Worker's **Settings → Variables and Secrets**, add these as secrets: `TURN_KEY_ID` (the Token ID) and `TURN_KEY_API_TOKEN` (the API token).
4. Point the app at your Worker. Edit the default in [src/ice.ts](src/ice.ts), or set `VITE_TURN_URL` at build time, for example `VITE_TURN_URL=https://your-worker.workers.dev npm run build`.
5. **Custom domain or fork?** The Worker only answers requests from `https://flugge00.github.io` and local dev addresses (`localhost`, `192.168.x.x`, `10.x.x.x`). For any other site, add a plain variable `ALLOWED_ORIGINS` to the Worker, e.g. `https://metronome.example.com` (comma-separated for several). Otherwise the request is refused and the app silently falls back to STUN only.

The app asks the Worker once per device per day and caches the credentials in `localStorage`.

### Relay indicator

Each connection shows a small pill: **Direct** (straight between devices, lowest delay) or **Relay** (through Cloudflare, which adds some delay and jitter). The host sees one per listener, and a listener sees its own. If many listeners show Relay and sync looks loose, try another network or the host's hotspot.

## Tips for rehearsals

- Put all phones on the same Wi-Fi (or the host's hotspot).
- Use wired headphones. Bluetooth adds 150–300 ms, so calibrate those devices with the tap test or the slider.
- Mute is remembered on each device, and the host sees who is muted.
- Keep screens on. The app holds a wake lock, but the clicks stop if a phone is locked.
