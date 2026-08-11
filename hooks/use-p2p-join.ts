'use client';

/**
 * [DEFAULT — WebRTC P2P play] Joiner-side hook — the mirror of hooks/use-p2p-host.ts. Holds no
 * authority: every dispatch is sent to the host and applied locally only once the host's
 * stateSync confirms it (see lib/webrtc/protocol.ts's file header). Same
 * {state, dispatch, error, isMyTurn} shape as every other transport hook, so
 * components/GameBoardApp.tsx is unchanged.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { nanoid } from 'nanoid';
import { applyAction, IllegalActionError, type Action, type GameState, type PlayerId } from '@/engine';
import { connectAsJoiner, type PeerRoomHandle } from '@/lib/webrtc/peer-room';
import type { LobbyPlayerInfo } from '@/lib/webrtc/protocol';

export type P2PJoinPhase =
  | { phase: 'connecting' }
  | { phase: 'lobby'; players: LobbyPlayerInfo[] }
  | { phase: 'active'; state: GameState; dispatch: (action: Action) => boolean; error: string | null; isMyTurn: boolean; myPlayerId: PlayerId }
  | { phase: 'error'; message: string };

interface JoinInfo {
  name: string;
  color: string;
}

// [DEFAULT — direct request: "if the host reloads the tab it should be restored .. and let the
// clients reconnect"] A host reload now takes a bit longer to come back up than a plain dropped
// connection — it has to re-run its own connect effect AND (see peer-room.ts's
// SAME_CODE_RETRY_ATTEMPTS/SAME_CODE_RETRY_DELAY_MS) potentially wait out a few retries to
// reclaim its old room code from the signaling broker. Widened from 5×2s (10s total) to 8×2.5s
// (20s total) so a joiner's own retry loop doesn't give up before the host has had a realistic
// chance to come back.
const RECONNECT_ATTEMPTS = 8;
const RECONNECT_DELAY_MS = 2500;

/** Same human rejoining the same room (a dropped connection, or an accidental page refresh)
 *  should come back as the SAME in-game player, not a fresh seat — see use-p2p-host.ts's
 *  reconnect-matching. sessionStorage (not localStorage) so a genuinely new tab/session for the
 *  same room still gets treated as a new identity, matching sessionStorage's own "this browsing
 *  session" scope. */
function stablePlayerIdFor(roomCode: string): string {
  const key = `hexrealms-p2p-playerid-${roomCode}`;
  if (typeof window === 'undefined') return nanoid(10); // SSR guard — never actually rendered
  const existing = window.sessionStorage.getItem(key);
  if (existing) return existing;
  const fresh = nanoid(10);
  window.sessionStorage.setItem(key, fresh);
  return fresh;
}

export function useP2PJoin(roomCode: string, myInfo: JoinInfo): P2PJoinPhase {
  // Lazy useState initializer, not useRef(...).current — see use-p2p-host.ts's identical comment
  // on why (this project's react-hooks/refs rule forbids reading a ref during render).
  const [myPlayerId] = useState(() => stablePlayerIdFor(roomCode));
  const handleRef = useRef<PeerRoomHandle | null>(null);
  const gameStateRef = useRef<GameState | null>(null);
  const reconnectAttemptRef = useRef(0);

  const [phase, setPhase] = useState<'connecting' | 'lobby' | 'active' | 'error'>('connecting');
  const [lobbyPlayers, setLobbyPlayers] = useState<LobbyPlayerInfo[]>([]);
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      connectAsJoiner(
        roomCode,
        { name: myInfo.name, color: myInfo.color, playerId: myPlayerId },
        {
          onHostMessage(message) {
            if (cancelled) return;
            reconnectAttemptRef.current = 0; // any message means the link is healthy again
            switch (message.kind) {
              case 'lobbyUpdate':
                // The host only ever sends this before gameStarted — no phase transition needed
                // here (and reading the `phase` state var in this closure would be stale anyway,
                // since this effect intentionally never re-runs after the initial connect; see
                // this effect's closing comment). connectAsJoiner's caller starts at 'connecting'
                // and this is what actually advances it out of that on a fresh join.
                setLobbyPlayers(message.players);
                setPhase((p) => (p === 'connecting' ? 'lobby' : p));
                break;
              case 'gameStarted':
                gameStateRef.current = message.state;
                setGameState(message.state);
                setPhase('active');
                break;
              case 'stateSync':
                gameStateRef.current = message.state;
                setGameState(message.state);
                setError(null);
                break;
              case 'reject':
                // The optimistic apply that produced our current gameStateRef has now proven
                // wrong (the host's real state disagreed) — leaving it in place would desync us
                // silently until some LATER unrelated action happens to overwrite it via
                // stateSync. Ask for a corrective resync immediately rather than wait for that.
                setError(message.reason);
                handleRef.current?.sendToHost({ kind: 'requestSync' });
                break;
              case 'requestSync':
                break; // never sent host -> joiner, only the reverse
            }
          },
          onHostDisconnected() {
            if (cancelled) return;
            handleRef.current = null;
            if (reconnectAttemptRef.current >= RECONNECT_ATTEMPTS) {
              setFatal('Lost connection to the host and could not reconnect.');
              return;
            }
            reconnectAttemptRef.current += 1;
            reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
          },
          onFatalError(message) {
            if (!cancelled) setFatal(message);
          },
        }
      ).then((handle) => {
        if (cancelled) {
          handle.close();
          return;
        }
        handleRef.current = handle;
        // A reconnect mid-game has nothing to wait for — ask the host to catch us up immediately
        // rather than sitting on possibly-stale state until the next unrelated broadcast.
        if (gameStateRef.current) handle.sendToHost({ kind: 'requestSync' });
      }, (err: Error) => {
        if (!cancelled) setFatal(err.message);
      });
    }

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      handleRef.current?.close();
      handleRef.current = null;
    };
    // myInfo/phase intentionally excluded — connect() closes over myPlayerId/roomCode (stable
    // for the hook's lifetime) and re-running this effect on every phase change would tear down
    // and reopen the connection on our own state transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode, myPlayerId]);

  const dispatch = useCallback(
    (action: Action): boolean => {
      const current = gameStateRef.current;
      if (!current) return false;
      // Optimistic local apply for instant feedback — the host's stateSync (or reject) that
      // follows either matches this exactly (no-op) or corrects it, same pattern as
      // hooks/use-online-game.ts's HTTP round trip.
      try {
        const optimistic = applyAction(current, action);
        gameStateRef.current = optimistic;
        setGameState(optimistic);
        setError(null);
      } catch (err) {
        if (err instanceof IllegalActionError) {
          setError(err.message);
          return false;
        }
        throw err;
      }
      handleRef.current?.sendToHost({ kind: 'action', action });
      return true;
    },
    []
  );

  if (fatal) return { phase: 'error', message: fatal };
  if (phase === 'connecting') return { phase: 'connecting' };
  if (phase === 'lobby') return { phase: 'lobby', players: lobbyPlayers };
  return {
    phase: 'active',
    state: gameState!,
    dispatch,
    error,
    isMyTurn: gameState!.currentPlayerId === myPlayerId,
    myPlayerId,
  };
}
