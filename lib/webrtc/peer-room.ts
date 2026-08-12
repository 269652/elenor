'use client';

/**
 * [DEFAULT — WebRTC P2P play] Thin transport layer over PeerJS — connection lifecycle only, zero
 * game-engine knowledge (see protocol.ts's file header for the overall design). This module never
 * calls engine/reducer.ts; hooks/use-p2p-host.ts and hooks/use-p2p-join.ts own that policy and
 * just hand this module P2PMessage values to move around.
 *
 * peerjs is dynamically imported (not a top-level import) so this file never pulls real
 * WebRTC/RTCPeerConnection code into anything that could end up in a server bundle — every
 * exported function here is only ever called from a 'use client' component after mount.
 *
 * Signaling: PeerJS's zero-config default points at its free public cloud broker (0.peerjs.com) —
 * see protocol.ts's header for why that satisfies "no servers to host" while still being a real,
 * if free and third-party, always-on signaling relay. NAT traversal uses PeerJS's default STUN
 * server list; no TURN is configured, so two peers both behind a strict/symmetric NAT (uncommon,
 * but real — corporate networks, some carrier-grade NAT) may fail to establish a direct
 * connection. onError below surfaces that as a plain "couldn't connect" message.
 */

import type { DataConnection, MediaConnection, Peer, PeerError, PeerErrorType } from 'peerjs';
import type { JoinerMetadata, LobbyPlayerInfo, P2PMessage, ResumeLobbyPlayerInfo } from './protocol';
import { generateRoomCode, roomCodeToPeerId } from './protocol';

async function loadPeerJs() {
  const mod = await import('peerjs');
  return mod.Peer;
}

type PeerCtorOptions = {
  host?: string;
  port?: number;
  path?: string;
  secure?: boolean;
  key?: string;
  config?: RTCConfiguration;
};

function normalizePath(path: string | undefined): string {
  if (!path || path.trim() === '') return '/peerjs';
  return path.startsWith('/') ? path : `/${path}`;
}

function parseSignalingEntry(raw: string): PeerCtorOptions | null {
  const value = raw.trim();
  if (!value) return null;

  // URL form, e.g. "https://peer.example.com/peerjs" or "wss://peer.example.com/peerjs"
  if (value.includes('://')) {
    try {
      const url = new URL(value);
      const secure = url.protocol === 'https:' || url.protocol === 'wss:';
      const port = url.port ? Number(url.port) : secure ? 443 : 80;
      return {
        host: url.hostname,
        port,
        path: normalizePath(url.pathname),
        secure,
      };
    } catch {
      return null;
    }
  }

  // Host form, e.g. "peer.example.com:443/peerjs" or "peer.example.com".
  const match = value.match(/^([^:/\s]+)(?::(\d+))?(\/[^\s]*)?$/);
  if (!match) return null;
  const host = match[1];
  const port = match[2] ? Number(match[2]) : 443;
  const path = normalizePath(match[3]);
  return { host, port, path, secure: true };
}

function dedupeCandidates(candidates: PeerCtorOptions[]): PeerCtorOptions[] {
  const seen = new Set<string>();
  const out: PeerCtorOptions[] = [];
  for (const c of candidates) {
    const key = `${c.secure ?? true}|${c.host ?? ''}|${c.port ?? ''}|${normalizePath(c.path)}|${c.key ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...c, path: normalizePath(c.path) });
  }
  return out;
}

function defaultIceConfig(): RTCConfiguration {
  const envUrls = process.env.NEXT_PUBLIC_PEERJS_ICE_SERVERS;
  const urls = envUrls
    ? envUrls
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'];

  const turnUsername = process.env.NEXT_PUBLIC_PEERJS_TURN_USERNAME;
  const turnCredential = process.env.NEXT_PUBLIC_PEERJS_TURN_CREDENTIAL;
  if (turnUsername && turnCredential) {
    return {
      iceServers: [{ urls }, { urls, username: turnUsername, credential: turnCredential }],
    };
  }
  return { iceServers: [{ urls }] };
}

function signalingCandidates(): PeerCtorOptions[] {
  // Ordered fallback list. Accepts comma-separated entries in either URL or host form, e.g.:
  // NEXT_PUBLIC_PEERJS_SIGNALING_SERVERS="https://peer-a.example.com/peerjs,https://peer-b.example.com/peerjs"
  // or "peer-a.example.com:443/peerjs,peer-b.example.com:443/peerjs"
  const envList = process.env.NEXT_PUBLIC_PEERJS_SIGNALING_SERVERS;
  const envHost = process.env.NEXT_PUBLIC_PEERJS_HOST;
  const envPort = process.env.NEXT_PUBLIC_PEERJS_PORT ? Number(process.env.NEXT_PUBLIC_PEERJS_PORT) : undefined;
  const envPath = process.env.NEXT_PUBLIC_PEERJS_PATH;
  const envSecure = process.env.NEXT_PUBLIC_PEERJS_SECURE ? process.env.NEXT_PUBLIC_PEERJS_SECURE === 'true' : undefined;
  const envKey = process.env.NEXT_PUBLIC_PEERJS_KEY;
  const iceConfig = defaultIceConfig();

  const candidates: PeerCtorOptions[] = [];
  if (envList) {
    for (const raw of envList.split(',')) {
      const parsed = parseSignalingEntry(raw);
      if (parsed) candidates.push({ ...parsed, config: iceConfig });
    }
  }
  // Legacy single-endpoint envs still supported.
  if (envHost) {
    candidates.push({ host: envHost, port: envPort, path: normalizePath(envPath), secure: envSecure ?? true, key: envKey, config: iceConfig });
  }
  // Built-ins: PeerJS cloud + path variant.
  candidates.push({ host: '0.peerjs.com', port: 443, path: '/peerjs', secure: true, config: iceConfig });
  candidates.push({ host: '0.peerjs.com', port: 443, path: '/', secure: true, config: iceConfig });
  return dedupeCandidates(candidates);
}

function isSignalingTransportError(type: `${PeerErrorType}`): boolean {
  return type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed';
}

export interface PeerRoomHandle {
  /** This device's own PeerJS id — the room code itself for a host, a random broker-assigned id
   *  for a joiner (joiners are never dialed INTO by id, so it doesn't need to be memorable). */
  selfId: string;
  /** Host use: push a message to one specific joiner. */
  send(toPeerId: string, message: P2PMessage): void;
  /** Host use: push a message to every currently-connected joiner. */
  broadcast(message: P2PMessage): void;
  /** Joiner use: push a message to the host. No-ops (silently) if the host connection isn't open
   *  yet — callers gate on onOpen firing first. */
  sendToHost(message: P2PMessage): void;
  /** [DEFAULT — direct request: "kick a player"] Host use: closes ONE joiner's connection without
   *  tearing down the room for anyone else — unlike close() below, which tears down everything.
   *  Callers should `send(toPeerId, {kind:'kicked', ...})` first and give it a moment to actually
   *  reach the wire (see hooks/use-p2p-host.ts's kickPlayer) before calling this, same reasoning
   *  as hostTransferring's own send-then-close ordering. No-op for a joiner's own handle (a
   *  joiner has no other peers to disconnect) — matches send/broadcast's existing no-op symmetry
   *  on that side. */
  disconnectPeer(peerId: string): void;
  /** Voice chat: start a direct media call to another peer id. */
  callPeer(peerId: string, stream: MediaStream): MediaConnection | null;
  /** Voice chat: listen for incoming direct media calls. Returns an unsubscribe. */
  onIncomingCall(listener: (peerId: string, call: MediaConnection) => void): () => void;
  /** Tears down every connection and the underlying Peer. Always call on unmount. */
  close(): void;
}

function friendlyPeerError(err: PeerError<`${PeerErrorType}`>): string {
  switch (err.type) {
    case 'peer-unavailable':
      return "Room not found — check the code, or the host hasn't opened it yet.";
    case 'unavailable-id':
      return 'That room code is already in use.';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      return "Couldn't reach the signaling server — check your connection and try again.";
    case 'browser-incompatible':
      return "This browser doesn't support the WebRTC features P2P play needs.";
    default:
      return err.message || 'Connection error.';
  }
}

export interface HostRoomHandlers {
  /** A joiner's DataConnection finished opening — metadata is whatever they passed to
   *  peer.connect(hostId, { metadata }) in connectAsJoiner, i.e. their name/color/stable id. */
  onJoinerConnected: (peerId: string, metadata: JoinerMetadata) => void;
  onJoinerMessage: (peerId: string, message: P2PMessage) => void;
  onJoinerDisconnected: (peerId: string) => void;
  onFatalError: (message: string) => void;
}

/** How many times to retry the EXACT SAME room code on an `unavailable-id` collision before
 *  giving up on it and falling back to a fresh one. [DEFAULT — direct request: "if the host
 *  reloads the tab it should be restored .. and let the clients reconnect"] A host reload
 *  destroys the old Peer object client-side, but the PeerJS broker (0.peerjs.com) doesn't
 *  necessarily notice the old connection is gone instantly — a fast reload reopening the SAME
 *  code can transiently collide with its own, now-dead, prior session. Retrying the same code
 *  short-term lets that resolve itself; immediately falling back to a random new code (the old
 *  behavior) would silently abandon the room's address, stranding every client's own reconnect
 *  loop (hooks/use-p2p-join.ts) retrying a code the host is no longer listening on.
 *  SAME_CODE_RETRY_DELAY_MS below is the gap between each attempt. */
const SAME_CODE_RETRY_ATTEMPTS = 4;
const SAME_CODE_RETRY_DELAY_MS = 750;
const SIGNALING_RETRY_ATTEMPTS = 4;
const SIGNALING_RETRY_DELAY_MS = 900;

/** Opens this device as the host of `roomCode` — creates a Peer whose id IS the room code (see
 *  protocol.ts's roomCodeToPeerId) so joiners can dial straight in with nothing but the code.
 *  On an id collision, retries the SAME code up to SAME_CODE_RETRY_ATTEMPTS times (see its own
 *  comment) before falling back once to a freshly generated code (astronomically unlikely to
 *  ALSO collide) — resolves with whatever code actually won, which may differ from the one
 *  passed in; callers should always display the RESOLVED code, not the one they asked for. */
export async function connectAsHost(roomCode: string, handlers: HostRoomHandlers): Promise<PeerRoomHandle & { roomCode: string }> {
  const PeerCtor = await loadPeerJs();
  const connections = new Map<string, DataConnection>();
  const callListeners = new Set<(peerId: string, call: MediaConnection) => void>();
  const candidates = signalingCandidates();

  async function open(
    code: string,
    sameCodeAttemptsLeft: number,
    candidateIndex = 0,
    transportRetriesLeft = SIGNALING_RETRY_ATTEMPTS
  ): Promise<{ peer: Peer; roomCode: string }> {
    const candidate = candidates[Math.min(candidateIndex, candidates.length - 1)];
    return new Promise((resolve, reject) => {
      const peer = new PeerCtor(roomCodeToPeerId(code), candidate);
      const onOpen = () => {
        peer.off('error', onError);
        resolve({ peer, roomCode: code });
      };
      const onError = (err: PeerError<`${PeerErrorType}`>) => {
        peer.off('open', onOpen);
        peer.destroy();
        if (isSignalingTransportError(err.type)) {
          if (transportRetriesLeft > 0) {
            setTimeout(
              () => open(code, sameCodeAttemptsLeft, candidateIndex, transportRetriesLeft - 1).then(resolve, reject),
              SIGNALING_RETRY_DELAY_MS
            );
            return;
          }
          if (candidateIndex + 1 < candidates.length) {
            open(code, sameCodeAttemptsLeft, candidateIndex + 1, SIGNALING_RETRY_ATTEMPTS).then(resolve, reject);
            return;
          }
          reject(new Error(friendlyPeerError(err)));
          return;
        }
        if (err.type !== 'unavailable-id') {
          reject(new Error(friendlyPeerError(err)));
          return;
        }
        if (sameCodeAttemptsLeft > 0) {
          setTimeout(
            () => open(code, sameCodeAttemptsLeft - 1, candidateIndex, SIGNALING_RETRY_ATTEMPTS).then(resolve, reject),
            SAME_CODE_RETRY_DELAY_MS
          );
        } else {
          open(generateRoomCode(), 0, candidateIndex, SIGNALING_RETRY_ATTEMPTS).then(resolve, reject);
        }
      };
      peer.once('open', onOpen);
      peer.once('error', onError);
    });
  }

  const { peer, roomCode: resolvedCode } = await open(roomCode, SAME_CODE_RETRY_ATTEMPTS);

  peer.on('connection', (conn) => {
    const handleDisconnect = () => {
      // Both 'close' and 'error' can fire for the same connection. Only process once.
      if (!connections.has(conn.peer)) return;
      connections.delete(conn.peer);
      handlers.onJoinerDisconnected(conn.peer);
    };
    conn.on('open', () => {
      connections.set(conn.peer, conn);
      const meta = (conn.metadata ?? {}) as Partial<JoinerMetadata>;
      handlers.onJoinerConnected(conn.peer, {
        name: meta.name ?? 'Player',
        color: meta.color ?? '#888888',
        playerId: meta.playerId ?? conn.peer,
      });
    });
    conn.on('data', (data) => handlers.onJoinerMessage(conn.peer, data as P2PMessage));
    conn.on('close', handleDisconnect);
    conn.on('error', handleDisconnect);
  });
  peer.on('error', (err) => handlers.onFatalError(friendlyPeerError(err)));
  peer.on('disconnected', () => handlers.onFatalError('Lost connection to the signaling server.'));
  peer.on('call', (call) => {
    for (const listener of callListeners) listener(call.peer, call);
  });

  return {
    selfId: peer.id,
    roomCode: resolvedCode,
    send(toPeerId, message) {
      connections.get(toPeerId)?.send(message);
    },
    broadcast(message) {
      for (const conn of connections.values()) conn.send(message);
    },
    sendToHost() {
      // A host has no "host" to send to — no-op, matches the interface for symmetry with the
      // joiner handle so callers don't need to type-branch.
    },
    disconnectPeer(peerId) {
      // No explicit connections.delete here — conn.close() fires the 'close' listener registered
      // above (peer.on('connection', ...)'s conn.on('close', ...)), which already does that and
      // notifies handlers.onJoinerDisconnected, exactly like a real network drop would.
      connections.get(peerId)?.close();
    },
    callPeer(peerId, stream) {
      try {
        return peer.call(peerId, stream);
      } catch {
        return null;
      }
    },
    onIncomingCall(listener) {
      callListeners.add(listener);
      return () => callListeners.delete(listener);
    },
    close() {
      for (const conn of connections.values()) conn.close();
      connections.clear();
      callListeners.clear();
      peer.destroy();
    },
  };
}

export interface JoinRoomHandlers {
  onHostMessage: (message: P2PMessage) => void;
  /** The DataConnection to the host closed, whether cleanly or not — from here on sendToHost is
   *  a no-op until/unless the caller opens a fresh connectAsJoiner. */
  onHostDisconnected: () => void;
  onFatalError: (message: string) => void;
}

/** [DEFAULT — direct request: "save a current game .. resume it later as host"] Which kind of
 *  waiting room probeLobby actually found — an ordinary from-scratch lobby (grow-as-people-join
 *  roster, name/color still up for grabs) or a resumed room's fixed, save-derived ghost roster
 *  (name/color entry doesn't apply there at all — see components/p2p/P2PApp.tsx's join-setup
 *  screen, which switches its whole rendering based on this). */
export type LobbyProbeResult =
  | { mode: 'lobby'; players: LobbyPlayerInfo[] }
  | { mode: 'resume-lobby'; players: ResumeLobbyPlayerInfo[] };

/** One-shot roster fetch used by the join setup screen to disable already-taken options before
 *  connecting as a real player. */
export async function probeLobby(roomCode: string): Promise<LobbyProbeResult> {
  const PeerCtor = await loadPeerJs();
  const candidates = signalingCandidates();
  const fallbackCandidate: PeerCtorOptions = {
    host: '0.peerjs.com',
    port: 443,
    path: '/peerjs',
    secure: true,
    config: defaultIceConfig(),
  };

  const peer = await new Promise<Peer>((resolve, reject) => {
    const tryCandidate = (idx: number, transportRetriesLeft: number) => {
      const candidate = candidates[idx] ?? candidates[candidates.length - 1] ?? fallbackCandidate;
      const p = new PeerCtor(candidate);
      const onOpen = () => {
        p.off('error', onError);
        resolve(p);
      };
      const onError = (err: PeerError<`${PeerErrorType}`>) => {
        p.off('open', onOpen);
        p.destroy();
        if (isSignalingTransportError(err.type)) {
          if (transportRetriesLeft > 0) {
            setTimeout(() => tryCandidate(idx, transportRetriesLeft - 1), SIGNALING_RETRY_DELAY_MS);
            return;
          }
          if (idx + 1 < candidates.length) {
            tryCandidate(idx + 1, SIGNALING_RETRY_ATTEMPTS);
            return;
          }
        }
        reject(new Error(friendlyPeerError(err)));
      };
      p.once('open', onOpen);
      p.once('error', onError);
    };
    tryCandidate(0, SIGNALING_RETRY_ATTEMPTS);
  });

  return await new Promise<LobbyProbeResult>((resolve, reject) => {
    const probeMeta: JoinerMetadata = {
      name: '__probe__',
      color: '#000000',
      playerId: `probe-${Math.random().toString(36).slice(2, 10)}`,
      probe: true,
    };
    const conn = peer.connect(roomCodeToPeerId(roomCode), { metadata: probeMeta, reliable: true });

    let settled = false;
    let gotUpdate = false;
    const finish = (value: LobbyProbeResult | Error, isError = false) => {
      if (settled) return;
      settled = true;
      try {
        conn.close();
      } catch {}
      peer.destroy();
      if (isError) reject(value as Error);
      else resolve(value as LobbyProbeResult);
    };

    const timer = setTimeout(() => finish(new Error('Lobby probe timed out'), true), 5000);
    conn.on('data', (data) => {
      const msg = data as P2PMessage;
      // [DEFAULT — direct request: "resume it later as host"] Whichever of the two the host
      // actually sends back — see LobbyProbeResult's own doc comment for why there are two.
      if (msg.kind === 'lobbyUpdate') {
        gotUpdate = true;
        clearTimeout(timer);
        finish({ mode: 'lobby', players: msg.players });
        return;
      }
      if (msg.kind === 'resumeLobbyUpdate') {
        gotUpdate = true;
        clearTimeout(timer);
        finish({ mode: 'resume-lobby', players: msg.players });
      }
    });
    conn.once('error', (err) => {
      clearTimeout(timer);
      finish(new Error(err.message || "Couldn't fetch lobby preview."), true);
    });
    conn.once('close', () => {
      if (settled) return;
      clearTimeout(timer);
      if (gotUpdate) finish({ mode: 'lobby', players: [] });
      else finish(new Error('Lobby probe closed before roster arrived'), true);
    });
  });
}

/** Connects this device to `roomCode`'s host. Resolves once the DataConnection is open and ready
 *  to send — callers should send an initial P2PMessage (or rely on connection metadata, which the
 *  host already sees on onJoinerConnected) right after this resolves. */
export async function connectAsJoiner(roomCode: string, myInfo: JoinerMetadata, handlers: JoinRoomHandlers): Promise<PeerRoomHandle> {
  const PeerCtor = await loadPeerJs();
  const callListeners = new Set<(peerId: string, call: MediaConnection) => void>();
  const candidates = signalingCandidates();
  const fallbackCandidate: PeerCtorOptions = {
    host: '0.peerjs.com',
    port: 443,
    path: '/peerjs',
    secure: true,
    config: defaultIceConfig(),
  };

  const peer = await new Promise<Peer>((resolve, reject) => {
    const tryCandidate = (idx: number, transportRetriesLeft: number) => {
      const candidate = candidates[idx] ?? candidates[candidates.length - 1] ?? fallbackCandidate;
      const p = new PeerCtor(candidate);
      const onOpen = () => {
        p.off('error', onError);
        resolve(p);
      };
      const onError = (err: PeerError<`${PeerErrorType}`>) => {
        p.off('open', onOpen);
        p.destroy();
        if (isSignalingTransportError(err.type)) {
          if (transportRetriesLeft > 0) {
            setTimeout(() => tryCandidate(idx, transportRetriesLeft - 1), SIGNALING_RETRY_DELAY_MS);
            return;
          }
          if (idx + 1 < candidates.length) {
            tryCandidate(idx + 1, SIGNALING_RETRY_ATTEMPTS);
            return;
          }
          reject(new Error(friendlyPeerError(err)));
          return;
        }
        reject(new Error(friendlyPeerError(err)));
      };
      p.once('open', onOpen);
      p.once('error', onError);
    };
    tryCandidate(0, SIGNALING_RETRY_ATTEMPTS);
  });

  const conn = await new Promise<DataConnection>((resolve, reject) => {
    const c = peer.connect(roomCodeToPeerId(roomCode), { metadata: myInfo, reliable: true });
    const onOpen = () => {
      c.off('error', onError);
      resolve(c);
    };
    // DataConnection's own error event uses a different, narrower error-type union than the
    // Peer-level errors friendlyPeerError() discriminates on (negotiation/data-channel failures,
    // not signaling-server failures) — a plain message is enough here, there's no equally
    // friendly per-type rewrite worth doing for these.
    const onError = (err: Error) => {
      c.off('open', onOpen);
      reject(new Error(err.message || "Couldn't establish a connection to the host."));
    };
    c.once('open', onOpen);
    c.once('error', onError);
  });

  conn.on('data', (data) => handlers.onHostMessage(data as P2PMessage));
  let hostDisconnectedNotified = false;
  const notifyHostDisconnected = () => {
    if (hostDisconnectedNotified) return;
    hostDisconnectedNotified = true;
    handlers.onHostDisconnected();
  };
  conn.on('close', notifyHostDisconnected);
  conn.on('error', notifyHostDisconnected);
  peer.on('error', (err) => handlers.onFatalError(friendlyPeerError(err)));
  peer.on('disconnected', () => handlers.onFatalError('Lost connection to the signaling server.'));
  peer.on('call', (call) => {
    for (const listener of callListeners) listener(call.peer, call);
  });

  return {
    selfId: peer.id,
    send() {
      // A joiner never addresses another joiner directly (star topology) — no-op, symmetry with
      // the host handle.
    },
    broadcast() {
      // Same — a joiner only ever talks to the host.
    },
    sendToHost(message) {
      if (conn.open) conn.send(message);
    },
    disconnectPeer() {
      // A joiner has no other peers to disconnect (star topology) — no-op, same symmetry as
      // send/broadcast above.
    },
    callPeer(peerId, stream) {
      try {
        return peer.call(peerId, stream);
      } catch {
        return null;
      }
    },
    onIncomingCall(listener) {
      callListeners.add(listener);
      return () => callListeners.delete(listener);
    },
    close() {
      conn.close();
      callListeners.clear();
      peer.destroy();
    },
  };
}
