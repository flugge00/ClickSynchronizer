// Thin wrapper around PeerJS so the rest of the app only sees send/join/leave/message.
// Swapping in another transport (Trystero, MQTT, ...) only touches this file.
import Peer, { type DataConnection } from 'peerjs';

const PREFIX = 'clicksync-v1-';
const CHECK_MS = 2000;
const LISTENER_TIMEOUT_MS = 6000; // no message from host -> reconnect
const HOST_TIMEOUT_MS = 10000; // no message from a listener -> drop it

export interface Events<M> {
  onReady?(): void;
  onJoin(id: string): void;
  onLeave(id: string): void;
  onMessage(msg: M, from: string): void;
  onError(type: string): void;
}

export interface Transport<M> {
  /** Sends to one peer, or to everyone when `to` is omitted. */
  send(msg: M, to?: string): void;
  close(): void;
}

interface Conn {
  conn: DataConnection;
  seen: number;
}

function keepOnline(peer: Peer) {
  peer.on('disconnected', () => setTimeout(() => !peer.destroyed && peer.reconnect(), 1000));
}

export function hostRoom<M>(code: string, ev: Events<M>): Transport<M> {
  const peer = new Peer(PREFIX + code);
  const conns = new Map<string, Conn>();
  keepOnline(peer);

  const drop = (id: string) => {
    const c = conns.get(id);
    if (!c) return;
    conns.delete(id);
    c.conn.close();
    ev.onLeave(id);
  };

  peer.on('open', () => ev.onReady?.());
  peer.on('error', (e) => ev.onError(e.type));
  peer.on('connection', (conn) => {
    conn.on('open', () => {
      conns.set(conn.peer, { conn, seen: Date.now() });
      ev.onJoin(conn.peer);
    });
    conn.on('data', (d) => {
      const c = conns.get(conn.peer);
      if (c) c.seen = Date.now();
      ev.onMessage(d as M, conn.peer);
    });
    conn.on('close', () => drop(conn.peer));
  });

  const timer = setInterval(() => {
    for (const [id, c] of conns) if (Date.now() - c.seen > HOST_TIMEOUT_MS) drop(id);
  }, CHECK_MS);

  return {
    send(msg, to) {
      for (const [id, c] of conns) if (!to || id === to) c.conn.send(msg);
    },
    close() {
      clearInterval(timer);
      peer.destroy();
    },
  };
}

/** Connects to a host and keeps reconnecting until closed. The host's id is "host". */
export function joinRoom<M>(code: string, ev: Events<M>): Transport<M> {
  const peer = new Peer();
  let current: Conn | undefined;
  keepOnline(peer);

  const connect = () => {
    if (peer.destroyed || !peer.open || current) return;
    const conn = peer.connect(PREFIX + code, { serialization: 'json' });
    const c: Conn = { conn, seen: Date.now() };
    current = c;
    conn.on('open', () => {
      c.seen = Date.now();
      ev.onJoin('host');
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

  peer.on('open', connect);
  peer.on('error', (e) => {
    ev.onError(e.type); // 'peer-unavailable' = host not found (yet)
    if (current && !current.conn.open) lost(current);
  });

  const timer = setInterval(() => {
    if (current && Date.now() - current.seen > LISTENER_TIMEOUT_MS) lost(current);
    connect();
  }, CHECK_MS);

  return {
    send(msg) {
      if (current?.conn.open) current.conn.send(msg);
    },
    close() {
      clearInterval(timer);
      peer.destroy();
    },
  };
}
