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
| [src/transport.ts](src/transport.ts) | PeerJS wrapper (swap this file to change the transport) |
| [src/main.ts](src/main.ts) | App state and UI |

## Develop

```sh
npm install
npm run dev      # http://localhost:5173 (also on your LAN with --host)
npm run build    # typecheck + build to dist/
```

## Deploy

Every push to `main` builds and publishes the app with [.github/workflows/deploy.yml](.github/workflows/deploy.yml). One-time setup: in the repository, go to **Settings → Pages → Source** and select **GitHub Actions**.

## Tips for rehearsals

- Put all phones on the same Wi-Fi (or the host's hotspot).
- Use wired headphones. Bluetooth adds 150–300 ms, so calibrate those devices with the tap test or the slider.
- Keep screens on. The app holds a wake lock, but the clicks stop if a phone is locked.
