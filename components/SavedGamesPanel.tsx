'use client';

/**
 * [DEFAULT — direct request: "Add the feature to save a current game so it can be resumed
 * later .. an input for name and save button in a third tab which holds all saved games and
 * allows you to restore it"] Shared between three call sites: components/GameBoardApp.tsx's
 * in-game "Saves" sidebar tab (both hotseat and P2P), components/HotseatApp.tsx's pre-game
 * "load a saved game" screen, and — indirectly, via its roster-rendering being the template for
 * it — components/p2p/P2PApp.tsx's "Resume a saved game" menu screen. One list+save component
 * over lib/savedGames.ts instead of three near-identical ones.
 */

import { useState } from 'react';
import type { GameState, PlayerId } from '@/engine';
import type { HotseatStartPayload } from '@/components/lobby/HotseatSetup';
import { deleteSavedGame, loadSavedGames, saveGame, type SavedGame } from '@/lib/savedGames';
import { BTN_DANGER, BTN_PRIMARY, INPUT, PANEL } from '@/components/uiClasses';

export interface SavedGamesPanelProps {
  mode: 'hotseat' | 'p2p';
  /** [DEFAULT — genuinely new decision] Spec'd as required, but this panel is also reused on
   *  HotseatApp's pre-game "load a saved game" screen, where there IS no current game to save at
   *  all — made optional instead, and the save form (name input + Save button) simply doesn't
   *  render without it. Every other prop here already only makes sense alongside a live game, so
   *  this is the one that actually needed to flex. */
  currentState?: GameState;
  currentAiControlledPlayerIds?: ReadonlySet<PlayerId>;
  currentHotseatPayload?: HotseatStartPayload;
  /** Present only where restoring actually makes sense from this exact screen — see this file's
   *  per-row rendering below for the full mode-matching logic. */
  onRestore?: (save: SavedGame) => void;
}

const MODE_BADGE: Record<SavedGame['mode'], string> = {
  hotseat: '🪑 Hotseat',
  p2p: '🔗 P2P',
};

function formatSavedAt(ts: number): string {
  return new Date(ts).toLocaleString();
}

export function SavedGamesPanel({ mode, currentState, currentAiControlledPlayerIds, currentHotseatPayload, onRestore }: SavedGamesPanelProps) {
  const [name, setName] = useState('');
  const [saves, setSaves] = useState<SavedGame[]>(() => loadSavedGames());

  function refresh() {
    setSaves(loadSavedGames());
  }

  function handleSave() {
    if (!currentState) return; // no live game on this screen — see currentState's own comment
    const trimmed = name.trim() || `Save ${formatSavedAt(Date.now())}`;
    saveGame({
      name: trimmed,
      mode,
      state: currentState,
      aiControlledPlayerIds: currentAiControlledPlayerIds ? [...currentAiControlledPlayerIds] : undefined,
      hotseatPayload: currentHotseatPayload,
    });
    setName('');
    refresh();
  }

  function handleDelete(id: string) {
    // [DEFAULT — direct request pattern already established for the Exit-game button in
    // GameBoardApp.tsx] Deleting a save is permanent (lib/savedGames.ts's deleteSavedGame has no
    // undo) — same lightweight native confirm, proportionate to a purely local/no-network action.
    if (!window.confirm('Delete this saved game? This cannot be undone.')) return;
    deleteSavedGame(id);
    refresh();
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto">
      {currentState && (
        <div className={PANEL}>
          <div className="flex flex-col gap-2">
            <span className="font-mono text-[10px] uppercase tracking-wide text-hx-ink-faint">💾 Save this game</span>
            <div className="flex gap-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name this save…"
                maxLength={40}
                className={`flex-1 ${INPUT}`}
              />
              <button type="button" onClick={handleSave} className={BTN_PRIMARY}>
                💾 Save
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wide text-hx-ink-faint">
          Saved games ({saves.length})
        </span>
        {saves.length === 0 && <p className="text-xs text-hx-ink-faint">No saved games yet.</p>}
        <ul className="flex flex-col gap-1.5">
          {saves.map((save) => {
            // A restore button only makes sense when the caller wired one up AND this entry's
            // mode matches the CURRENT context — restoring a P2P save from inside a hotseat game
            // (or vice versa) isn't a thing; the real P2P restore path is components/p2p/
            // P2PApp.tsx's separate "Resume a saved game" menu screen (host-only, by design).
            const canRestore = !!onRestore && save.mode === mode;
            const showP2pNote = !canRestore && save.mode === 'p2p' && mode === 'p2p';
            return (
              <li key={save.id} className="flex flex-col gap-1.5 rounded-sm border border-hx-border bg-hx-panel-2 px-2.5 py-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-hx-ink">{save.name}</p>
                    <p className="font-mono text-[10px] text-hx-ink-faint">
                      {MODE_BADGE[save.mode]} · {formatSavedAt(save.savedAt)} · {save.state.players.length} players
                    </p>
                  </div>
                </div>
                {showP2pNote && (
                  <p className="text-[11px] text-hx-ink-faint">Resume this from the P2P menu (Exit first).</p>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {canRestore && (
                    <button type="button" onClick={() => onRestore!(save)} className={`${BTN_PRIMARY} px-2 py-1 text-[11px]`}>
                      ▶ Restore
                    </button>
                  )}
                  <button type="button" onClick={() => handleDelete(save.id)} className={`${BTN_DANGER} px-2 py-1 text-[11px]`}>
                    🗑️ Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
