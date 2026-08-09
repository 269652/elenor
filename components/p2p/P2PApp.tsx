'use client';

/**
 * [DEFAULT — WebRTC P2P play, direct request: "implement webrtc host and connect"] The whole
 * flow for the new "Play P2P" landing-page entry: pick a name/color, then either host a room
 * (hooks/use-p2p-host.ts) or join one by code (hooks/use-p2p-join.ts). No server, no database —
 * see lib/webrtc/protocol.ts's file header for the transport design. Mirrors HotseatApp.tsx's
 * structural split: a lightweight setup screen, then a component that only mounts (and only
 * calls its connecting hook) once the player has actually committed to hosting/joining.
 */

import { useMemo, useState } from 'react';
import { GameBoardApp } from '@/components/GameBoardApp';
import { BTN_GHOST, BTN_PRIMARY, BTN_SECONDARY, INPUT, PANEL } from '@/components/uiClasses';
import { useP2PHost, type P2PHostPhase } from '@/hooks/use-p2p-host';
import { useP2PJoin, type P2PJoinPhase } from '@/hooks/use-p2p-join';
import { isPlausibleRoomCode, normalizeRoomCode, type LobbyPlayerInfo } from '@/lib/webrtc/protocol';

const PALETTE = ['#ef4444', '#3b82f6', '#22c55e', '#eab308', '#a855f7', '#f97316'];
const DEFAULT_NAMES = ['Alice', 'Bob', 'Carol', 'Dave', 'Erin', 'Frank'];

function randomDefaultName(): string {
  return DEFAULT_NAMES[Math.floor(Math.random() * DEFAULT_NAMES.length)];
}

// ── Shared bits ──────────────────────────────────────────────────────────────────────────────

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

function HostLobby({ hostState }: { hostState: Extract<P2PHostPhase, { phase: 'lobby' }> }) {
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
    </div>
  );
}

function P2PHostRoom({ name, color, onBack }: { name: string; color: string; onBack: () => void }) {
  const hostInfo = useMemo(() => ({ name, color }), [name, color]);
  const result = useP2PHost(hostInfo);

  if (result.phase === 'connecting') return <ConnectingScreen label="Opening a room…" />;
  if (result.phase === 'error') return <ErrorScreen message={result.message} onBack={onBack} />;
  if (result.phase === 'lobby') return <HostLobby hostState={result} />;
  return <GameBoardApp state={result.state} dispatch={result.dispatch} error={result.error} isMyTurn={result.isMyTurn} />;
}

// ── Join ─────────────────────────────────────────────────────────────────────────────────────

function P2PJoinRoom({ roomCode, name, color, onBack }: { roomCode: string; name: string; color: string; onBack: () => void }) {
  const myInfo = useMemo(() => ({ name, color }), [name, color]);
  const result: P2PJoinPhase = useP2PJoin(roomCode, myInfo);

  if (result.phase === 'connecting') return <ConnectingScreen label={`Connecting to room ${roomCode}…`} />;
  if (result.phase === 'error') return <ErrorScreen message={result.message} onBack={onBack} />;
  if (result.phase === 'lobby') {
    return (
      <div className={`${PANEL} mx-auto flex max-w-md flex-col gap-4`}>
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-xl font-bold text-hx-ink">🚪 Room {roomCode}</h2>
          <p className="text-sm text-hx-ink-dim">Waiting for the host to start the game…</p>
        </div>
        <LobbyRoster players={result.players} />
      </div>
    );
  }
  return <GameBoardApp state={result.state} dispatch={result.dispatch} error={result.error} isMyTurn={result.isMyTurn} />;
}

// ── Setup ────────────────────────────────────────────────────────────────────────────────────

type Screen = 'menu' | 'host-setup' | 'host-room' | 'join-setup' | 'join-room';

export function P2PApp({ initialRoomCode, onExit }: { initialRoomCode?: string; onExit: () => void }) {
  const [screen, setScreen] = useState<Screen>(initialRoomCode ? 'join-setup' : 'menu');
  const [name, setName] = useState(randomDefaultName);
  const [color, setColor] = useState(PALETTE[0]);
  const [roomCodeInput, setRoomCodeInput] = useState(initialRoomCode ?? '');
  const [committedRoomCode, setCommittedRoomCode] = useState('');

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
        <button type="button" onClick={onExit} className={BTN_GHOST}>
          ← Back
        </button>
      </div>
    );
  }

  if (screen === 'host-setup') {
    return (
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
    );
  }

  if (screen === 'host-room') {
    return <P2PHostRoom name={name.trim() || randomDefaultName()} color={color} onBack={() => setScreen('menu')} />;
  }

  if (screen === 'join-setup') {
    const trimmedCode = normalizeRoomCode(roomCodeInput);
    const canJoin = isPlausibleRoomCode(trimmedCode) && name.trim().length > 0;
    return (
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
    );
  }

  // screen === 'join-room'
  return <P2PJoinRoom roomCode={committedRoomCode} name={name.trim() || randomDefaultName()} color={color} onBack={() => setScreen('menu')} />;
}
