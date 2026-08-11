'use client';

/**
 * [DEFAULT — WebRTC P2P play] Host-side hook — owns the ONLY authoritative copy of GameState in
 * a P2P room (see lib/webrtc/protocol.ts's file header for the host-as-sequencer design). Mirrors
 * hooks/use-online-game.ts's shape (state/dispatch/error/isMyTurn) so components/GameBoardApp.tsx
 * needs zero changes to work over this transport instead of HTTP — the whole point of the pure-
 * reducer architecture (docs/data-model.md) is that transport is swappable underneath it.
 *
 * The lobby roster's source of truth is playersRef (a ref-backed Map<PlayerId, LobbyPlayerInfo>),
 * not React state — every join/leave decision reads and writes it synchronously, and
 * lobbyPlayers (React state) is just a snapshot mirror for rendering, always fully recomputed
 * rather than incrementally derived from a captured `prev`. This matters because a single stable
 * playerId can transiently have MORE THAN ONE live DataConnection at once — not just a real
 * network reconnect, but routinely in dev under React StrictMode, which mounts this effect
 * twice and only tears the first one down asynchronously (its `connectAsJoiner`/`connectAsHost`
 * call has already round-tripped to the signaling server before the cleanup's `cancelled` flag
 * has any effect). Deriving the next roster from React's `prev` in that window raced two
 * "add this player" / "resync this reconnect" updates against each other and could hand a
 * genuinely-joining player back a stale, pre-them snapshot. Reading playersRef directly sidesteps
 * that race entirely — it has no batching, no timing window, just whatever is true right now.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { nanoid } from 'nanoid';
import { applyAction, createGame, IllegalActionError, type Action, type GameState, type PlayerId } from '@/engine';
import { connectAsHost, type PeerRoomHandle } from '@/lib/webrtc/peer-room';
import type { LobbyPlayerInfo, P2PMessage } from '@/lib/webrtc/protocol';
import { generateRoomCode } from '@/lib/webrtc/protocol';
import { loadHostSession, saveHostSession } from '@/lib/webrtc/persistence';

export type P2PHostPhase =
  | { phase: 'connecting' }
  | { phase: 'lobby'; roomCode: string; players: LobbyPlayerInfo[]; canStart: boolean; startGame: () => void }
  | { phase: 'active'; roomCode: string; state: GameState; dispatch: (action: Action) => boolean; error: string | null; isMyTurn: boolean; myPlayerId: PlayerId }
  | { phase: 'error'; message: string };

interface HostInfo {
  name: string;
  color: string;
}

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;

export function useP2PHost(hostInfo: HostInfo): P2PHostPhase {
  // [DEFAULT — direct request: "if the host reloads the tab it should be restored after reload
  // and let the clients reconnect to resume session"] Read once, at first mount — the whole
  // point of a lazy initializer here is that a persisted session (if any) governs THIS mount's
  // identity/room code from the very first render, not just after some later effect catches up.
  const [resumed] = useState(() => loadHostSession());
  // Stable across the whole hook lifetime — minted once, never re-derived from render state, so
  // it survives every lobby roster / game-state update below without churn. A lazy useState
  // initializer, not useRef(...).current — this project's react-hooks rules (react-hooks/refs)
  // forbid reading a ref's value during render; useState's lazy form is the render-safe
  // equivalent of "compute once, never changes" since its setter is simply never called.
  //
  // [DEFAULT — host reload restore] MUST stay the same id across a reload — it's baked into the
  // restored GameState's players array (createGame was called with this exact id when the game
  // first started), so a fresh nanoid here would make the reloaded host unable to recognize any
  // seat in their own restored game as "me" (isMyTurn below compares against this).
  const [myPlayerId] = useState(() => resumed?.hostPlayerId ?? nanoid(10));
  const handleRef = useRef<PeerRoomHandle | null>(null);
  // Ephemeral PeerJS connection id -> the stable player identity that connection speaks for. A
  // stable id can map from MULTIPLE peerIds at once for a brief window (see file header) — that
  // is expected, not a bug in itself; only playersRef (below) is the roster source of truth.
  const peerIdToPlayerId = useRef(new Map<string, PlayerId>());
  // The actual roster — keyed by STABLE playerId so a duplicate connection for the same identity
  // (StrictMode's throwaway mount, or a genuine rapid reconnect) is naturally idempotent: setting
  // the same key twice is a no-op change, not a duplicate entry.
  const playersRef = useRef(new Map<PlayerId, LobbyPlayerInfo>());
  // [DEFAULT — host reload restore] Seeded from the persisted session, if any, so a mid-game
  // reload has its authoritative state back from the very first render — not just after the
  // connect effect below gets around to it.
  const gameStateRef = useRef<GameState | null>(resumed?.gameState ?? null); // authoritative — mutated only via applyAction
  // Set inside the connect effect once the resolved room code (and this seat's effective
  // name/color) are known, then called from every state-mutating path — including dispatch/
  // startGame below, which are declared outside the effect via useCallback and would otherwise
  // have no stale-closure-safe way to reach those values. A ref, not a plain closure variable,
  // for the same reason gameStateRef/handleRef are refs: it needs to be readable from callbacks
  // that don't re-run when the effect does.
  const persistRef = useRef<() => void>(() => {});

  const [phase, setPhase] = useState<'connecting' | 'lobby' | 'active' | 'error'>('connecting');
  const [roomCode, setRoomCode] = useState('');
  const [lobbyPlayers, setLobbyPlayers] = useState<LobbyPlayerInfo[]>([]);
  const [gameState, setGameState] = useState<GameState | null>(resumed?.gameState ?? null);
  const [error, setError] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let handle: PeerRoomHandle & { roomCode: string };

    /** Recomputes the React-visible snapshot from playersRef (the real source of truth) and
     *  returns it, so callers can broadcast the exact same array they just rendered from. */
    function syncLobbyState(): LobbyPlayerInfo[] {
      const list = [...playersRef.current.values()];
      setLobbyPlayers(list);
      return list;
    }

    (async () => {
      try {
        // [DEFAULT — host reload restore] Reopen the SAME room code if resuming, instead of
        // always generating a fresh one — connectAsHost's own SAME_CODE_RETRY_ATTEMPTS (see
        // peer-room.ts) gives a fast reload a real chance to reclaim it before falling back.
        handle = await connectAsHost(resumed?.roomCode ?? generateRoomCode(), {
          onJoinerConnected(peerId, meta) {
            if (cancelled) return;
            peerIdToPlayerId.current.set(peerId, meta.playerId);

            if (gameStateRef.current) {
              // Game already started: this is either a genuine reconnect (welcome back — resend
              // the authoritative state) or, if that stable id was never in this game at all,
              // a straggler who dialed in after the lobby closed — same response either way,
              // there's no lobby to add them to anymore.
              handleRef.current?.send(peerId, { kind: 'stateSync', state: gameStateRef.current });
              return;
            }

            const alreadyKnown = playersRef.current.has(meta.playerId);
            playersRef.current.set(meta.playerId, { playerId: meta.playerId, name: meta.name, color: meta.color, isHost: false });
            const list = syncLobbyState();
            if (alreadyKnown) {
              // A second live connection for a stable id already on the roster — just bring
              // THIS connection's own view up to date, nothing changed for anyone else.
              handleRef.current?.send(peerId, { kind: 'lobbyUpdate', players: list });
            } else {
              handleRef.current?.broadcast({ kind: 'lobbyUpdate', players: list });
            }
          },
          onJoinerMessage(peerId, message) {
            if (cancelled) return;
            const stablePlayerId = peerIdToPlayerId.current.get(peerId);
            if (!stablePlayerId) return; // shouldn't happen — onJoinerConnected always runs first

            if (message.kind === 'requestSync') {
              if (gameStateRef.current) handleRef.current?.send(peerId, { kind: 'stateSync', state: gameStateRef.current });
              return;
            }
            if (message.kind !== 'action') return;
            const current = gameStateRef.current;
            if (!current) return; // action arrived before the game started — ignore
            // Never trust actorId from the wire alone — mirrors server/game-server.ts's
            // session-vs-actorId check for the HTTP transport; the analogous authority boundary
            // here is "which DataConnection did this arrive on."
            if (message.action.actorId !== stablePlayerId) {
              handleRef.current?.send(peerId, { kind: 'reject', reason: 'actorId does not match your connection' });
              return;
            }
            try {
              const next = applyAction(current, message.action);
              gameStateRef.current = next;
              setGameState(next);
              persistRef.current();
              handleRef.current?.broadcast({ kind: 'stateSync', state: next });
            } catch (err) {
              if (err instanceof IllegalActionError) {
                handleRef.current?.send(peerId, { kind: 'reject', reason: err.message });
                return;
              }
              throw err; // a real bug, not a rejected move — surface it loudly, don't swallow it
            }
          },
          onJoinerDisconnected(peerId) {
            if (cancelled) return;
            const stablePlayerId = peerIdToPlayerId.current.get(peerId);
            peerIdToPlayerId.current.delete(peerId);
            if (!stablePlayerId || gameStateRef.current) return; // mid-game: leave their seat, they may reconnect

            // Only evict from the roster if NO OTHER live connection still speaks for this
            // stable id — exactly the case that protects a StrictMode-throwaway connection's
            // teardown from evicting the real, still-connected player sharing its identity.
            const stillConnected = [...peerIdToPlayerId.current.values()].includes(stablePlayerId);
            if (stillConnected) return;
            playersRef.current.delete(stablePlayerId);
            const list = syncLobbyState();
            handleRef.current?.broadcast({ kind: 'lobbyUpdate', players: list });
          },
          onFatalError(message) {
            if (!cancelled) setFatal(message);
          },
        });
        if (cancelled) {
          handle.close();
          return;
        }
        handleRef.current = handle;
        setRoomCode(handle.roomCode);

        // [DEFAULT — host reload restore] Ignore the hostInfo PROP entirely when resuming — it
        // reflects whatever P2PApp happened to seed its own name/color state with on this fresh
        // mount (defaults, since the user never re-typed anything), not who this room actually
        // belongs to. The persisted session is the source of truth for "who am I" once resuming.
        const effectiveName = resumed?.name ?? hostInfo.name;
        const effectiveColor = resumed?.color ?? hostInfo.color;
        playersRef.current.set(myPlayerId, { playerId: myPlayerId, name: effectiveName, color: effectiveColor, isHost: true });

        persistRef.current = () => {
          saveHostSession({
            roomCode: handle.roomCode,
            hostPlayerId: myPlayerId,
            name: effectiveName,
            color: effectiveColor,
            gameState: gameStateRef.current,
          });
        };
        persistRef.current();

        if (gameStateRef.current) {
          // Resumed mid-game: the lobby is long over, go straight back to the board. The old
          // roster snapshot isn't restored into playersRef — clients reconnect on their own
          // retry loop (hooks/use-p2p-join.ts) and re-announce themselves via onJoinerConnected
          // above, which already re-sends stateSync to anyone recognized once gameStateRef is set.
          setGameState(gameStateRef.current);
          setPhase('active');
        } else {
          syncLobbyState();
          setPhase('lobby');
        }
      } catch (err) {
        if (!cancelled) setFatal(err instanceof Error ? err.message : 'Failed to open room');
      }
    })();

    return () => {
      cancelled = true;
      handleRef.current?.close();
      handleRef.current = null;
    };
    // hostInfo intentionally not in deps — the room is created exactly once per mount, renaming
    // mid-session isn't supported (matches the hotseat lobby's own "set names before Start").
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myPlayerId]);

  const startGame = useCallback(() => {
    const players = [...playersRef.current.values()];
    if (players.length < MIN_PLAYERS) return;
    const initial = createGame(
      `p2p-${roomCode}`,
      players.map((p) => ({ id: p.playerId, name: p.name, color: p.color })),
      `${roomCode}-${Date.now()}`,
      'realtime'
    );
    gameStateRef.current = initial;
    setGameState(initial);
    setPhase('active');
    persistRef.current();
    handleRef.current?.broadcast({ kind: 'gameStarted', state: initial });
  }, [roomCode]);

  const dispatch = useCallback((action: Action): boolean => {
    const current = gameStateRef.current;
    if (!current) return false;
    try {
      const next = applyAction(current, action);
      gameStateRef.current = next;
      setGameState(next);
      setError(null);
      persistRef.current();
      handleRef.current?.broadcast({ kind: 'stateSync', state: next });
      return true;
    } catch (err) {
      if (err instanceof IllegalActionError) {
        setError(err.message);
        return false;
      }
      throw err;
    }
  }, []);

  if (fatal) return { phase: 'error', message: fatal };
  if (phase === 'connecting') return { phase: 'connecting' };
  if (phase === 'lobby') {
    return { phase: 'lobby', roomCode, players: lobbyPlayers, canStart: lobbyPlayers.length >= MIN_PLAYERS && lobbyPlayers.length <= MAX_PLAYERS, startGame };
  }
  // phase === 'active'
  return {
    phase: 'active',
    roomCode,
    state: gameState!,
    dispatch,
    error,
    isMyTurn: gameState!.currentPlayerId === myPlayerId,
    myPlayerId,
  };
}
