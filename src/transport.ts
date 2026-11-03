// Thin wrapper around PeerJS so the rest of the app only sees send/join/leave/message.
// Swapping in another transport (Trystero, MQTT, ...) only touches this file.
import Peer, { type DataConnection } from 'peerjs';
import { getIceServers } from './ice';

const PREFIX = 'clicksync-v1-';
const CHECK_MS = 2000;
const LISTENER_TIMEOUT_MS = 6000; // no message from host -> reconnect
const CONNECT_TIMEOUT_MS = 20000; // a connection that is still opening (maybe via TURN) gets longer
const HOST_TIMEOUT_MS = 10000; // no message from a listener -> drop it

/** How a connection is routed: straight between the devices, or relayed through the TURN server. */
export type Path = 'direct' | 'relay';

export interface Events<M> {
  onReady?(): void;
  onJoin(id: string): void;
  onLeave(id: string): void;
  onMessage(msg: M, from: string): void;
  onError(type: string): void;
  /** Called when a connection's route is first known, and again if it changes. */
  onPath?(id: string, path: Path): void;
}

export interface Transport<M> {
  /** Sends to one peer, or to everyone when `to` is omitted. */
  send(msg: M, to?: string): void;
  close(): void;
}

interface Conn {
  conn: DataConnection;
  seen: number;
  path?: Path;
}

/** Reads the selected ICE candidate pair: if either end is a TURN "relay" candidate, traffic is relayed. */
async function connectionPath(pc: RTCPeerConnection | undefined): Promise<Path | undefined> {
  try {
    if (!pc) return undefined;
    const stats = await pc.getStats();
    let pair: any;
    stats.forEach((s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
    });
    // Firefox/older browsers: no transport.selectedCandidatePairId.
    if (!pair) {
      stats.forEach((s) => {
        if (s.type === 'candidate-pair' && (s.selected || (s.nominated && s.state === 'succeeded'))) pair = s;
      });
    }
    if (!pair) return undefined;
    const types = [pair.localCandidateId, pair.remoteCandidateId].map((id) => stats.get(id)?.candidateType);
    if (!types.every(Boolean)) return undefined;
    return types.includes('relay') ? 'relay' : 'direct';
  } catch {
    return undefined;
  }
}

/** Re-checks the route of one connection and reports it when it is new or has changed. */
async function probe(id: string, c: Conn, report?: (id: string, path: Path) => void) {
  const path = await connectionPath(c.conn.peerConnection);
  if (path && path !== c.path && c.conn.open) {
    c.path = path;
    report?.(id, path);
  }
}

function keepOnline(peer: Peer) {
  peer.on('disconnected', () => setTimeout(() => !peer.destroyed && peer.reconnect(), 1000));
}

/** Our own ICE servers (STUN + Cloudflare TURN) replace PeerJS's defaults, whose TURN hosts no longer exist. */
const peerOptions = (iceServers: RTCIceServer[]) => ({ config: { iceServers, sdpSemantics: 'unified-plan' } });

export function hostRoom<M>(code: string, ev: Events<M>): Transport<M> {
  let peer: Peer | undefined;
  let closed = false;
  const conns = new Map<string, Conn>();

  const drop = (id: string) => {
    const c = conns.get(id);
    if (!c) return;
    conns.delete(id);
    c.conn.close();
    ev.onLeave(id);
  };

  getIceServers().then((iceServers) => {
    if (closed) return;
    const p = (peer = new Peer(PREFIX + code, peerOptions(iceServers)));
    keepOnline(p);
    p.on('open', () => ev.onReady?.());
    p.on('error', (e) => ev.onError(e.type));
    p.on('connection', (conn) => {
      conn.on('open', () => {
        const c: Conn = { conn, seen: Date.now() };
        conns.set(conn.peer, c);
        ev.onJoin(conn.peer);
        probe(conn.peer, c, ev.onPath);
      });
      conn.on('data', (d) => {
        const c = conns.get(conn.peer);
        if (c) c.seen = Date.now();
        ev.onMessage(d as M, conn.peer);
      });
      conn.on('close', () => drop(conn.peer));
    });
  });

  const timer = setInterval(() => {
    for (const [id, c] of conns) {
      if (Date.now() - c.seen > HOST_TIMEOUT_MS) drop(id);
      else probe(id, c, ev.onPath);
    }
  }, CHECK_MS);

  return {
    send(msg, to) {
      for (const [id, c] of conns) if (!to || id === to) c.conn.send(msg);
    },
    close() {
      closed = true;
      clearInterval(timer);
      peer?.destroy();
    },
  };
}

/** Connects to a host and keeps reconnecting until closed. The host's id is "host". */
export function joinRoom<M>(code: string, ev: Events<M>): Transport<M> {
  let peer: Peer | undefined;
  let closed = false;
  let current: Conn | undefined;

  const connect = () => {
    if (!peer || peer.destroyed || !peer.open || current) return;
    const conn = peer.connect(PREFIX + code, { serialization: 'json' });
    const c: Conn = { conn, seen: Date.now() };
    current = c;
    conn.on('open', () => {
      c.seen = Date.now();
      ev.onJoin('host');
      probe('host', c, ev.onPath);
    });
    conn.on('data', (d) => {
      c.seen = Date.now();
      ev.onMessage(d as M, 'host');
    });
    conn.on('close', () => lost(c));
  };

  const lost = (c: Conn) => {
    if (current !== c) return;
    current = undefined;
    c.conn.close();
    ev.onLeave('host');
  };

  getIceServers().then((iceServers) => {
    if (closed) return;
    const p = (peer = new Peer(peerOptions(iceServers)));
    keepOnline(p);
    p.on('open', connect);
    p.on('error', (e) => {
      ev.onError(e.type); // 'peer-unavailable' = host not found (yet)
      if (current && !current.conn.open) lost(current);
    });
  });

  const timer = setInterval(() => {
    if (current && Date.now() - current.seen > (current.conn.open ? LISTENER_TIMEOUT_MS : CONNECT_TIMEOUT_MS)) lost(current);
    else if (current?.conn.open) probe('host', current, ev.onPath);
    connect();
  }, CHECK_MS);

  return {
    send(msg) {
      if (current?.conn.open) current.conn.send(msg);
    },
    close() {
      closed = true;
      clearInterval(timer);
      peer?.destroy();
    },
  };
}
