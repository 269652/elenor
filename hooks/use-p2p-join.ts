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
import type { MediaConnection } from 'peerjs';
import type { ChatMessage, LobbyPlayerInfo, VoicePeerInfo } from '@/lib/webrtc/protocol';
import { clearJoinSession, saveHostSession } from '@/lib/webrtc/persistence';

export type P2PJoinPhase =
  | { phase: 'connecting' }
  | { phase: 'lobby'; players: LobbyPlayerInfo[] }
  | {
      phase: 'active';
      state: GameState;
      dispatch: (action: Action) => boolean;
      error: string | null;
      isMyTurn: boolean;
      myPlayerId: PlayerId;
      /** [DEFAULT — direct request: "toggle Human/AI mid game .. a little chat"] The read-only
       *  half of hooks/use-p2p-host.ts's identical bundle — a joiner sees the roster/AI-status/
       *  chat but never gets kick/toggle/transfer (host-only actions, never sent by a joiner). */
      players: LobbyPlayerInfo[];
      aiControlledPlayerIds: ReadonlySet<PlayerId>;
      chatMessages: ChatMessage[];
      unreadChatCount: number;
      sendChat: (text: string) => void;
      markChatRead: () => void;
      voiceEnabled: boolean;
      voiceMuted: boolean;
      voiceError: string | null;
      remoteVoiceStreams: { playerId: PlayerId; name: string; color: string; stream: MediaStream }[];
      enableVoice: () => Promise<void>;
      disableVoice: () => void;
      toggleVoiceMuted: () => void;
    }
  | { phase: 'error'; message: string };

interface JoinInfo {
  name: string;
  color: string;
}

export interface UseP2PJoinCallbacks {
  /** [DEFAULT — direct request: "transfer hosting to another player"] Fires once this device has
   *  been named the new host (a 'hostTransferring' message targeting its own myPlayerId) and has
   *  finished seeding itself a host session to resume into — the caller
   *  (components/p2p/P2PApp.tsx) reacts by switching its `screen` state from 'join-room' to
   *  'host-room', unmounting this hook and mounting hooks/use-p2p-host.ts in its place, which
   *  picks the seeded session straight back up (same resume machinery a host reload already
   *  uses). See hooks/use-p2p-host.ts's transferHostTo for the sender side of this handoff. */
  onBecameHost?: () => void;
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
const VOICE_RETRY_INTERVAL_MS = 2000;
const VOICE_CALL_STREAM_TIMEOUT_MS = 8000;

function stableVoiceInitiator(a: PlayerId, b: PlayerId): boolean {
  return a < b;
}

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

export function useP2PJoin(roomCode: string, myInfo: JoinInfo, callbacks: UseP2PJoinCallbacks = {}): P2PJoinPhase {
  // Lazy useState initializer, not useRef(...).current — see use-p2p-host.ts's identical comment
  // on why (this project's react-hooks/refs rule forbids reading a ref during render).
  const [myPlayerId] = useState(() => stablePlayerIdFor(roomCode));
  const handleRef = useRef<PeerRoomHandle | null>(null);
  const gameStateRef = useRef<GameState | null>(null);
  const reconnectAttemptRef = useRef(0);
  const lobbyPlayersRef = useRef<LobbyPlayerInfo[]>([]);
  const voicePeersRef = useRef<VoicePeerInfo[]>([]);
  const voiceCallsRef = useRef(new Map<PlayerId, MediaConnection>());
  const voiceRemoteRef = useRef(new Map<PlayerId, MediaStream>());
  const localVoiceStreamRef = useRef<MediaStream | null>(null);
  const voiceEnabledRef = useRef(false);
  const voiceMutedRef = useRef(false);
  const voiceRetryTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inboundVoiceUnsubRef = useRef<(() => void) | null>(null);
  // [DEFAULT — direct request: "kick a player"] Checked in onHostDisconnected below — a kicked
  // peer's connection closing looks IDENTICAL to a real network drop at the transport level, but
  // it must not trigger the ordinary reconnect-retry loop (the host would just kick it again the
  // instant it redials — see hooks/use-p2p-host.ts's bannedPlayerIds).
  const wasKickedRef = useRef(false);
  const callbacksRef = useRef(callbacks);
  useEffect(() => {
    callbacksRef.current = callbacks;
  });

  const [phase, setPhase] = useState<'connecting' | 'lobby' | 'active' | 'error'>('connecting');
  const [lobbyPlayers, setLobbyPlayers] = useState<LobbyPlayerInfo[]>([]);
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [aiControlledPlayerIds, setAiControlledPlayerIds] = useState<ReadonlySet<PlayerId>>(new Set());
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [unreadChatCount, setUnreadChatCount] = useState(0);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voiceMuted, setVoiceMuted] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [remoteVoiceStreams, setRemoteVoiceStreams] = useState<{ playerId: PlayerId; name: string; color: string; stream: MediaStream }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  const refreshRemoteVoiceStreams = useCallback(() => {
    const byPlayer = new Map(lobbyPlayersRef.current.map((p) => [p.playerId, p]));
    const snapshot = [...voiceRemoteRef.current.entries()].map(([playerId, stream]) => {
      const p = byPlayer.get(playerId);
      return { playerId, name: p?.name ?? playerId, color: p?.color ?? '#888888', stream };
    });
    setRemoteVoiceStreams(snapshot);
  }, []);

  const detachVoiceCall = useCallback(
    (playerId: PlayerId, call?: MediaConnection) => {
      const existing = voiceCallsRef.current.get(playerId);
      if (call && existing && existing !== call) return;
      if (existing) {
        existing.close();
        voiceCallsRef.current.delete(playerId);
      }
      if (voiceRemoteRef.current.delete(playerId)) refreshRemoteVoiceStreams();
    },
    [refreshRemoteVoiceStreams]
  );

  const bindVoiceCall = useCallback(
    (playerId: PlayerId, call: MediaConnection) => {
      const existing = voiceCallsRef.current.get(playerId);
      if (existing && existing !== call) {
        existing.close();
        voiceCallsRef.current.delete(playerId);
      }
      voiceCallsRef.current.set(playerId, call);
      let streamArrived = false;
      const streamTimeout = setTimeout(() => {
        if (streamArrived) return;
        call.close();
        detachVoiceCall(playerId, call);
      }, VOICE_CALL_STREAM_TIMEOUT_MS);
      call.on('stream', (stream) => {
        streamArrived = true;
        clearTimeout(streamTimeout);
        voiceRemoteRef.current.set(playerId, stream);
        refreshRemoteVoiceStreams();
      });
      call.on('close', () => {
        clearTimeout(streamTimeout);
        detachVoiceCall(playerId, call);
      });
      call.on('error', () => {
        clearTimeout(streamTimeout);
        detachVoiceCall(playerId, call);
      });
    },
    [detachVoiceCall, refreshRemoteVoiceStreams]
  );

  const syncVoiceConnections = useCallback(() => {
    if (!voiceEnabledRef.current || !localVoiceStreamRef.current) return;
    const setLocalMicState = () => {
      if (!localVoiceStreamRef.current) return;
      for (const track of localVoiceStreamRef.current.getAudioTracks()) track.enabled = !voiceMutedRef.current;
    };
    setLocalMicState();
    const handle = handleRef.current;
    if (!handle) return;
    const shouldConnectTo = new Set<PlayerId>();
    for (const peer of voicePeersRef.current) {
      if (peer.playerId === myPlayerId) continue;
      if (!stableVoiceInitiator(myPlayerId, peer.playerId)) continue;
      shouldConnectTo.add(peer.playerId);
      if (voiceCallsRef.current.has(peer.playerId)) continue;
      const call = handle.callPeer(peer.peerId, localVoiceStreamRef.current);
      if (call) bindVoiceCall(peer.playerId, call);
    }
    for (const [pid, call] of [...voiceCallsRef.current.entries()]) {
      if (!shouldConnectTo.has(pid) && stableVoiceInitiator(myPlayerId, pid)) {
        call.close();
        voiceCallsRef.current.delete(pid);
      }
    }
  }, [bindVoiceCall, myPlayerId]);

  const stopVoice = useCallback(() => {
    voiceEnabledRef.current = false;
    voiceMutedRef.current = false;
    setVoiceEnabled(false);
    setVoiceMuted(false);
    for (const call of voiceCallsRef.current.values()) call.close();
    voiceCallsRef.current.clear();
    voiceRemoteRef.current.clear();
    refreshRemoteVoiceStreams();
    localVoiceStreamRef.current?.getTracks().forEach((t) => t.stop());
    localVoiceStreamRef.current = null;
    if (voiceRetryTimerRef.current) {
      clearInterval(voiceRetryTimerRef.current);
      voiceRetryTimerRef.current = null;
    }
  }, [refreshRemoteVoiceStreams]);

  useEffect(() => () => stopVoice(), [stopVoice]);

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
                lobbyPlayersRef.current = message.players;
                setLobbyPlayers(message.players);
                setPhase((p) => (p === 'connecting' ? 'lobby' : p));
                refreshRemoteVoiceStreams();
                break;
              case 'gameStarted':
                gameStateRef.current = message.state;
                setGameState(message.state);
                setAiControlledPlayerIds(new Set(message.aiControlledPlayerIds));
                setPhase('active');
                break;
              case 'stateSync':
                gameStateRef.current = message.state;
                setGameState(message.state);
                setAiControlledPlayerIds(new Set(message.aiControlledPlayerIds));
                setError(null);
                // [BUG FIX — direct request: "when a client reloads the tab he should be
                // reconnected"] A resumed joiner's fresh mount goes straight to the room screen
                // with no preceding 'gameStarted' — the host's onJoinerConnected (use-p2p-host.ts)
                // proactively sends stateSync, not gameStarted, once a game is already running.
                // Without this, phase stayed stuck at 'connecting' forever even though gameState
                // was already correctly populated above — the joiner looked permanently frozen.
                setPhase((p) => (p === 'connecting' ? 'active' : p));
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
              case 'kicked':
                // [DEFAULT — direct request: "kick a player"] Marked BEFORE the connection actually
                // closes (this message always arrives right before the host calls disconnectPeer —
                // see hooks/use-p2p-host.ts's kickPlayer) so onHostDisconnected below knows not to
                // start the ordinary reconnect loop once that close event follows.
                wasKickedRef.current = true;
                clearJoinSession();
                setFatal(`Removed from this room: ${message.reason}`);
                break;
              case 'hostTransferring':
                // [DEFAULT — direct request: "transfer hosting to another player"] Only the
                // targeted peer acts — everyone else's existing onHostDisconnected retry loop
                // already handles the brief reconnect this causes, agnostic to why the host
                // disappeared. Seed a host session under THIS SAME stable myPlayerId (so the
                // resumed GameState recognizes this seat as "me" the instant hooks/use-p2p-host.ts
                // mounts — same field hostPlayerId a host reload already relies on) and hand
                // control to the caller to actually switch screens.
                if (message.toPlayerId === myPlayerId) {
                  clearJoinSession();
                  saveHostSession({ roomCode, hostPlayerId: myPlayerId, name: myInfo.name, color: myInfo.color, gameState: gameStateRef.current });
                  callbacksRef.current.onBecameHost?.();
                }
                break;
              case 'chatMessage':
                setChatMessages((prev) => [...prev, message.message]);
                if (message.message.playerId !== myPlayerId) setUnreadChatCount((n) => n + 1);
                break;
              case 'voicePeers':
                voicePeersRef.current = message.peers;
                syncVoiceConnections();
                break;
            }
          },
          onHostDisconnected() {
            if (cancelled) return;
            handleRef.current = null;
            if (wasKickedRef.current) return; // see the 'kicked' case above — no reconnect attempt
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
        inboundVoiceUnsubRef.current = handle.onIncomingCall((fromPeerId, call) => {
          if (!voiceEnabledRef.current || !localVoiceStreamRef.current) {
            call.close();
            return;
          }
          const from = voicePeersRef.current.find((p) => p.peerId === fromPeerId);
          if (!from) {
            call.close();
            return;
          }
          for (const track of localVoiceStreamRef.current.getAudioTracks()) track.enabled = !voiceMutedRef.current;
          call.answer(localVoiceStreamRef.current);
          bindVoiceCall(from.playerId, call);
        });
        // Always ask for a sync right after connecting — covers a same-mount reconnect (had
        // state, may have missed messages while disconnected) AND a fresh-mount resume from a
        // persisted room code (never had state at all, so this is the ONLY thing that unsticks
        // it if the host's own proactive onJoinerConnected push ever races or gets lost). A no-op
        // on the host side if no game has started yet (see use-p2p-host.ts's requestSync handler).
        handle.sendToHost({ kind: 'requestSync' });
      }, (err: Error) => {
        if (!cancelled) setFatal(err.message);
      });
    }

    connect();
    return () => {
      cancelled = true;
      inboundVoiceUnsubRef.current?.();
      inboundVoiceUnsubRef.current = null;
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

  const sendChat = useCallback((text: string) => {
    handleRef.current?.sendToHost({ kind: 'chatSend', text });
  }, []);
  const markChatRead = useCallback(() => setUnreadChatCount(0), []);

  const enableVoice = useCallback(async () => {
    if (voiceEnabledRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localVoiceStreamRef.current = stream;
      stream.getAudioTracks().forEach((t) => {
        t.enabled = !voiceMutedRef.current;
      });
      voiceEnabledRef.current = true;
      voiceMutedRef.current = false;
      setVoiceEnabled(true);
      setVoiceMuted(false);
      setVoiceError(null);
      syncVoiceConnections();
      if (!voiceRetryTimerRef.current) {
        voiceRetryTimerRef.current = setInterval(() => {
          syncVoiceConnections();
        }, VOICE_RETRY_INTERVAL_MS);
      }
    } catch {
      setVoiceError('Microphone access failed. Check browser permissions and try again.');
    }
  }, [syncVoiceConnections]);

  const disableVoice = useCallback(() => {
    stopVoice();
  }, [stopVoice]);

  const toggleVoiceMuted = useCallback(() => {
    if (!localVoiceStreamRef.current) return;
    const nextMuted = !voiceMutedRef.current;
    voiceMutedRef.current = nextMuted;
    for (const track of localVoiceStreamRef.current.getAudioTracks()) track.enabled = !nextMuted;
    setVoiceMuted(nextMuted);
  }, []);

  if (fatal) return { phase: 'error', message: fatal };
  if (phase === 'connecting') return { phase: 'connecting' };
  if (phase === 'lobby') return { phase: 'lobby', players: lobbyPlayers };
  return {
    phase: 'active',
    state: gameState!,
    dispatch,
    error,
    isMyTurn: gameState!.currentPlayerId === myPlayerId && !aiControlledPlayerIds.has(myPlayerId),
    myPlayerId,
    players: lobbyPlayers,
    aiControlledPlayerIds,
    chatMessages,
    unreadChatCount,
    sendChat,
    markChatRead,
    voiceEnabled,
    voiceMuted,
    voiceError,
    remoteVoiceStreams,
    enableVoice,
    disableVoice,
    toggleVoiceMuted,
  };
}
