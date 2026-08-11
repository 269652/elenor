'use client';

/**
 * [DEFAULT — direct request: "make it so that sessions are persisted in localstorage so that the
 * game continues where left off when you reload the tab"] Hotseat is a single device with no
 * network and no server — localStorage (not sessionStorage) is the right scope here: unlike the
 * P2P join flow (lib/webrtc's sessionStorage-based identity, deliberately scoped to "this tab's
 * session" so a genuinely new tab doesn't inherit someone else's seat), there's no "different tab
 * means different player" concern for a local pass-and-play game — the whole point is that
 * closing the browser and coming back later should pick up exactly where you left off.
 *
 * Versioned key (`-v1`) so a future incompatible GameState shape change has a clean escape hatch:
 * bump the version and old saves are simply never found, rather than a stale save crashing
 * `applyAction` against engine code that no longer agrees with its shape.
 */

import type { GameState } from '@/engine';
import type { HotseatStartPayload } from '@/components/lobby/HotseatSetup';

const STORAGE_KEY = 'hexrealms-hotseat-session-v1';

export interface PersistedHotseatSession {
  payload: HotseatStartPayload;
  state: GameState;
}

/** Deliberately loose validation — just enough that a corrupted or foreign value in this slot
 *  (a different app on the same origin during local dev, a hand-edited value, a future format
 *  change we forgot to version) gets treated as "no save" instead of crashing `createGame`'s
 *  callers or `applyAction`. The engine itself is the real source of truth on the resumed game's
 *  actual validity, same as any other GameState this app already trusts. */
function isPlausibleSession(value: unknown): value is PersistedHotseatSession {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const payload = v.payload as Record<string, unknown> | undefined;
  const state = v.state as Record<string, unknown> | undefined;
  return !!payload && Array.isArray(payload.players) && !!state && typeof state.gameId === 'string' && Array.isArray(state.players);
}

export function loadHotseatSession(): PersistedHotseatSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isPlausibleSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveHotseatSession(session: PersistedHotseatSession) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Quota exceeded or storage disabled (private browsing in some browsers) — the game still
    // plays fine in-memory, it just won't survive a reload. Not worth surfacing as an error.
  }
}

export function clearHotseatSession() {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(STORAGE_KEY);
}
