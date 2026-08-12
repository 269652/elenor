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
import { applyAction, createGame, IllegalActionError, type Action, type GameState, type Player, type PlayerId } from '@/engine';
import { useAiTurn } from '@/hooks/use-ai-turn';
import { connectAsHost, type PeerRoomHandle } from '@/lib/webrtc/peer-room';
import type { MediaConnection } from 'peerjs';
import type { ChatMessage, LobbyPlayerInfo, ResumeLobbyPlayerInfo, VoicePeerInfo } from '@/lib/webrtc/protocol';
import { generateRoomCode } from '@/lib/webrtc/protocol';
import { clearHostSession, loadHostSession, saveHostSession, saveJoinSession } from '@/lib/webrtc/persistence';
import type { SavedGame } from '@/lib/savedGames';

export type P2PHostPhase =
  | { phase: 'connecting' }
  | { phase: 'lobby'; roomCode: string; players: LobbyPlayerInfo[]; canStart: boolean; startGame: () => void }
  | {
      /** [DEFAULT — direct request: "For WebRTC a client can also save the game and resume it
       *  later as host .. it first shows the lobby where all players can connect again and then
       *  the host can click a resume game button"] Sits between 'connecting' and 'active' ONLY
       *  when this mount is resuming a SavedGame (see resumeFromSavedGame) rather than starting a
       *  fresh room or reloading an already-active one — those two keep going straight to 'lobby'
       *  / 'active' exactly as before, see useP2PHost's connect effect for the precedence rule. */
      phase: 'resume-lobby';
      roomCode: string;
      /** Computed fresh every render from originalPlayersRef × playersRef × aiControlledRef —
       *  same non-incremental-derivation pattern as 'active'/'lobby's own `players` field. */
      players: ResumeLobbyPlayerInfo[];
      aiControlledPlayerIds: ReadonlySet<PlayerId>;
      /** Same callback as the 'active' phase's setSeatAiControl below — reused rather than a
       *  second copy, it just broadcasts a resumeLobbyUpdate instead of a stateSync while the room
       *  is still in this phase (there's no live GameState to sync yet). */
      setSeatAiControl: (playerId: PlayerId, isAI: boolean) => void;
      /** The HOST'S OWN claim of one of the original seats — no network round trip needed, unlike
       *  a joiner's claim (see hooks/use-p2p-join.ts's claimSeat), because the host already IS the
       *  authority writing playersRef directly. */
      claimSeatForSelf: (playerId: PlayerId) => void;
      /** Host-only "go" button — ends the resume-lobby and starts the room playing for real, with
       *  whichever seats got claimed/AI-toggled and however many are still ghosts (deliberately
       *  not blocked on every seat being claimed — see components/p2p/ResumeHostLobby.tsx). */
      resumeGame: () => void;
    }
  | {
      phase: 'active';
      roomCode: string;
      state: GameState;
      dispatch: (action: Action) => boolean;
      error: string | null;
      isMyTurn: boolean;
      myPlayerId: PlayerId;
      /** [DEFAULT — direct request: "toggle Human/AI mid game .. transfer hosting .. kick a
       *  player .. a little chat"] Everything components/p2p/AdminMenu.tsx and ChatPanel.tsx need
       *  — bundled here rather than as separate hook calls because they're all facets of the same
       *  "I am the authoritative host" role this phase represents; a joiner's equivalent phase in
       *  hooks/use-p2p-join.ts exposes the read-only half of the same shape (no kick/toggle/
       *  transfer — those are host-only actions, never sent by a joiner). */
      players: LobbyPlayerInfo[];
      aiControlledPlayerIds: ReadonlySet<PlayerId>;
      setSeatAiControl: (playerId: PlayerId, isAI: boolean) => void;
      kickPlayer: (playerId: PlayerId) => void;
      transferHostTo: (playerId: PlayerId) => void;
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

interface HostInfo {
  name: string;
  color: string;
}

export interface UseP2PHostCallbacks {
  /** [DEFAULT — direct request: "transfer hosting to another player"] Fires once this device has
   *  finished handing off host duties (broadcast sent, own session re-seeded as a joiner, own
   *  Peer closed) — the caller (components/p2p/P2PApp.tsx) reacts by switching its `screen` state
   *  from 'host-room' to 'join-room', which unmounts this hook and mounts hooks/use-p2p-join.ts
   *  in its place. See transferHostTo below for the full sequence. */
  onTransferredAway?: () => void;
}

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;
const VOICE_RETRY_INTERVAL_MS = 2000;
const VOICE_CALL_STREAM_TIMEOUT_MS = 8000;

function normalizeLobbyName(name: string): string {
  return name.trim().toLowerCase();
}

function normalizeLobbyColor(color: string): string {
  return color.trim().toLowerCase();
}

function stableVoiceInitiator(a: PlayerId, b: PlayerId): boolean {
  return a < b;
}

export function useP2PHost(hostInfo: HostInfo, callbacks: UseP2PHostCallbacks = {}, resumeFromSavedGame?: SavedGame): P2PHostPhase {
  // [DEFAULT — direct request: "if the host reloads the tab it should be restored after reload
  // and let the clients reconnect to resume session"] Read once, at first mount — the whole
  // point of a lazy initializer here is that a persisted session (if any) governs THIS mount's
  // identity/room code from the very first render, not just after some later effect catches up.
  const [resumed] = useState(() => loadHostSession());
  // [DEFAULT — direct request: "a client can also save the game and resume it later as host"]
  // Also read once, at first mount, same reasoning as `resumed` above — and, per the direct
  // request's own precedence ("resumed" from an ordinary reload always wins over a genuinely new
  // resume-from-save, mirroring how `resumed` already outranks the `hostInfo` prop), only actually
  // captured when there's no `resumed` session to take priority over it.
  const [resumeSave] = useState(() => (resumed ? null : resumeFromSavedGame ?? null));
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
  // [DEFAULT — host reload restore, direct request: "a client can also save the game and resume
  // it later as host"] Seeded from the persisted session if reloading, else from a SavedGame if
  // resuming one, so either way the authoritative state is back from the very first render — not
  // just after the connect effect below gets around to it. `resumed` still wins over `resumeSave`
  // (see that state's own comment) — this is just the ref-level consequence of that precedence.
  const gameStateRef = useRef<GameState | null>(resumed?.gameState ?? resumeSave?.state ?? null); // authoritative — mutated only via applyAction
  // [DEFAULT — direct request: "switch a player from human to AI in case you're resuming a game
  // with less players than you started it"] originalPlayersRef holds the full roster the SAVED
  // game actually had (id/name/color straight off GameState.players) — the fixed, never-changing
  // reference the 'resume-lobby' phase's ghost roster (computeResumeRoster, in the connect effect
  // below) is built from. Only ever populated when resuming a save with no reload session to take
  // priority (see resumeSave above) — a fresh lobby or reload-resume never has an "original"
  // roster in this sense, they just have playersRef/lobbyPlayers.
  const originalPlayersRef = useRef<Player[]>(resumeSave?.state.players ?? []);
  // [DEFAULT — direct request: "a client can also save the game and resume it later as host"]
  // Tracks P2PHostPhase's OWN discriminant from inside closures that must not read the `phase`
  // React state directly — onJoinerConnected (below) is captured once when the connect effect
  // runs and would otherwise see a permanently stale value, exactly like gameStateRef/playersRef
  // already need ref-indirection for the same reason. Updated alongside every setPhase(...) call.
  const phaseRef = useRef<'connecting' | 'lobby' | 'resume-lobby' | 'active' | 'error'>('connecting');
  // Set inside the connect effect once the resolved room code (and this seat's effective
  // name/color) are known, then called from every state-mutating path — including dispatch/
  // startGame below, which are declared outside the effect via useCallback and would otherwise
  // have no stale-closure-safe way to reach those values. A ref, not a plain closure variable,
  // for the same reason gameStateRef/handleRef are refs: it needs to be readable from callbacks
  // that don't re-run when the effect does.
  const persistRef = useRef<() => void>(() => {});
  // syncLobbyState (defined inside the effect below, since it closes over setLobbyPlayers) needs
  // to also be callable from kickPlayer, which — like dispatch/startGame — is a useCallback
  // declared outside the effect. Same ref-indirection pattern as persistRef.
  const syncLobbyStateRef = useRef<() => LobbyPlayerInfo[]>(() => []);
  // [DEFAULT — direct request: "a client can also save the game and resume it later as host"]
  // Same reasoning/pattern as syncLobbyStateRef immediately above, for the 'resume-lobby' phase's
  // own roster — needed by claimSeatForSelf/resumeGame/setSeatAiControl, all useCallbacks declared
  // outside the connect effect.
  const syncResumeLobbyStateRef = useRef<() => ResumeLobbyPlayerInfo[]>(() => []);
  // [DEFAULT — direct request: "kick a player"] A kicked player who simply redials the same room
  // code (their own existing reconnect loop, hooks/use-p2p-join.ts, has no idea they were kicked)
  // would otherwise just walk right back in — checked in onJoinerConnected below, before they're
  // ever added back to the roster.
  const bannedPlayerIds = useRef(new Set<PlayerId>());
  // [DEFAULT — direct request: "toggle Human/AI mid game"] Mirrors GameState.currentPlayerId
  // against this set (via useAiTurn below) to decide whether the HOST itself should be the one
  // driving a given seat's turn — same ai/decideAction.ts hotseat already uses, just invoked from
  // the authoritative side of a P2P game instead of client-side pass-and-play. Not persisted
  // across a host reload (resets to "everyone human-controlled") — a disclosed, minor gap, not a
  // regression of anything that worked before this feature existed.
  // [DEFAULT — direct request: "a client can also save the game and resume it later as host"]
  // DOES seed from a SavedGame's own aiControlledPlayerIds, though (when genuinely resuming one,
  // i.e. `resumed` didn't already win) — unlike a reload, a resume-from-save is the FIRST time
  // this device has ever hosted this room, so there's no "reset to human" regression to worry
  // about; the save's own AI status is the only prior status that exists at all.
  const aiControlledRef = useRef(new Set<PlayerId>(resumeSave ? resumeSave.aiControlledPlayerIds ?? [] : []));
  // [DEFAULT — direct request: "transfer hosting to another player"] This device's OWN effective
  // name/color, captured once the connect effect resolves them — transferHostTo needs these to
  // seed its own post-handoff join session, but effectiveName/effectiveColor are otherwise local
  // consts scoped to the effect below.
  const effectiveNameRef = useRef(hostInfo.name);
  const effectiveColorRef = useRef(hostInfo.color);
  // [DEFAULT — direct request: "no need to enter a name again; just use one of the players"]
  // Mirrors selfSeatId (React state, below) for use inside the connect effect's closures — same
  // ref-indirection reason as everything else here, and specifically needed by relayChatRef so a
  // host who claimed a DIFFERENT seat than its raw myPlayerId still gets its own chat messages
  // attributed (and its unread-count check evaluated) against the seat it's actually playing as.
  const selfSeatIdRef = useRef<PlayerId | null>(null);
  // [DEFAULT — direct request: "a little chat in a second tab of sidebar"] Set inside the effect
  // once playersRef/handleRef are live — called from BOTH onJoinerMessage's 'chatSend' branch
  // (someone else's message) and sendChat below (this device's own), so both paths stamp
  // id/sentAt/name/color and broadcast identically. Same ref-indirection reason as persistRef.
  const relayChatRef = useRef<(text: string, fromPlayerId: PlayerId) => void>(() => {});
  const voicePeersRef = useRef<VoicePeerInfo[]>([]);
  const voiceCallsRef = useRef(new Map<PlayerId, MediaConnection>());
  const voiceRemoteRef = useRef(new Map<PlayerId, MediaStream>());
  const localVoiceStreamRef = useRef<MediaStream | null>(null);
  const voiceEnabledRef = useRef(false);
  const voiceMutedRef = useRef(false);
  const voiceRetryTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inboundVoiceUnsubRef = useRef<(() => void) | null>(null);
  const callbacksRef = useRef(callbacks);
  useEffect(() => {
    callbacksRef.current = callbacks;
  });

  const [phase, setPhase] = useState<'connecting' | 'lobby' | 'resume-lobby' | 'active' | 'error'>('connecting');
  const [roomCode, setRoomCode] = useState('');
  const [lobbyPlayers, setLobbyPlayers] = useState<LobbyPlayerInfo[]>([]);
  // [DEFAULT — direct request: "a client can also save the game and resume it later as host"]
  // React-visible mirror of computeResumeRoster() (defined in the connect effect below) — same
  // recompute-fresh-every-time relationship to originalPlayersRef/playersRef/aiControlledRef that
  // lobbyPlayers already has to playersRef.
  const [resumeLobbyPlayers, setResumeLobbyPlayers] = useState<ResumeLobbyPlayerInfo[]>([]);
  // [DEFAULT — direct request: "no need to enter a name again; just use one of the players"] Which
  // original seat THIS DEVICE (the host) has claimed for itself in a resume-lobby — see
  // claimSeatForSelf below. Deliberately separate from `myPlayerId` (the stable nanoid identifying
  // this device's underlying Peer/session, never reseated) rather than reusing it directly: a
  // fresh lobby or reload-resume host has no "claim" step at all, so this simply stays null for
  // them forever and every place that used to mean "this device's controllable seat" by reading
  // myPlayerId now reads `selfSeatId ?? myPlayerId` instead — for those two flows selfSeatId is
  // never set, so the fallback always resolves to the exact same value myPlayerId already was,
  // reproducing their existing behavior byte-for-byte.
  const [selfSeatId, setSelfSeatId] = useState<PlayerId | null>(null);
  // [DEFAULT — direct request: "a client can also save the game and resume it later as host"]
  // Deliberately NOT seeded from resumeSave (unlike gameStateRef above) — this is the value
  // useAiTurn below watches, and until resumeGame() actually fires, we're still in the ghost-
  // picker phase: an AI-controlled seat that happened to be mid-turn in the save must not start
  // auto-dispatching (and, via dispatch's own persistRef.current() call, silently persisting a
  // host session) before the host has even clicked Resume Game.
  const [gameState, setGameState] = useState<GameState | null>(resumed?.gameState ?? null);
  const [aiControlledPlayerIds, setAiControlledPlayerIds] = useState<ReadonlySet<PlayerId>>(
    new Set(resumeSave?.aiControlledPlayerIds ?? [])
  );
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [unreadChatCount, setUnreadChatCount] = useState(0);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voiceMuted, setVoiceMuted] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [remoteVoiceStreams, setRemoteVoiceStreams] = useState<{ playerId: PlayerId; name: string; color: string; stream: MediaStream }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  const refreshRemoteVoiceStreams = useCallback(() => {
    const snapshot = [...voiceRemoteRef.current.entries()].map(([playerId, stream]) => {
      const p = playersRef.current.get(playerId);
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
        // A stuck call blocks retries forever if it never emits stream/close/error.
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
    let handle: PeerRoomHandle & { roomCode: string };

    /** Recomputes the React-visible snapshot from playersRef (the real source of truth) and
     *  returns it, so callers can broadcast the exact same array they just rendered from. */
    function syncLobbyState(): LobbyPlayerInfo[] {
      const list = [...playersRef.current.values()];
      setLobbyPlayers(list);
      return list;
    }
    syncLobbyStateRef.current = syncLobbyState;

    /** [DEFAULT — direct request: "the lobby should display the original players slightly
     *  transparent .. it's also possible to switch a player from human to AI"] The fixed roster
     *  from the save (originalPlayersRef) crossed with who has actually claimed/AI'd each seat SO
     *  FAR in this resume attempt (playersRef/aiControlledRef) — recomputed fresh every call, same
     *  non-incremental style as syncLobbyState above, for the same reason (see this file's header
     *  comment on why playersRef/refs are the source of truth, not a carried-forward `prev`). */
    function computeResumeRoster(): ResumeLobbyPlayerInfo[] {
      return originalPlayersRef.current.map((original): ResumeLobbyPlayerInfo => {
        const claimant = playersRef.current.get(original.id);
        if (claimant) {
          return { playerId: original.id, name: original.name, color: original.color, isHost: claimant.isHost, status: 'connected' };
        }
        if (aiControlledRef.current.has(original.id)) {
          return { playerId: original.id, name: original.name, color: original.color, isHost: false, status: 'ai' };
        }
        return { playerId: original.id, name: original.name, color: original.color, isHost: false, status: 'ghost' };
      });
    }

    function syncResumeLobbyState(): ResumeLobbyPlayerInfo[] {
      const list = computeResumeRoster();
      setResumeLobbyPlayers(list);
      return list;
    }
    syncResumeLobbyStateRef.current = syncResumeLobbyState;

    function currentVoicePeers(localHandle: PeerRoomHandle): VoicePeerInfo[] {
      const peers: VoicePeerInfo[] = [{ playerId: myPlayerId, peerId: localHandle.selfId }];
      for (const [peerId, pid] of peerIdToPlayerId.current.entries()) {
        if (playersRef.current.has(pid)) peers.push({ playerId: pid, peerId });
      }
      return peers;
    }

    function broadcastVoicePeers(localHandle: PeerRoomHandle) {
      const peers = currentVoicePeers(localHandle);
      voicePeersRef.current = peers;
      localHandle.broadcast({ kind: 'voicePeers', peers });
      syncVoiceConnections();
    }

    (async () => {
      try {
        // [DEFAULT — host reload restore] Reopen the SAME room code if resuming, instead of
        // always generating a fresh one — connectAsHost's own SAME_CODE_RETRY_ATTEMPTS (see
        // peer-room.ts) gives a fast reload a real chance to reclaim it before falling back.
        handle = await connectAsHost(resumed?.roomCode ?? generateRoomCode(), {
          onJoinerConnected(peerId, meta) {
            if (cancelled) return;
            const activeHandle = handleRef.current ?? handle;

            if (meta.probe) {
              // [DEFAULT — direct request: "a client can also save the game and resume it later
              // as host"] A probe during resume-lobby needs the ghost roster, not the ordinary
              // waiting-room one — this is what lets the join-setup screen's probeLobby call
              // (lib/webrtc/peer-room.ts) tell the two cases apart before the user commits.
              if (phaseRef.current === 'resume-lobby') {
                activeHandle.send(peerId, { kind: 'resumeLobbyUpdate', players: computeResumeRoster() });
              } else {
                const roster = [...playersRef.current.values()];
                activeHandle.send(peerId, { kind: 'lobbyUpdate', players: roster });
              }
              setTimeout(() => activeHandle.disconnectPeer(peerId), 100);
              return;
            }
            // [DEFAULT — direct request: "kick a player"] Checked before anything else touches
            // the roster — a kicked player's own reconnect loop (hooks/use-p2p-join.ts) has no
            // idea they were kicked and will just redial the same room code; this is what stops
            // that from silently walking them back in. Applies in every phase, including
            // resume-lobby (checked below).
            if (bannedPlayerIds.current.has(meta.playerId)) {
              activeHandle.send(peerId, { kind: 'kicked', reason: 'Removed by the host' });
              setTimeout(() => activeHandle.disconnectPeer(peerId), 250);
              return;
            }

            // [DEFAULT — direct request: "the lobby should display the original players slightly
            // transparent and with a connect button so each player can simply connect to its old
            // player .. it's important to use the exact same name as before"] Resume-lobby has its
            // own claim/reconnect/ghost-peek logic, entirely separate from the ordinary lobby's
            // duplicate-name/duplicate-color rules below — those don't apply here at all, nobody
            // types a name for this path (see components/p2p/ResumeJoinLobby.tsx).
            if (phaseRef.current === 'resume-lobby') {
              peerIdToPlayerId.current.set(peerId, meta.playerId);
              const originalSeat = originalPlayersRef.current.find((p) => p.id === meta.playerId);
              const alreadyClaimed = playersRef.current.has(meta.playerId);
              if (originalSeat && !alreadyClaimed) {
                // A genuine claim — this stable id matches a real seat from the save and nobody
                // has it yet. Name/color come from the ORIGINAL save, never from meta — the
                // joiner's screen never even collects a name/color for this path (see
                // components/p2p/ResumeJoinLobby.tsx), but even if it somehow sent one, the save's
                // own identity is authoritative here.
                playersRef.current.set(meta.playerId, { playerId: meta.playerId, name: originalSeat.name, color: originalSeat.color, isHost: false });
                aiControlledRef.current.delete(meta.playerId); // claiming means a human took over
                setAiControlledPlayerIds(new Set(aiControlledRef.current));
                activeHandle.broadcast({ kind: 'resumeLobbyUpdate', players: syncResumeLobbyState() });
              } else if (originalSeat && alreadyClaimed) {
                // Reconnect for a seat this same stable id already claimed (a dropped connection,
                // a StrictMode throwaway mount) — idempotent, peerIdToPlayerId is already updated
                // above and nothing about the roster ACTUALLY changed, so no broadcast to anyone
                // else — but THIS connection still gets its own fresh snapshot directly (mirrors
                // the mid-game reconnect branch below, which always resends stateSync on reconnect
                // rather than assuming the reconnecting client's own state is still current).
                activeHandle.send(peerId, { kind: 'resumeLobbyUpdate', players: computeResumeRoster() });
              } else {
                // A fresh id, no ghost picked yet — every joiner's FIRST connection in this flow
                // looks like this. Just address them directly with the current roster so their own
                // screen can render the ghost picker; nothing to broadcast to anyone else.
                activeHandle.send(peerId, { kind: 'resumeLobbyUpdate', players: computeResumeRoster() });
              }
              return;
            }

            // Enforce unique lobby identity constraints across different seats.
            // Reconnects for the SAME stable playerId are allowed to keep their existing seat.
            const duplicateName = [...playersRef.current.values()].find(
              (p) => p.playerId !== meta.playerId && normalizeLobbyName(p.name) === normalizeLobbyName(meta.name)
            );
            if (duplicateName) {
              activeHandle.send(peerId, { kind: 'kicked', reason: `Name "${meta.name}" is already taken — choose a different name.` });
              setTimeout(() => activeHandle.disconnectPeer(peerId), 250);
              return;
            }

            const duplicateColor = [...playersRef.current.values()].find(
              (p) => p.playerId !== meta.playerId && normalizeLobbyColor(p.color) === normalizeLobbyColor(meta.color)
            );
            if (duplicateColor) {
              activeHandle.send(peerId, { kind: 'kicked', reason: `Color ${meta.color} is already taken — choose a different color.` });
              setTimeout(() => activeHandle.disconnectPeer(peerId), 250);
              return;
            }

            peerIdToPlayerId.current.set(peerId, meta.playerId);

            // [DEFAULT — direct request: "the admin can manage the players"] Kept current
            // regardless of phase now (previously only pre-game) — components/p2p/AdminMenu.tsx
            // needs an accurate live roster mid-game too, for the kick/AI-toggle player list.
            const alreadyKnown = playersRef.current.has(meta.playerId);
            playersRef.current.set(meta.playerId, { playerId: meta.playerId, name: meta.name, color: meta.color, isHost: false });
            const list = syncLobbyState();
            broadcastVoicePeers(handleRef.current ?? handle);

            if (gameStateRef.current) {
              // Game already started: this is either a genuine reconnect (welcome back — resend
              // the authoritative state) or, if that stable id was never in this game at all,
              // a straggler who dialed in after the lobby closed — same response either way,
              // there's no lobby to add them to anymore.
              handleRef.current?.send(peerId, {
                kind: 'stateSync',
                state: gameStateRef.current,
                aiControlledPlayerIds: [...aiControlledRef.current],
              });
              if (!alreadyKnown) activeHandle.broadcast({ kind: 'lobbyUpdate', players: list });
              return;
            }

            if (alreadyKnown) {
              // A second live connection for a stable id already on the roster — just bring
              // THIS connection's own view up to date, nothing changed for anyone else.
              activeHandle.send(peerId, { kind: 'lobbyUpdate', players: list });
            } else {
              activeHandle.broadcast({ kind: 'lobbyUpdate', players: list });
            }
          },
          onJoinerMessage(peerId, message) {
            if (cancelled) return;
            const stablePlayerId = peerIdToPlayerId.current.get(peerId);
            if (!stablePlayerId) return; // shouldn't happen — onJoinerConnected always runs first

            if (message.kind === 'requestSync') {
              // [DEFAULT — direct request: "a client can also save the game and resume it later
              // as host"] hooks/use-p2p-join.ts sends this unconditionally right after connecting
              // — including a fresh connection during resume-lobby, before any seat is claimed.
              // Answering with a real stateSync there would flip that joiner's phase straight to
              // 'active' (see its own stateSync case) and skip the ghost picker entirely; the
              // resumeLobbyUpdate onJoinerConnected already sent them moments earlier is the
              // correct — and sufficient — response for this phase, so there is nothing more to do.
              if (phaseRef.current === 'resume-lobby') return;
              if (gameStateRef.current) {
                handleRef.current?.send(peerId, {
                  kind: 'stateSync',
                  state: gameStateRef.current,
                  aiControlledPlayerIds: [...aiControlledRef.current],
                });
              }
              return;
            }
            if (message.kind === 'chatSend') {
              relayChatRef.current(message.text, stablePlayerId);
              return;
            }
            if (message.kind !== 'action') return;
            // [DEFAULT — direct request: "a client can also save the game and resume it later as
            // host"] gameStateRef.current is ALREADY populated during resume-lobby (seeded from
            // the save) — unlike the "arrived before the game started" case just below, this isn't
            // about the state being absent, it's about the room not having actually resumed play
            // yet. No legitimate client sends 'action' from the ghost-picker screen at all (see
            // components/p2p/ResumeJoinLobby.tsx), so this only ever guards against a stale/
            // malformed one.
            if (phaseRef.current === 'resume-lobby') return;
            const current = gameStateRef.current;
            if (!current) return; // action arrived before the game started — ignore
            // Never trust actorId from the wire alone — mirrors server/game-server.ts's
            // session-vs-actorId check for the HTTP transport; the analogous authority boundary
            // here is "which DataConnection did this arrive on."
            if (message.action.actorId !== stablePlayerId) {
              handleRef.current?.send(peerId, { kind: 'reject', reason: 'actorId does not match your connection' });
              return;
            }
            // [DEFAULT — direct request: "toggle Human/AI mid game"] A seat under AI control is
            // the HOST's own decideAction loop (useAiTurn below) to move, not whichever human used
            // to sit there — their own dispatch attempts (stale UI they haven't reloaded, or just
            // a race with the toggle) are rejected the same way any other illegal action would be.
            if (aiControlledRef.current.has(stablePlayerId)) {
              handleRef.current?.send(peerId, { kind: 'reject', reason: 'This seat is currently controlled by AI' });
              return;
            }
            try {
              const next = applyAction(current, message.action);
              gameStateRef.current = next;
              setGameState(next);
              persistRef.current();
              handleRef.current?.broadcast({ kind: 'stateSync', state: next, aiControlledPlayerIds: [...aiControlledRef.current] });
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
            if (handleRef.current) broadcastVoicePeers(handleRef.current);
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
        inboundVoiceUnsubRef.current = handle.onIncomingCall((fromPeerId, call) => {
          if (!voiceEnabledRef.current || !localVoiceStreamRef.current) {
            call.close();
            return;
          }
          const fromPlayerId = peerIdToPlayerId.current.get(fromPeerId);
          if (!fromPlayerId) {
            call.close();
            return;
          }
          for (const track of localVoiceStreamRef.current.getAudioTracks()) track.enabled = !voiceMutedRef.current;
          call.answer(localVoiceStreamRef.current);
          bindVoiceCall(fromPlayerId, call);
        });

        // [DEFAULT — host reload restore] Ignore the hostInfo PROP entirely when resuming — it
        // reflects whatever P2PApp happened to seed its own name/color state with on this fresh
        // mount (defaults, since the user never re-typed anything), not who this room actually
        // belongs to. The persisted session is the source of truth for "who am I" once resuming.
        const effectiveName = resumed?.name ?? hostInfo.name;
        const effectiveColor = resumed?.color ?? hostInfo.color;
        effectiveNameRef.current = effectiveName;
        effectiveColorRef.current = effectiveColor;
        voicePeersRef.current = [{ playerId: myPlayerId, peerId: handle.selfId }];

        persistRef.current = () => {
          saveHostSession({
            roomCode: handle.roomCode,
            hostPlayerId: myPlayerId,
            name: effectiveName,
            color: effectiveColor,
            gameState: gameStateRef.current,
          });
        };

        // [DEFAULT — direct request: "a little chat"] text/500-char cap is defensive against a
        // malformed/hostile peer, not a real UX limit — see ChatMessage's own comment for why
        // chat never touches GameState or applyAction.
        relayChatRef.current = (text, fromPlayerId) => {
          const trimmed = text.trim().slice(0, 500);
          if (!trimmed) return;
          const sender = playersRef.current.get(fromPlayerId);
          const msg = {
            id: nanoid(8),
            playerId: fromPlayerId,
            name: sender?.name ?? 'Player',
            color: sender?.color ?? '#888888',
            text: trimmed,
            sentAt: Date.now(),
          };
          setChatMessages((prev) => [...prev, msg]);
          // selfSeatIdRef.current ?? myPlayerId, not raw myPlayerId — see that ref's own comment.
          if (fromPlayerId !== (selfSeatIdRef.current ?? myPlayerId)) setUnreadChatCount((n) => n + 1);
          handleRef.current?.broadcast({ kind: 'chatMessage', message: msg });
        };

        if (resumed) {
          // Reload of an already-active-or-hosting room — completely unchanged behavior from
          // before resume-lobby existed (this branch never touches originalPlayersRef/resumeSave).
          playersRef.current.set(myPlayerId, { playerId: myPlayerId, name: effectiveName, color: effectiveColor, isHost: true });
          persistRef.current();
          if (gameStateRef.current) {
            // Resumed mid-game: the lobby is long over, go straight back to the board. The old
            // roster snapshot isn't restored into playersRef — clients reconnect on their own
            // retry loop (hooks/use-p2p-join.ts) and re-announce themselves via onJoinerConnected
            // above, which already re-sends stateSync to anyone recognized once gameStateRef is set.
            setGameState(gameStateRef.current);
            broadcastVoicePeers(handle);
            phaseRef.current = 'active';
            setPhase('active');
          } else {
            syncLobbyState();
            broadcastVoicePeers(handle);
            phaseRef.current = 'lobby';
            setPhase('lobby');
          }
        } else if (resumeSave) {
          // [DEFAULT — direct request: "a client can also save the game and resume it later as
          // host .. it first shows the lobby where all players can connect again and then the
          // host can click a resume game button"] gameStateRef/aiControlledRef were already seeded
          // from resumeSave at ref-creation time above — this just brings the React-visible
          // mirrors in line and puts the room into the ghost-picker phase instead of jumping
          // straight to 'active' (a reload would) or an empty 'lobby' (a fresh host would).
          // playersRef stays EMPTY here — unlike the two branches above, the host's own seat is
          // NOT auto-claimed; see claimSeatForSelf for how the host picks one of the original
          // seats for themself, same as any other joiner picks one. persistRef is intentionally
          // NOT invoked yet — see resumeGame() below, which is the point a resumed room actually
          // becomes reload-resumable, same as any other active hosted game becomes.
          setAiControlledPlayerIds(new Set(aiControlledRef.current));
          syncResumeLobbyState();
          broadcastVoicePeers(handle);
          phaseRef.current = 'resume-lobby';
          setPhase('resume-lobby');
        } else {
          playersRef.current.set(myPlayerId, { playerId: myPlayerId, name: effectiveName, color: effectiveColor, isHost: true });
          persistRef.current();
          syncLobbyState();
          broadcastVoicePeers(handle);
          phaseRef.current = 'lobby';
          setPhase('lobby');
        }
      } catch (err) {
        if (!cancelled) setFatal(err instanceof Error ? err.message : 'Failed to open room');
      }
    })();

    return () => {
      cancelled = true;
      inboundVoiceUnsubRef.current?.();
      inboundVoiceUnsubRef.current = null;
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
    phaseRef.current = 'active';
    setPhase('active');
    persistRef.current();
    handleRef.current?.broadcast({ kind: 'gameStarted', state: initial, aiControlledPlayerIds: [...aiControlledRef.current] });
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
      handleRef.current?.broadcast({ kind: 'stateSync', state: next, aiControlledPlayerIds: [...aiControlledRef.current] });
      return true;
    } catch (err) {
      if (err instanceof IllegalActionError) {
        setError(err.message);
        return false;
      }
      throw err;
    }
  }, []);

  // [DEFAULT — direct request: "toggle Human/AI mid game"] The host is the only device that ever
  // runs AI decisions in P2P play — a joiner's own hooks/use-p2p-join.ts never calls decideAction
  // at all, it only ever renders whatever stateSync says. Safe to call unconditionally: an empty
  // aiControlledPlayerIds (the common case) or a null-ish gameState (still connecting/lobby, via
  // useAiTurn's own null-state guard) both make this a no-op.
  useAiTurn(gameState, aiControlledPlayerIds, dispatch);

  const setSeatAiControl = useCallback((playerId: PlayerId, isAI: boolean) => {
    if (isAI) aiControlledRef.current.add(playerId);
    else aiControlledRef.current.delete(playerId);
    const next = new Set(aiControlledRef.current);
    setAiControlledPlayerIds(next);
    // [DEFAULT — direct request: "it's also possible to switch a player from human to AI in case
    // you're resuming a game with less players than you started it"] Reused as-is for the
    // 'resume-lobby' phase (see P2PHostPhase's own comment on this field) — but there's no live
    // GameState to stateSync yet in that phase, even though gameStateRef.current is ALREADY
    // non-null there (seeded from the save) — phaseRef, not gameStateRef, is what actually
    // distinguishes "resuming, not yet playing" from "genuinely active" here.
    if (phaseRef.current === 'resume-lobby') {
      handleRef.current?.broadcast({ kind: 'resumeLobbyUpdate', players: syncResumeLobbyStateRef.current() });
      return;
    }
    if (gameStateRef.current) {
      handleRef.current?.broadcast({ kind: 'stateSync', state: gameStateRef.current, aiControlledPlayerIds: [...next] });
    }
  }, []);

  // [DEFAULT — direct request: "no need to enter a name again; just use one of the players"] The
  // HOST'S OWN claim of an original seat — unlike a joiner's claimSeat (hooks/use-p2p-join.ts),
  // this needs no network round trip at all: the host already IS the authority that writes
  // playersRef directly for everyone else's claims too (see onJoinerConnected's resume-lobby
  // branch above), so claiming for itself is just... doing that, locally, then telling everyone.
  const claimSeatForSelf = useCallback(
    (playerId: PlayerId) => {
      const original = originalPlayersRef.current.find((p) => p.id === playerId);
      if (!original) return; // defensive — the UI only ever offers seats that are really ghosts
      setSelfSeatId((previous) => {
        if (previous && previous !== playerId) playersRef.current.delete(previous);
        return playerId;
      });
      selfSeatIdRef.current = playerId;
      playersRef.current.set(playerId, { playerId, name: original.name, color: original.color, isHost: true });
      aiControlledRef.current.delete(playerId); // claiming means a human (the host) took over
      setAiControlledPlayerIds(new Set(aiControlledRef.current));
      handleRef.current?.broadcast({ kind: 'resumeLobbyUpdate', players: syncResumeLobbyStateRef.current() });
    },
    []
  );

  // [DEFAULT — direct request: "the host can click a resume game button"] Host-only "go" button
  // for the 'resume-lobby' phase — ends it and starts the room playing for real, with whichever
  // seats got claimed/AI-toggled and however many are still ghosts (deliberately not blocked on
  // every seat being claimed — see components/p2p/ResumeHostLobby.tsx's own comment on why).
  const resumeGame = useCallback(() => {
    if (!resumeSave) return; // defensive — only meaningful in the resume-lobby phase
    // Already seeded at ref-creation time, but explicit/defensive here too — this is the moment
    // the room actually commits to playing, so there is no ambiguity left about what "the current
    // state" means from here on.
    gameStateRef.current = resumeSave.state;
    setGameState(gameStateRef.current);
    // [DEFAULT — direct request: "no need to enter a name again; just use one of the players"]
    // The 'active' phase exposes `players: lobbyPlayers` (LobbyPlayerInfo[], for AdminMenu/
    // ChatPanel) — but lobbyPlayers was never populated during resume-lobby (that phase syncs
    // resumeLobbyPlayers instead, a different shape entirely). playersRef itself IS already
    // correct (every claim, including the host's own via claimSeatForSelf, wrote straight into
    // it), so this just brings the React-visible mirror in line before anything downstream reads it.
    syncLobbyStateRef.current();
    phaseRef.current = 'active';
    setPhase('active');
    // From here on this is an ordinary active hosted game in every respect — including being
    // reload-resumable exactly like any other one, which is why persistRef is only invoked NOW
    // (see the resumeSave branch in the connect effect above for why it was withheld until here).
    persistRef.current();
    handleRef.current?.broadcast({ kind: 'gameStarted', state: gameStateRef.current, aiControlledPlayerIds: [...aiControlledRef.current] });
  }, [resumeSave]);

  const kickPlayer = useCallback((playerId: PlayerId) => {
    bannedPlayerIds.current.add(playerId);
    const targetPeerIds = [...peerIdToPlayerId.current.entries()].filter(([, pid]) => pid === playerId).map(([peerId]) => peerId);
    for (const peerId of targetPeerIds) handleRef.current?.send(peerId, { kind: 'kicked', reason: 'Removed by the host' });
    // Give the message a moment to actually reach the wire before pulling the connection out from
    // under it — same reasoning as transferHostTo's own send-then-close ordering below.
    setTimeout(() => {
      for (const peerId of targetPeerIds) handleRef.current?.disconnectPeer(peerId);
    }, 250);

    if (gameStateRef.current) {
      // Mid-game: the seat still exists in GameState (there's no "remove a player" engine action,
      // and turn order/determinism depend on the seat list staying stable) — put it under AI
      // control so a kicked seat never just stalls the game waiting on a human who's gone.
      aiControlledRef.current.add(playerId);
      const next = new Set(aiControlledRef.current);
      setAiControlledPlayerIds(next);
      handleRef.current?.broadcast({ kind: 'stateSync', state: gameStateRef.current, aiControlledPlayerIds: [...next] });
    } else if (playersRef.current.delete(playerId)) {
      const list = syncLobbyStateRef.current();
      handleRef.current?.broadcast({ kind: 'lobbyUpdate', players: list });
    }
  }, []);

  const transferHostTo = useCallback(
    (playerId: PlayerId) => {
      if (!handleRef.current || !roomCode) return;
      handleRef.current.broadcast({ kind: 'hostTransferring', toPlayerId: playerId });
      // [DEFAULT — direct request: "transfer hosting to another player" — seamless live handoff]
      // A brief delay so the broadcast above actually reaches the wire before this device tears
      // its own connection down (mirrors kickPlayer's identical reasoning). After that: seed a
      // join session under THIS SAME stable playerId (so the game keeps recognizing this seat as
      // "them" once they reconnect as a plain joiner — see hooks/use-p2p-join.ts's
      // stablePlayerIdFor, whose sessionStorage key this writes directly), clear the now-stale
      // host session, close this device's own Peer (freeing the room code for the new host to
      // claim — connectAsHost's SAME_CODE_RETRY_ATTEMPTS, lib/webrtc/peer-room.ts, already covers
      // the race where the new host's connectAsHost call and this teardown overlap), and hand
      // control back to components/p2p/P2PApp.tsx to mount hooks/use-p2p-join.ts in this hook's
      // place.
      setTimeout(() => {
        if (typeof window !== 'undefined') {
          window.sessionStorage.setItem(`hexrealms-p2p-playerid-${roomCode}`, myPlayerId);
        }
        saveJoinSession({ roomCode, name: effectiveNameRef.current, color: effectiveColorRef.current });
        clearHostSession();
        handleRef.current?.close();
        handleRef.current = null;
        callbacksRef.current.onTransferredAway?.();
      }, 300);
    },
    [roomCode, myPlayerId]
  );

  const sendChat = useCallback(
    (text: string) => {
      // selfSeatIdRef.current ?? myPlayerId — see that ref's own comment for why (host chatting
      // after claiming a resumed seat other than its raw identity).
      relayChatRef.current(text, selfSeatIdRef.current ?? myPlayerId);
    },
    [myPlayerId]
  );
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
  if (phase === 'lobby') {
    return { phase: 'lobby', roomCode, players: lobbyPlayers, canStart: lobbyPlayers.length >= MIN_PLAYERS && lobbyPlayers.length <= MAX_PLAYERS, startGame };
  }
  if (phase === 'resume-lobby') {
    return { phase: 'resume-lobby', roomCode, players: resumeLobbyPlayers, aiControlledPlayerIds, setSeatAiControl, claimSeatForSelf, resumeGame };
  }
  // phase === 'active'
  // [DEFAULT — direct request: "no need to enter a name again; just use one of the players"] The
  // seat THIS DEVICE actually plays as — selfSeatId once a resume-lobby claim has happened,
  // otherwise myPlayerId itself (a fresh lobby / reload-resume host never touches selfSeatId, so
  // this is always exactly the pre-existing value for those two flows — see selfSeatId's own
  // comment above for why that reproduces their behavior byte-for-byte).
  const effectiveSelfId = selfSeatId ?? myPlayerId;
  return {
    phase: 'active',
    roomCode,
    state: gameState!,
    dispatch,
    error,
    isMyTurn: gameState!.currentPlayerId === effectiveSelfId && !aiControlledPlayerIds.has(effectiveSelfId),
    myPlayerId: effectiveSelfId,
    players: lobbyPlayers,
    aiControlledPlayerIds,
    setSeatAiControl,
    kickPlayer,
    transferHostTo,
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
