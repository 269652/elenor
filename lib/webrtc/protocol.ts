/**
 * [DEFAULT — WebRTC P2P play, direct request: "implement webrtc host and connect"] Message
 * envelope for the P2P transport (lib/webrtc/peer-room.ts) — kept in its own file, separate from
 * that one, because peer-room.ts imports the browser-only `peerjs` package (real WebRTC/
 * RTCPeerConnection) and can't run under Vitest's Node environment; everything in THIS file is
 * plain data + arithmetic, so it stays unit-testable.
 *
 * Design in one paragraph — host-as-sequencer, not a leaderless mesh: the host's own browser
 * (not a server anyone runs or pays for) is the single point every joiner's DataConnection
 * connects to (a star, not a full mesh — matches "host a room, others connect" literally), and
 * the sole arbiter of what actually happened. But "arbiter" here just means "runs the same pure
 * engine/reducer.ts applyAction every peer already runs" (docs/data-model.md's determinism
 * guarantee) — not a privileged rules engine of its own. A joiner attempting to act out of turn
 * is already rejected LOCALLY by requireCurrentPlayer before it's even sent over the wire — the
 * engine's own invariants are the only "consensus mechanism" this needs, exactly per the
 * original ask. This trades a fully decentralized mesh (no single point of failure, meaningfully
 * harder to get right, and unnecessary for a 2-6 seat casual game) for one explicit limitation:
 * if the host's tab closes, the game stops for everyone — the same limitation hotseat already
 * has (one shared device), which the server-backed Play Online mode doesn't. That's a deliberate,
 * documented tradeoff for a first version, not an oversight.
 */

import type { Action, GameState, PlayerId } from '@/engine';

export interface LobbyPlayerInfo {
  playerId: PlayerId;
  name: string;
  color: string;
  isHost: boolean;
}

/** [DEFAULT — direct request: "a little chat in a second tab of sidebar"] Always relayed THROUGH
 *  the host (a joiner sends `chatSend`, never a raw ChatMessage) so id/sentAt come from one place
 *  and every peer — including the sender — ends up with the exact same message, same as how
 *  `action`/`stateSync` already work. Not part of GameState: chat has no bearing on game rules or
 *  determinism, and keeping it out of the engine's own state means it never needs to round-trip
 *  through applyAction, get saved into hotseat/P2P persistence, or worry an unrelated engine
 *  change could ever touch it. */
export interface ChatMessage {
  id: string;
  playerId: PlayerId;
  name: string;
  color: string;
  text: string;
  sentAt: number;
}

/** What a joiner hands the host as PeerJS connection metadata (peer.connect's `metadata` option,
 *  visible to the host synchronously in its 'connection' event — no round trip needed). Carries
 *  a STABLE playerId (minted once client-side, persisted across reconnects — see
 *  hooks/use-p2p-join.ts's stablePlayerIdFor) so the host can recognize "this is the same human
 *  reconnecting" even though PeerJS hands out a brand-new ephemeral connection id every time. */
export interface JoinerMetadata {
  name: string;
  color: string;
  playerId: PlayerId;
  /** Lightweight lobby peek from join setup — not a real seat join. */
  probe?: boolean;
}

/** Stable player id + current PeerJS connection id for direct media calls between clients. */
export interface VoicePeerInfo {
  playerId: PlayerId;
  peerId: string;
}

/** Every message that ever crosses a DataConnection, either direction. PeerJS serializes plain
 *  objects on its own (default 'binary-utf8' pack), so these are sent as-is via conn.send(). */
export type P2PMessage =
  /** Host -> every joiner, whenever the waiting-room roster changes (join/leave). */
  | { kind: 'lobbyUpdate'; players: LobbyPlayerInfo[] }
  /** Host -> every joiner, once: the lobby is over, here is the real GameState to play.
   *  aiControlledPlayerIds travels alongside state for the same reason stateSync's copy does —
   *  see that field's own comment below. */
  | { kind: 'gameStarted'; state: GameState; aiControlledPlayerIds: PlayerId[] }
  /** Joiner -> host: "I'd like to apply this action." Host validates via applyAction and either
   *  broadcasts the resulting stateSync to everyone, or replies reject to just this sender. */
  | { kind: 'action'; action: Action }
  /** Host -> every joiner (including, harmlessly, an echo back to whoever sent the action that
   *  caused it): the new authoritative state. Full-state rather than action-only on purpose —
   *  self-healing against any local drift instead of silently compounding it, at a bandwidth
   *  cost this transport (no server bill, no rate limits) can afford.
   *  [DEFAULT — direct request: "toggle Human/AI mid game"] aiControlledPlayerIds rides along on
   *  EVERY stateSync (not a separately-synchronized message) so it can never drift out of step
   *  with the state it describes — a reconnecting/late joiner gets both atomically from whichever
   *  stateSync they happen to receive first, with nothing extra to request or race against. */
  | { kind: 'stateSync'; state: GameState; aiControlledPlayerIds: PlayerId[] }
  /** Host -> the one joiner whose action didn't validate (state moved under them, stale UI,
   *  etc.) — lets that peer's optimistic local apply roll back with a real reason shown. */
  | { kind: 'reject'; reason: string }
  /** Joiner -> host, sent right after reconnecting (see peer-room.ts's reconnect handling) — "I
   *  might have missed messages while disconnected, send me the current authoritative state." */
  | { kind: 'requestSync' }
  /** Host -> the one joiner being removed, immediately before the host closes that connection —
   *  [DEFAULT — direct request: "kick a player"] lets that peer show a real reason ("removed by
   *  the host") instead of the generic reconnect-failed error a plain disconnect would produce. */
  | { kind: 'kicked'; reason: string }
  /** Host -> every joiner (target included) — [DEFAULT — direct request: "transfer hosting to
   *  another player"] announces a live handoff is starting. The target peer reacts by seeding
   *  itself a host session and taking over as the new room's Peer (same room code — see
   *  hooks/use-p2p-host.ts's transferHostTo and hooks/use-p2p-join.ts's onHostMessage); the old
   *  host reacts to ITS OWN call to transferHostTo, not to this broadcast (it already knows).
   *  Every other joiner needs no special handling at all: their existing onHostDisconnected retry
   *  loop (hooks/use-p2p-join.ts) already reconnects to the same room code, and connectAsHost's
   *  existing SAME_CODE_RETRY_ATTEMPTS (lib/webrtc/peer-room.ts) already covers the brief window
   *  where the new host's connectAsHost call and the old host's connection teardown race. */
  | { kind: 'hostTransferring'; toPlayerId: PlayerId }
  /** Joiner -> host: "relay this chat message." Never a raw ChatMessage — see that type's own
   *  comment for why id/sentAt are always host-assigned. */
  | { kind: 'chatSend'; text: string }
  /** Host -> every joiner (sender included, so their own message renders from the same code path
   *  as everyone else's rather than an optimistic local echo that could end up styled/ordered
   *  differently). */
  | { kind: 'chatMessage'; message: ChatMessage }
  /** Host -> every joiner: current direct-call address book for voice chat. */
  | { kind: 'voicePeers'; peers: VoicePeerInfo[] };

/** Human-typeable room code: Crockford-ish alphabet (no 0/O/1/I/L) so it reads back unambiguously
 *  read aloud or over chat. This is a TRANSPORT/session identifier, not game state — unrelated to
 *  and deliberately not reusing engine/rng.ts's deterministic RngStream (that exists so REPLAYING
 *  a game is reproducible; a room code has no such requirement, plain Math.random() is correct
 *  and simpler here). Doubles as the host's PeerJS ID (see roomCodeToPeerId) — there is no
 *  separate "room registry" anywhere, the code IS the address. */
const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const ROOM_CODE_LENGTH = 5;

export function generateRoomCode(): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

/** True for anything a user could plausibly have typed/pasted as a room code — used to validate
 *  the join form before ever touching the network. Case-insensitive; normalizeRoomCode below
 *  handles casing and stray whitespace. */
export function isPlausibleRoomCode(input: string): boolean {
  const normalized = normalizeRoomCode(input);
  return normalized.length === ROOM_CODE_LENGTH && [...normalized].every((c) => ROOM_CODE_ALPHABET.includes(c));
}

export function normalizeRoomCode(input: string): string {
  return input.trim().toUpperCase();
}

/** The public PeerJS cloud broker (0.peerjs.com, PeerJS's zero-config default signaling server —
 *  see peer-room.ts) is a single shared ID namespace across every app that uses PeerJS's default
 *  settings, not just this one. This prefix keeps our room codes from ever colliding with an
 *  unrelated app or user's peer ID there, and lets peerIdToRoomCode reliably tell "one of ours"
 *  apart from anything else on the broker. */
const PEER_ID_PREFIX = 'hexrealms-room-';

export function roomCodeToPeerId(roomCode: string): string {
  return `${PEER_ID_PREFIX}${normalizeRoomCode(roomCode)}`;
}

export function peerIdToRoomCode(peerId: string): string | null {
  return peerId.startsWith(PEER_ID_PREFIX) ? peerId.slice(PEER_ID_PREFIX.length) : null;
}
