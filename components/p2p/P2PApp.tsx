'use client';

/**
 * [DEFAULT — WebRTC P2P play, direct request: "implement webrtc host and connect"] The whole
 * flow for the new "Play P2P" landing-page entry: pick a name/color, then either host a room
 * (hooks/use-p2p-host.ts) or join one by code (hooks/use-p2p-join.ts). No server, no database —
 * see lib/webrtc/protocol.ts's file header for the transport design. Mirrors HotseatApp.tsx's
 * structural split: a lightweight setup screen, then a component that only mounts (and only
 * calls its connecting hook) once the player has actually committed to hosting/joining.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { GameBoardApp } from '@/components/GameBoardApp';
import { BTN_GHOST, BTN_PRIMARY, BTN_SECONDARY, INPUT, PANEL } from '@/components/uiClasses';
import { useP2PHost, type P2PHostPhase } from '@/hooks/use-p2p-host';
import { useP2PJoin, type P2PJoinPhase } from '@/hooks/use-p2p-join';
import { isPlausibleRoomCode, normalizeRoomCode, type LobbyPlayerInfo } from '@/lib/webrtc/protocol';
import { clearHostSession, clearJoinSession, loadHostSession, loadJoinSession, saveJoinSession } from '@/lib/webrtc/persistence';

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

function ConnectingScreen({ label }: { label: string }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 p-6 text-center">
      <span className="text-3xl motion-safe:animate-pulse" aria-hidden="true">
        🔗
      </span>
      <p className="text-sm text-hx-ink-dim">{label}</p>
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

/** Room code + a shareable /p2p/<code> link, both one click from the clipboard — this is the
 *  thing a host has to actually get to their friends, so it gets the most visual weight on the
 *  whole screen. navigator.clipboard needs a secure context (https, or localhost in dev). */
function ShareRoomCode({ roomCode }: { roomCode: string }) {
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);
  const link = typeof window !== 'undefined' ? `${window.location.origin}/p2p/${roomCode}` : '';

  async function copy(text: string, which: 'code' | 'link') {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      // Clipboard access denied/unavailable — the code is still shown on screen, just not
      // one-click-copyable. Not worth a whole error state for.
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-sm border border-hx-gold/50 bg-hx-gold/10 p-3">
      <span className="font-mono text-[10px] uppercase tracking-wide text-hx-ink-faint">Room code</span>
      <button
        type="button"
        onClick={() => copy(roomCode, 'code')}
        className="self-start font-display text-3xl font-bold tracking-[0.3em] text-hx-gold transition hover:text-hx-gold-bright"
        title="Click to copy"
      >
        {roomCode}
      </button>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => copy(link, 'link')} className={`${BTN_SECONDARY} flex-1 text-center`}>
          {copied === 'link' ? '✓ Link copied' : copied === 'code' ? '✓ Code copied' : '🔗 Copy shareable link'}
        </button>
      </div>
      <p className="text-[11px] text-hx-ink-faint">Share either one — joiners can type the code or open the link directly.</p>
    </div>
  );
}

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

function P2PHostRoom({ name, color, onBack, onLeave }: { name: string; color: string; onBack: () => void; onLeave: () => void }) {
  const hostInfo = useMemo(() => ({ name, color }), [name, color]);
  const result = useP2PHost(hostInfo);

  if (result.phase === 'connecting') return <CenteredScreen><ConnectingScreen label="Opening a room…" /></CenteredScreen>;
  if (result.phase === 'error') return <CenteredScreen><ErrorScreen message={result.message} onBack={onBack} /></CenteredScreen>;
  if (result.phase === 'lobby') return <CenteredScreen><HostLobby hostState={result} onLeave={onLeave} /></CenteredScreen>;
  // Unwrapped, same as components/HotseatApp.tsx's LocalGame — GameBoardApp's own grid fills the
  // page's full block width/height; a centering wrapper here would shrink it to content size.
  return <GameBoardApp state={result.state} dispatch={result.dispatch} error={result.error} isMyTurn={result.isMyTurn} onExit={onLeave} />;
}

// ── Join ─────────────────────────────────────────────────────────────────────────────────────

function P2PJoinRoom({
  roomCode,
  name,
  color,
  onBack,
  onLeave,
}: {
  roomCode: string;
  name: string;
  color: string;
  onBack: () => void;
  onLeave: () => void;
}) {
  const myInfo = useMemo(() => ({ name, color }), [name, color]);
  const result: P2PJoinPhase = useP2PJoin(roomCode, myInfo);

  if (result.phase === 'connecting') return <CenteredScreen><ConnectingScreen label={`Connecting to room ${roomCode}…`} /></CenteredScreen>;
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
  // Unwrapped — see P2PHostRoom's identical comment above.
  return <GameBoardApp state={result.state} dispatch={result.dispatch} error={result.error} isMyTurn={result.isMyTurn} onExit={onLeave} />;
}

// ── Setup ────────────────────────────────────────────────────────────────────────────────────

type Screen = 'menu' | 'host-setup' | 'host-room' | 'join-setup' | 'join-room';

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
    setScreen('menu');
  }

  function leaveJoinRoom() {
    clearJoinSession();
    setScreen('menu');
  }

  const nameColorFields = (
    <>
      <div className="flex flex-col gap-1">
        <label className="font-mono text-[10px] uppercase tracking-wide text-hx-ink-faint">Your name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} className={INPUT} />
      </div>
      <div className="flex flex-col gap-1">
        <label className="font-mono text-[10px] uppercase tracking-wide text-hx-ink-faint">Color</label>
        <div className="flex gap-1.5">
          {PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              aria-label={`Choose color ${c}`}
              className={`h-6 w-6 rounded-full border-2 transition ${color === c ? 'border-hx-ink scale-110' : 'border-transparent'}`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
      </div>
    </>
  );

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
          <button type="button" onClick={() => setScreen('host-setup')} className={BTN_PRIMARY}>
            🏰 Host a room
          </button>
          <button type="button" onClick={() => setScreen('join-setup')} className={BTN_SECONDARY}>
            🚪 Join a room
          </button>
          <button type="button" onClick={exitP2P} className={BTN_GHOST}>
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
          {nameColorFields}
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
    return <P2PHostRoom name={name.trim() || randomDefaultName()} color={color} onBack={leaveHostRoom} onLeave={leaveHostRoom} />;
  }

  if (screen === 'join-setup') {
    const trimmedCode = normalizeRoomCode(roomCodeInput);
    const canJoin = isPlausibleRoomCode(trimmedCode) && name.trim().length > 0;
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
          {nameColorFields}
          <button
            type="button"
            disabled={!canJoin}
            onClick={() => {
              const trimmedName = name.trim() || randomDefaultName();
              // [DEFAULT — direct request: "when a client reloads the tab he should be
              // reconnected"] Persisted BEFORE committing, so a reload even a moment after
              // clicking "Join Room" (before the connection has fully opened) still has
              // something to resume from.
              saveJoinSession({ roomCode: trimmedCode, name: trimmedName, color });
              setCommittedRoomCode(trimmedCode);
              setScreen('join-room');
            }}
            className={BTN_PRIMARY}
          >
            Join Room
          </button>
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
    />
  );
}
