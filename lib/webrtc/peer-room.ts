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

import type { DataConnection, Peer, PeerError, PeerErrorType } from 'peerjs';
import type { JoinerMetadata, P2PMessage } from './protocol';
import { generateRoomCode, roomCodeToPeerId } from './protocol';

async function loadPeerJs() {
  const mod = await import('peerjs');
  return mod.Peer;
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

/** Opens this device as the host of `roomCode` — creates a Peer whose id IS the room code (see
 *  protocol.ts's roomCodeToPeerId) so joiners can dial straight in with nothing but the code.
 *  Retries once with a freshly generated code on an id collision (astronomically unlikely at a
 *  5-char/32-symbol code, but cheap to handle) — resolves with whatever code actually won, which
 *  may differ from the one passed in; callers should always display the RESOLVED code, not the
 *  one they asked for. */
export async function connectAsHost(roomCode: string, handlers: HostRoomHandlers): Promise<PeerRoomHandle & { roomCode: string }> {
  const PeerCtor = await loadPeerJs();
  const connections = new Map<string, DataConnection>();

  async function open(code: string, isRetry: boolean): Promise<{ peer: Peer; roomCode: string }> {
    return new Promise((resolve, reject) => {
      const peer = new PeerCtor(roomCodeToPeerId(code));
      const onOpen = () => {
        peer.off('error', onError);
        resolve({ peer, roomCode: code });
      };
      const onError = (err: PeerError<`${PeerErrorType}`>) => {
        peer.off('open', onOpen);
        peer.destroy();
        if (err.type === 'unavailable-id' && !isRetry) {
          open(generateRoomCode(), true).then(resolve, reject);
        } else {
          reject(new Error(friendlyPeerError(err)));
        }
      };
      peer.once('open', onOpen);
      peer.once('error', onError);
    });
  }

  const { peer, roomCode: resolvedCode } = await open(roomCode, false);

  peer.on('connection', (conn) => {
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
    conn.on('close', () => {
      connections.delete(conn.peer);
      handlers.onJoinerDisconnected(conn.peer);
    });
    conn.on('error', () => {
      connections.delete(conn.peer);
      handlers.onJoinerDisconnected(conn.peer);
    });
  });
  peer.on('error', (err) => handlers.onFatalError(friendlyPeerError(err)));
  peer.on('disconnected', () => handlers.onFatalError('Lost connection to the signaling server.'));

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
    close() {
      for (const conn of connections.values()) conn.close();
      connections.clear();
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

/** Connects this device to `roomCode`'s host. Resolves once the DataConnection is open and ready
 *  to send — callers should send an initial P2PMessage (or rely on connection metadata, which the
 *  host already sees on onJoinerConnected) right after this resolves. */
export async function connectAsJoiner(roomCode: string, myInfo: JoinerMetadata, handlers: JoinRoomHandlers): Promise<PeerRoomHandle> {
  const PeerCtor = await loadPeerJs();

  const peer = await new Promise<Peer>((resolve, reject) => {
    const p = new PeerCtor();
    const onOpen = () => {
      p.off('error', onError);
      resolve(p);
    };
    const onError = (err: PeerError<`${PeerErrorType}`>) => {
      p.off('open', onOpen);
      p.destroy();
      reject(new Error(friendlyPeerError(err)));
    };
    p.once('open', onOpen);
    p.once('error', onError);
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
  conn.on('close', () => handlers.onHostDisconnected());
  conn.on('error', () => handlers.onHostDisconnected());
  peer.on('error', (err) => handlers.onFatalError(friendlyPeerError(err)));
  peer.on('disconnected', () => handlers.onFatalError('Lost connection to the signaling server.'));

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
    close() {
      conn.close();
      peer.destroy();
    },
  };
}
