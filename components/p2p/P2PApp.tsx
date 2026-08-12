'use client';

/**
 * [DEFAULT — WebRTC P2P play, direct request: "implement webrtc host and connect"] The whole
 * flow for the new "Play P2P" landing-page entry: pick a name/color, then either host a room
 * (hooks/use-p2p-host.ts) or join one by code (hooks/use-p2p-join.ts). No server, no database —
 * see lib/webrtc/protocol.ts's file header for the transport design. Mirrors HotseatApp.tsx's
 * structural split: a lightweight setup screen, then a component that only mounts (and only
 * calls its connecting hook) once the player has actually committed to hosting/joining.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { GameBoardApp } from '@/components/GameBoardApp';
import { BTN_GHOST, BTN_PRIMARY, BTN_SECONDARY, INPUT, PANEL } from '@/components/uiClasses';
import { useP2PHost, type P2PHostPhase } from '@/hooks/use-p2p-host';
import { useP2PJoin, type P2PJoinPhase } from '@/hooks/use-p2p-join';
import { isPlausibleRoomCode, normalizeRoomCode, type LobbyPlayerInfo } from '@/lib/webrtc/protocol';
import { probeLobby, type LobbyProbeResult } from '@/lib/webrtc/peer-room';
import { clearHostSession, clearJoinSession, loadHostSession, loadJoinSession, saveJoinSession } from '@/lib/webrtc/persistence';
import { loadSavedGames, type SavedGame } from '@/lib/savedGames';
import type { PlayerId } from '@/engine';
import type { P2PRoomContext } from './types';
import { ShareRoomCode } from './ShareRoomCode';
import { ResumeHostLobby } from './ResumeHostLobby';
import { ResumeJoinLobby } from './ResumeJoinLobby';

const PALETTE = ['#ef4444', '#3b82f6', '#22c55e', '#eab308', '#a855f7', '#f97316'];
const DEFAULT_NAMES = ['Alice', 'Bob', 'Carol', 'Dave', 'Erin', 'Frank'];

function randomDefaultName(): string {
  return DEFAULT_NAMES[Math.floor(Math.random() * DEFAULT_NAMES.length)];
}

// ── Shared bits ──────────────────────────────────────────────────────────────────────────────

/** [DEFAULT — direct request: "WebRTC screens should render exactly the same as hotseat UI
 *  elements and make use of whole screen"] Every non-game P2P screen (menu, setup, lobby,
 *  connecting, error) wants the same centered-panel treatment components/HotseatApp.tsx gives its
 *  own setup screen — but the ACTIVE GAME BOARD must not be wrapped in this: HotseatApp's
 *  LocalGame returns GameBoardApp completely unwrapped so its grid fills the page's natural block
 *  width/height, and P2PHostRoom/P2PJoinRoom below now do the same for their own game-board
 *  return. Scoping the centering to just this wrapper (used per-screen, not once around the whole
 *  of P2PApp) is what makes that possible. */
function CenteredScreen({ children }: { children: ReactNode }) {
  return <div className="flex h-full w-full items-center justify-center overflow-y-auto p-4">{children}</div>;
}

function ConnectingScreen({ label, onCancel }: { label: string; onCancel?: () => void }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 p-6 text-center">
      <span className="text-3xl motion-safe:animate-pulse" aria-hidden="true">
        🔗
      </span>
      <p className="text-sm text-hx-ink-dim">{label}</p>
      {onCancel && (
        <button type="button" onClick={onCancel} className={BTN_GHOST}>
          ✖ Leave room
        </button>
      )}
    </div>
  );
}

function ErrorScreen({ message, onBack }: { message: string; onBack: () => void }) {
  return (
    <div className={`${PANEL} mx-auto flex max-w-md flex-col gap-3 text-center`}>
      <p className="text-sm text-hx-blood">⚠️ {message}</p>
      <button type="button" onClick={onBack} className={BTN_SECONDARY}>
        ← Back
      </button>
    </div>
  );
}

function LobbyRoster({ players }: { players: LobbyPlayerInfo[] }) {
  return (
    <ul className="flex flex-col divide-y divide-hx-border overflow-hidden rounded-sm border border-hx-border">
      {players.map((p) => (
        <li key={p.playerId} className="flex items-center gap-2 px-2 py-1.5 text-sm text-hx-ink">
          <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: p.color }} />
          <span className="flex-1">{p.name}</span>
          {p.isHost && <span className="font-mono text-[10px] uppercase tracking-wide text-hx-ink-faint">host</span>}
        </li>
      ))}
    </ul>
  );
}

// ShareRoomCode now lives in ./ShareRoomCode.tsx — see that file's own header comment for why it
// was extracted out of here (components/p2p/ResumeHostLobby.tsx needs it too, without a circular
// import back into this file).

// ── Host ─────────────────────────────────────────────────────────────────────────────────────

function HostLobby({ hostState, onLeave }: { hostState: Extract<P2PHostPhase, { phase: 'lobby' }>; onLeave: () => void }) {
  return (
    <div className={`${PANEL} mx-auto flex max-w-md flex-col gap-4`}>
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-xl font-bold text-hx-ink">🏰 Waiting for players</h2>
        <p className="text-sm text-hx-ink-dim">Everyone connects directly to your browser over WebRTC — no server, no account needed.</p>
      </div>
      <ShareRoomCode roomCode={hostState.roomCode} />
      <div className="flex flex-col gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wide text-hx-ink-faint">Players ({hostState.players.length}/6)</span>
        <LobbyRoster players={hostState.players} />
      </div>
      <button type="button" disabled={!hostState.canStart} onClick={hostState.startGame} className={BTN_PRIMARY}>
        {hostState.canStart ? '▶ Start Game' : `Need at least 2 players (have ${hostState.players.length})`}
      </button>
      {/* [DEFAULT — direct request: "add exit game button somewhere"] Closing this room (not
          just backing out of the setup form) is what actually needs to clear the persisted
          session — see onLeave, wired to clearHostSession in P2PApp. */}
      <button type="button" onClick={onLeave} className={BTN_GHOST}>
        ✖ Close room
      </button>
    </div>
  );
}

function P2PHostRoom({
  name,
  color,
  onBack,
  onLeave,
  onTransferredAway,
  resumeFromSavedGame,
}: {
  name: string;
  color: string;
  onBack: () => void;
  onLeave: () => void;
  /** [DEFAULT — direct request: "transfer hosting to another player"] Room code is only known
   *  once useP2PHost resolves it (below) — not available at the moment this callback is WIRED
   *  UP (that has to happen before the hook call, as its own param) — so it's threaded through
   *  as an argument here instead of closed over, and the caller (P2PApp) uses it to seed
   *  `committedRoomCode` before switching `screen` to 'join-room'. */
  onTransferredAway: (roomCode: string) => void;
  /** [DEFAULT — direct request: "a client can also save the game and resume it later as host"]
   *  Set only when this mount came from the menu's "Resume a saved game" flow — see
   *  hooks/use-p2p-host.ts's own param of the same name for the precedence rule (an ordinary
   *  reload of an already-hosting session always wins over this). */
  resumeFromSavedGame?: SavedGame;
}) {
  const hostInfo = useMemo(() => ({ name, color }), [name, color]);
  const roomCodeRef = useRef('');
  const result = useP2PHost(
    hostInfo,
    {
      onTransferredAway: () => onTransferredAway(roomCodeRef.current),
    },
    resumeFromSavedGame
  );
  // Written from an effect, not during render — this project's react-hooks/refs rule forbids
  // mutating a ref mid-render (see use-p2p-host.ts's identical comment on the READ side of this
  // same rule). Still up to date by the time onTransferredAway can possibly fire: that only ever
  // happens from a later user click, well after this effect has had a chance to run.
  useEffect(() => {
    if (result.phase === 'lobby' || result.phase === 'resume-lobby' || result.phase === 'active') roomCodeRef.current = result.roomCode;
  });

  if (result.phase === 'connecting') return <CenteredScreen><ConnectingScreen label="Opening a room…" onCancel={onLeave} /></CenteredScreen>;
  if (result.phase === 'error') return <CenteredScreen><ErrorScreen message={result.message} onBack={onBack} /></CenteredScreen>;
  if (result.phase === 'lobby') return <CenteredScreen><HostLobby hostState={result} onLeave={onLeave} /></CenteredScreen>;
  if (result.phase === 'resume-lobby') return <CenteredScreen><ResumeHostLobby hostState={result} onLeave={onLeave} /></CenteredScreen>;
  // Unwrapped, same as components/HotseatApp.tsx's LocalGame — GameBoardApp's own grid fills the
  // page's full block width/height; a centering wrapper here would shrink it to content size.
  const ctx: P2PRoomContext = {
    isHost: true,
    myPlayerId: result.myPlayerId,
    players: result.players,
    aiControlledPlayerIds: result.aiControlledPlayerIds,
    onKick: result.kickPlayer,
    onToggleAi: result.setSeatAiControl,
    onTransferHost: result.transferHostTo,
    chatMessages: result.chatMessages,
    unreadChatCount: result.unreadChatCount,
    sendChat: result.sendChat,
    markChatRead: result.markChatRead,
    voiceEnabled: result.voiceEnabled,
    voiceMuted: result.voiceMuted,
    voiceError: result.voiceError,
    remoteVoiceStreams: result.remoteVoiceStreams,
    enableVoice: result.enableVoice,
    disableVoice: result.disableVoice,
    toggleVoiceMuted: result.toggleVoiceMuted,
  };
  return <GameBoardApp state={result.state} dispatch={result.dispatch} error={result.error} isMyTurn={result.isMyTurn} onExit={onLeave} p2p={ctx} />;
}

// ── Join ─────────────────────────────────────────────────────────────────────────────────────

function P2PJoinRoom({
  roomCode,
  name,
  color,
  onBack,
  onLeave,
  onBecameHost,
  autoClaimPlayerId,
}: {
  roomCode: string;
  name: string;
  color: string;
  onBack: () => void;
  onLeave: () => void;
  /** [DEFAULT — direct request: "transfer hosting to another player"] See
   *  hooks/use-p2p-join.ts's UseP2PJoinCallbacks — the hook has already seeded a host session to
   *  resume into by the time this fires, so all P2PApp needs to do is switch `screen`. */
  onBecameHost: () => void;
  /** [DEFAULT — direct request: "no need to enter a name again; just use one of the players"] Set
   *  when the join-setup screen itself already showed the ghost picker (because probeLobby found
   *  a resume-lobby there) and the player picked a ghost before ever committing to join — this
   *  mount claims it automatically the moment the connection is ready, instead of making them
   *  click "Connect" a second time once they land here. */
  autoClaimPlayerId?: PlayerId;
}) {
  const myInfo = useMemo(() => ({ name, color }), [name, color]);
  const result: P2PJoinPhase = useP2PJoin(roomCode, myInfo, { onBecameHost });
  const autoClaimedRef = useRef(false);

  useEffect(() => {
    if (!autoClaimPlayerId || autoClaimedRef.current) return;
    if (result.phase !== 'resume-lobby') return;
    const target = result.players.find((p) => p.playerId === autoClaimPlayerId);
    if (!target) return; // roster hasn't arrived yet, or this id somehow isn't in it — try again next render
    autoClaimedRef.current = true;
    result.claimSeat(target.playerId, target.name, target.color);
  }, [autoClaimPlayerId, result]);

  if (result.phase === 'connecting') return <CenteredScreen><ConnectingScreen label={`Connecting to room ${roomCode}…`} onCancel={onLeave} /></CenteredScreen>;
  if (result.phase === 'error') return <CenteredScreen><ErrorScreen message={result.message} onBack={onBack} /></CenteredScreen>;
  if (result.phase === 'lobby') {
    return (
      <CenteredScreen>
        <div className={`${PANEL} mx-auto flex max-w-md flex-col gap-4`}>
          <div className="flex flex-col gap-1">
            <h2 className="font-display text-xl font-bold text-hx-ink">🚪 Room {roomCode}</h2>
            <p className="text-sm text-hx-ink-dim">Waiting for the host to start the game…</p>
          </div>
          <LobbyRoster players={result.players} />
          <button type="button" onClick={onLeave} className={BTN_GHOST}>
            ✖ Leave room
          </button>
        </div>
      </CenteredScreen>
    );
  }
  if (result.phase === 'resume-lobby') {
    return (
      <CenteredScreen>
        <div className={`${PANEL} mx-auto flex max-w-md flex-col gap-4`}>
          <div className="flex flex-col gap-1">
            <h2 className="font-display text-xl font-bold text-hx-ink">🚪 Room {roomCode}</h2>
          </div>
          <ResumeJoinLobby players={result.players} myPlayerId={result.myPlayerId} onClaim={result.claimSeat} />
          <button type="button" onClick={onLeave} className={BTN_GHOST}>
            ✖ Leave room
          </button>
        </div>
      </CenteredScreen>
    );
  }
  // Unwrapped — see P2PHostRoom's identical comment above.
  const ctx: P2PRoomContext = {
    isHost: false,
    myPlayerId: result.myPlayerId,
    players: result.players,
    aiControlledPlayerIds: result.aiControlledPlayerIds,
    chatMessages: result.chatMessages,
    unreadChatCount: result.unreadChatCount,
    sendChat: result.sendChat,
    markChatRead: result.markChatRead,
    voiceEnabled: result.voiceEnabled,
    voiceMuted: result.voiceMuted,
    voiceError: result.voiceError,
    remoteVoiceStreams: result.remoteVoiceStreams,
    enableVoice: result.enableVoice,
    disableVoice: result.disableVoice,
    toggleVoiceMuted: result.toggleVoiceMuted,
  };
  return <GameBoardApp state={result.state} dispatch={result.dispatch} error={result.error} isMyTurn={result.isMyTurn} onExit={onLeave} p2p={ctx} />;
}

// ── Setup ────────────────────────────────────────────────────────────────────────────────────

// [DEFAULT — direct request: "a client can also save the game and resume it later as host"]
// 'resume-setup' is the new "pick which saved P2P game to resume" screen, reached from the menu
// — distinct from 'host-setup' (which collects name/color for a FRESH room) since resuming a save
// needs neither, the identities all come from the save itself once the host claims a seat.
type Screen = 'menu' | 'host-setup' | 'host-room' | 'join-setup' | 'join-room' | 'resume-setup';

export function P2PApp({ initialRoomCode, onExit }: { initialRoomCode?: string; onExit: () => void }) {
  // [DEFAULT — direct request: "when a client reloads the tab he should be reconnected .. if
  // the host reloads the tab it should be restored after reload and let the clients reconnect"]
  // Read once, at mount — governs which screen this component STARTS on, so a reload jumps
  // straight back into an in-progress room instead of the menu/setup screens. Host takes
  // priority if somehow both exist (shouldn't happen in normal use, but a device can't
  // meaningfully be both at once, and "I was hosting" is the more consequential state to lose).
  //
  // Only resumes when there's no URL room code, OR the URL's room code matches the persisted
  // session's — a link to a DIFFERENT room (someone else's invite, opened in a tab that still
  // has an old session sitting in sessionStorage) should go to that room's join-setup screen,
  // not silently hijack it back into the stale one.
  const [resumedHost] = useState(() => {
    const s = loadHostSession();
    if (!s) return null;
    if (initialRoomCode && normalizeRoomCode(initialRoomCode) !== s.roomCode) return null;
    return s;
  });
  const [resumedJoin] = useState(() => {
    if (resumedHost) return null;
    const s = loadJoinSession();
    if (!s) return null;
    if (initialRoomCode && normalizeRoomCode(initialRoomCode) !== s.roomCode) return null;
    return s;
  });

  const [screen, setScreen] = useState<Screen>(() => {
    if (resumedHost) return 'host-room';
    if (resumedJoin) return 'join-room';
    return initialRoomCode ? 'join-setup' : 'menu';
  });
  const [name, setName] = useState(() => resumedHost?.name ?? resumedJoin?.name ?? randomDefaultName());
  const [color, setColor] = useState(() => resumedHost?.color ?? resumedJoin?.color ?? PALETTE[0]);
  const [roomCodeInput, setRoomCodeInput] = useState(resumedJoin?.roomCode ?? initialRoomCode ?? '');
  const [committedRoomCode, setCommittedRoomCode] = useState(resumedJoin?.roomCode ?? '');
  // [DEFAULT — direct request: "a client can also save the game and resume it later as host"]
  // Which SavedGame the menu's "Resume a saved game" flow picked — threaded into P2PHostRoom's
  // resumeFromSavedGame prop once `screen` becomes 'host-room'. Explicitly cleared whenever a
  // FRESH (non-resume) host flow starts (see the menu screen's "Host a room" button below) so a
  // later ordinary host doesn't accidentally inherit a stale save from an earlier resume attempt.
  const [resumeSave, setResumeSave] = useState<SavedGame | null>(null);
  // [DEFAULT — direct request: "no need to enter a name again; just use one of the players"]
  // Which original seat the join-setup screen's ghost picker already chose, if this room turned
  // out to be a resume-lobby BEFORE the player ever committed to joining — threaded into
  // P2PJoinRoom so it can claim that seat automatically the instant its connection is ready.
  const [autoClaimPlayerId, setAutoClaimPlayerId] = useState<PlayerId | undefined>(undefined);

  /** The top-level "leave P2P entirely" exit (landing page's Back / the shareable-link page's
   *  router.push('/')) should never leave a stale session behind for a LATER visit to silently
   *  auto-resume into — clear both defensively, harmless if neither existed. */
  function exitP2P() {
    clearHostSession();
    clearJoinSession();
    onExit();
  }

  function leaveHostRoom() {
    clearHostSession();
    setResumeSave(null);
    setScreen('menu');
  }

  function leaveJoinRoom() {
    clearJoinSession();
    setAutoClaimPlayerId(undefined);
    setScreen('menu');
  }

  // [DEFAULT — direct request: "a client can also save the game and resume it later as host"]
  // probeLobby now resolves a discriminated union (lib/webrtc/peer-room.ts's LobbyProbeResult) —
  // an ordinary from-scratch lobby, or a resume-lobby's fixed ghost roster. Stored whole (not
  // unwrapped into a plain players array like before) so the render below can branch on `mode`.
  const [joinLobbyProbeResult, setJoinLobbyProbeResult] = useState<LobbyProbeResult | null>(null);
  const [joinLobbyProbeBusy, setJoinLobbyProbeBusy] = useState(false);
  const [joinLobbyProbeResolvedCode, setJoinLobbyProbeResolvedCode] = useState('');
  const joinProbeCode = useMemo(() => {
    if (screen !== 'join-setup') return '';
    const code = normalizeRoomCode(roomCodeInput);
    return isPlausibleRoomCode(code) ? code : '';
  }, [screen, roomCodeInput]);

  useEffect(() => {
    if (!joinProbeCode) return;
    let cancelled = false;
    const t = setTimeout(() => {
      if (!cancelled) setJoinLobbyProbeBusy(true);
      void probeLobby(joinProbeCode)
        .then((result) => {
          if (!cancelled) setJoinLobbyProbeResult(result);
        })
        .catch(() => {
          // Keep last known preview on transient probe failures.
        })
        .finally(() => {
          if (!cancelled) {
            setJoinLobbyProbeBusy(false);
            setJoinLobbyProbeResolvedCode(joinProbeCode);
          }
        });
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [joinProbeCode]);

  function renderNameColorFields(options?: { disabledColors?: ReadonlySet<string> }) {
    const disabledColors = options?.disabledColors ?? new Set<string>();
    return (
      <>
        <div className="flex flex-col gap-1">
          <label className="font-mono text-[10px] uppercase tracking-wide text-hx-ink-faint">Your name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} className={INPUT} />
        </div>
        <div className="flex flex-col gap-1">
          <label className="font-mono text-[10px] uppercase tracking-wide text-hx-ink-faint">Color</label>
          <div className="flex gap-1.5">
            {PALETTE.map((c) => {
              const disabled = disabledColors.has(c.toLowerCase());
              return (
                <button
                  key={c}
                  type="button"
                  disabled={disabled}
                  onClick={() => setColor(c)}
                  aria-label={`Choose color ${c}`}
                  className={`h-6 w-6 rounded-full border-2 transition ${
                    color === c ? 'border-hx-ink scale-110' : 'border-transparent'
                  } ${disabled ? 'cursor-not-allowed opacity-35 saturate-50' : ''}`}
                  style={{ backgroundColor: c }}
                />
              );
            })}
          </div>
        </div>
      </>
    );
  }

  if (screen === 'menu') {
    return (
      <CenteredScreen>
        <div className={`${PANEL} mx-auto flex max-w-md flex-col gap-3`}>
          <div className="flex flex-col gap-1">
            <h2 className="font-display text-xl font-bold text-hx-ink">🔗 Play P2P (WebRTC)</h2>
            <p className="text-sm text-hx-ink-dim">
              Direct browser-to-browser play — no account, no room database. One player hosts and shares a code; everyone
              else connects straight to them.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setResumeSave(null); // a fresh host flow must never inherit a stale resume — see its own comment
              setScreen('host-setup');
            }}
            className={BTN_PRIMARY}
          >
            🏰 Host a room
          </button>
          <button type="button" onClick={() => setScreen('join-setup')} className={BTN_SECONDARY}>
            🚪 Join a room
          </button>
          {/* [DEFAULT — direct request: "For WebRTC a client can also save the game and resume
              it later as host"] */}
          <button type="button" onClick={() => setScreen('resume-setup')} className={BTN_SECONDARY}>
            📂 Resume a saved game
          </button>
          <button type="button" onClick={exitP2P} className={BTN_GHOST}>
            ← Back
          </button>
        </div>
      </CenteredScreen>
    );
  }

  if (screen === 'resume-setup') {
    const p2pSaves = loadSavedGames().filter((s) => s.mode === 'p2p');
    return (
      <CenteredScreen>
        <div className={`${PANEL} mx-auto flex max-w-md flex-col gap-3`}>
          <h2 className="font-display text-xl font-bold text-hx-ink">📂 Resume a saved game</h2>
          {p2pSaves.length === 0 ? (
            <p className="text-sm text-hx-ink-dim">
              No saved P2P games yet — save one from the Saves tab in the sidebar during a game.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {p2pSaves.map((save) => (
                <li key={save.id} className="flex items-center justify-between gap-2 rounded-sm border border-hx-border bg-hx-panel-2 px-2.5 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-hx-ink">{save.name}</p>
                    <p className="font-mono text-[10px] text-hx-ink-faint">
                      {new Date(save.savedAt).toLocaleString()} · {save.state.players.length} players
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setResumeSave(save);
                      setScreen('host-room');
                    }}
                    className={`${BTN_PRIMARY} px-2 py-1 text-[11px]`}
                  >
                    Resume as Host
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" onClick={() => setScreen('menu')} className={BTN_GHOST}>
            ← Back
          </button>
        </div>
      </CenteredScreen>
    );
  }

  if (screen === 'host-setup') {
    return (
      <CenteredScreen>
        <div className={`${PANEL} mx-auto flex max-w-md flex-col gap-3`}>
          <h2 className="font-display text-xl font-bold text-hx-ink">🏰 Host a room</h2>
          {renderNameColorFields()}
          <button type="button" onClick={() => setScreen('host-room')} className={BTN_PRIMARY}>
            Create Room
          </button>
          <button type="button" onClick={() => setScreen('menu')} className={BTN_GHOST}>
            ← Back
          </button>
        </div>
      </CenteredScreen>
    );
  }

  if (screen === 'host-room') {
    // onBack only ever fires from the error screen — reusing leaveHostRoom there too so a
    // genuinely dead room (couldn't reopen its code, fatal signaling error) doesn't leave a
    // stale session behind that the NEXT reload would just try to resume into again.
    return (
      <P2PHostRoom
        name={name.trim() || randomDefaultName()}
        color={color}
        onBack={leaveHostRoom}
        onLeave={leaveHostRoom}
        onTransferredAway={(code) => {
          setCommittedRoomCode(code);
          setScreen('join-room');
        }}
        resumeFromSavedGame={resumeSave ?? undefined}
      />
    );
  }

  if (screen === 'join-setup') {
    const trimmedCode = normalizeRoomCode(roomCodeInput);
    const probeReady = joinProbeCode.length > 0 && !joinLobbyProbeBusy && joinLobbyProbeResolvedCode === joinProbeCode;
    // [DEFAULT — direct request: "a client can also save the game and resume it later as host"]
    // mode: 'lobby' keeps the existing taken-name/taken-color validation exactly as it worked
    // before probeLobby could return two different shapes; mode: 'resume-lobby' means name/color
    // entry doesn't apply at all — see the ghost-picker branch in the JSX below.
    const probeResult = probeReady ? joinLobbyProbeResult : null;
    const isResumeRoom = probeResult?.mode === 'resume-lobby';
    const rosterPreview = probeResult?.mode === 'lobby' ? probeResult.players : [];
    const takenColors = new Set(rosterPreview.map((p) => p.color.toLowerCase()));
    const normalizedName = name.trim().toLowerCase();
    const nameTaken = !!normalizedName && rosterPreview.some((p) => p.name.trim().toLowerCase() === normalizedName);
    const selectedColorTaken = takenColors.has(color.toLowerCase());
    const canJoin = !isResumeRoom && isPlausibleRoomCode(trimmedCode) && name.trim().length > 0 && probeReady && !nameTaken && !selectedColorTaken;

    function commitJoin(roomCode: string, joinName: string, joinColor: string) {
      // [DEFAULT — direct request: "when a client reloads the tab he should be reconnected"]
      // Persisted BEFORE committing, so a reload even a moment after clicking "Join Room" (before
      // the connection has fully opened) still has something to resume from.
      saveJoinSession({ roomCode, name: joinName, color: joinColor });
      setCommittedRoomCode(roomCode);
      setScreen('join-room');
    }

    return (
      <CenteredScreen>
        <div className={`${PANEL} mx-auto flex max-w-md flex-col gap-3`}>
          <h2 className="font-display text-xl font-bold text-hx-ink">🚪 Join a room</h2>
          <div className="flex flex-col gap-1">
            <label className="font-mono text-[10px] uppercase tracking-wide text-hx-ink-faint">Room code</label>
            <input
              value={roomCodeInput}
              onChange={(e) => setRoomCodeInput(e.target.value)}
              placeholder="ABCDE"
              maxLength={5}
              className={`${INPUT} font-mono uppercase tracking-[0.3em]`}
            />
          </div>
          {probeResult?.mode === 'resume-lobby' ? (
            // [DEFAULT — direct request: "the lobby should display the original players slightly
            // transparent and with a connect button .. no need to enter a name again; just use
            // one of the players"] Reuses ResumeJoinLobby's own roster rendering — clicking a
            // ghost's Connect button commits straight into the join flow with that specific
            // playerId/name/color already decided (see autoClaimPlayerId, threaded into
            // P2PJoinRoom below), not a second name/color form.
            <ResumeJoinLobby
              players={probeResult.players}
              myPlayerId={null}
              onClaim={(playerId, claimedName, claimedColor) => {
                setName(claimedName);
                setColor(claimedColor);
                setAutoClaimPlayerId(playerId);
                commitJoin(trimmedCode, claimedName, claimedColor);
              }}
            />
          ) : (
            <>
              {renderNameColorFields({ disabledColors: takenColors })}
              <p className="text-[11px] text-hx-ink-faint">
                {joinLobbyProbeBusy
                  ? 'Checking room roster…'
                  : joinLobbyProbeResolvedCode !== joinProbeCode
                    ? 'Waiting for room roster…'
                  : `${rosterPreview.length} player${rosterPreview.length === 1 ? '' : 's'} currently in room.`}
              </p>
              {nameTaken && <p className="text-xs text-hx-blood">That name is already taken in this room.</p>}
              {selectedColorTaken && <p className="text-xs text-hx-blood">That color is already taken in this room.</p>}
              <button
                type="button"
                disabled={!canJoin}
                onClick={() => {
                  const trimmedName = name.trim() || randomDefaultName();
                  setAutoClaimPlayerId(undefined); // an ordinary join never has a pre-picked ghost
                  commitJoin(trimmedCode, trimmedName, color);
                }}
                className={BTN_PRIMARY}
              >
                Join Room
              </button>
            </>
          )}
          <button type="button" onClick={() => setScreen('menu')} className={BTN_GHOST}>
            ← Back
          </button>
        </div>
      </CenteredScreen>
    );
  }

  // screen === 'join-room'
  // onBack only ever fires from the error screen — reusing leaveJoinRoom there too, same
  // reasoning as the host side above.
  return (
    <P2PJoinRoom
      roomCode={committedRoomCode}
      name={name.trim() || randomDefaultName()}
      color={color}
      onBack={leaveJoinRoom}
      onLeave={leaveJoinRoom}
      onBecameHost={() => setScreen('host-room')}
      autoClaimPlayerId={autoClaimPlayerId}
    />
  );
}
