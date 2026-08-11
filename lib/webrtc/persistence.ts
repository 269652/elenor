'use client';

/**
 * [DEFAULT — direct request: "in webrtc when a client reloads the tab he should be reconnected..
 * if the host reloads the tab it should be restored after reload and let the clients
 * reconnect"] sessionStorage, not localStorage — deliberately matching the existing precedent in
 * hooks/use-p2p-join.ts's `stablePlayerIdFor` (same file's original comment: "so a genuinely new
 * tab/session for the same room still gets treated as a new identity"). The same reasoning
 * applies to the room code and display info persisted here: opening the game in a SECOND tab
 * shouldn't silently drag that tab into a room the first tab is already hosting or has joined —
 * sessionStorage's per-tab scope is exactly the boundary this needs. A reload of the SAME tab
 * (what was actually asked for) keeps sessionStorage intact either way.
 */

import type { GameState } from '@/engine';

const HOST_KEY = 'hexrealms-p2p-host-session-v1';
const JOIN_KEY = 'hexrealms-p2p-join-session-v1';

export interface PersistedHostSession {
  roomCode: string;
  /** The host's own stable playerId — MUST survive a reload unchanged, or the restored
   *  GameState's players array (baked in at createGame time with this exact id) would no longer
   *  contain a seat the reloaded host recognizes as "me". See use-p2p-host.ts's isMyTurn check. */
  hostPlayerId: string;
  name: string;
  color: string;
  /** null while still in the lobby (nothing to restore beyond the room code + identity); the
   *  authoritative GameState once the game has started. */
  gameState: GameState | null;
}

export interface PersistedJoinSession {
  roomCode: string;
  name: string;
  color: string;
}

/** Loose validation, same rationale as lib/hotseatPersistence.ts's isPlausibleSession — a
 *  corrupted or foreign value in this slot should read as "no session," not crash the caller. */
function isPlausibleHostSession(value: unknown): value is PersistedHostSession {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.roomCode === 'string' && typeof v.hostPlayerId === 'string' && typeof v.name === 'string' && typeof v.color === 'string';
}

function isPlausibleJoinSession(value: unknown): value is PersistedJoinSession {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.roomCode === 'string' && typeof v.name === 'string' && typeof v.color === 'string';
}

export function loadHostSession(): PersistedHostSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(HOST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isPlausibleHostSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveHostSession(session: PersistedHostSession) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(HOST_KEY, JSON.stringify(session));
  } catch {
    // Quota/availability issue — the room still works for this tab's lifetime, it just won't
    // survive a reload. Not worth surfacing as a game-breaking error.
  }
}

export function clearHostSession() {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(HOST_KEY);
}

export function loadJoinSession(): PersistedJoinSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(JOIN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isPlausibleJoinSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveJoinSession(session: PersistedJoinSession) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(JOIN_KEY, JSON.stringify(session));
  } catch {
    // See saveHostSession.
  }
}

export function clearJoinSession() {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(JOIN_KEY);
}
