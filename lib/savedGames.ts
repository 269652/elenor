'use client';

/**
 * [DEFAULT — direct request: "Add the feature to save a current game so it can be resumed
 * later .. an input for name and save button in a third tab which holds all saved games and
 * allows you to restore it"] A distinct, user-curated list of named snapshots — separate from
 * both hotseat's single-slot autosave (lib/hotseatPersistence.ts) and P2P's single-slot
 * session-resume (lib/webrtc/persistence.ts), which exist purely to survive an accidental reload
 * of THIS session. A saved game is deliberate and permanent (until deleted) and, for P2P
 * specifically, is what lets a game be resumed as a brand new room later — see
 * hooks/use-p2p-host.ts's resumeFromSavedGame and the 'resume-lobby' phase for that flow.
 *
 * localStorage (not sessionStorage): saves must survive the tab closing entirely, and are
 * meaningfully shared across every tab of this browser — the P2P "a client can also save the
 * game and resume it later as host" case specifically requires this (a joiner's own tab saves
 * it, and later THAT SAME BROWSER re-hosts from it, possibly in a fresh tab).
 */

import type { GameState, PlayerId } from '@/engine';
import type { HotseatStartPayload } from '@/components/lobby/HotseatSetup';

export interface SavedGame {
  id: string;
  name: string;
  savedAt: number;
  mode: 'hotseat' | 'p2p';
  state: GameState;
  /** P2P only — which seats were AI-controlled at save time, so a resumed lobby's ghost roster
   *  can show/restore that status even for seats nobody has reconnected to yet. */
  aiControlledPlayerIds?: PlayerId[];
  /** Hotseat only — needed to reconstruct LocalGame's aiPlayerIds/players props identically to
   *  the original setup (which seats are AI is a presentation-layer concept HotseatSetup owns,
   *  same as P2P's aiControlledPlayerIds above — GameState itself has no notion of "AI"). */
  hotseatPayload?: HotseatStartPayload;
}

const STORAGE_KEY = 'hexrealms-saved-games-v1';
/** Generous but bounded — a full GameState (map + decks + event log) is the bulk of a save's
 *  size, and localStorage's ~5-10MB/origin budget is shared with every other key this app uses.
 *  Oldest saves fall off first once this is hit, rather than a write silently failing later. */
const MAX_SAVED_GAMES = 30;

function isPlausibleSavedGame(value: unknown): value is SavedGame {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const state = v.state as Record<string, unknown> | undefined;
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.savedAt === 'number' &&
    (v.mode === 'hotseat' || v.mode === 'p2p') &&
    !!state &&
    typeof state.gameId === 'string' &&
    Array.isArray(state.players)
  );
}

export function loadSavedGames(): SavedGame[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPlausibleSavedGame).sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

function persist(games: SavedGame[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(games));
  } catch {
    // Quota exceeded or storage disabled — the save silently doesn't happen. The caller's own
    // UI (SavedGamesPanel) re-reads loadSavedGames() right after, so a failed save just doesn't
    // show up in the list, which is a truthful (if unannounced) outcome rather than a crash.
  }
}

/** id/savedAt are minted here, not by the caller — every save gets a fresh slot, never an
 *  overwrite-by-name, so saving twice under the same name (a deliberate checkpoint habit) just
 *  produces two entries a player can tell apart by timestamp. */
export function saveGame(entry: Omit<SavedGame, 'id' | 'savedAt'>): SavedGame {
  const saved: SavedGame = {
    ...entry,
    id: `save-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    savedAt: Date.now(),
  };
  const games = [saved, ...loadSavedGames()].slice(0, MAX_SAVED_GAMES);
  persist(games);
  return saved;
}

export function deleteSavedGame(id: string) {
  persist(loadSavedGames().filter((g) => g.id !== id));
}
