'use client';

import { useMemo, useState, useEffect } from 'react';
import Image from 'next/image';
import { createGame, type GameState, type PlayerId, type SetupPlayerInput } from '@/engine';
import { useLocalGame } from '@/hooks/use-local-game';
import { HotseatSetup, type HotseatStartPayload } from '@/components/lobby/HotseatSetup';
import { GameBoardApp } from '@/components/GameBoardApp';
import { SCREEN_ART } from '@/components/screenArt';
import { clearHotseatSession, loadHotseatSession, saveHotseatSession } from '@/lib/hotseatPersistence';
import { SavedGamesPanel } from '@/components/SavedGamesPanel';
import type { SavedGame } from '@/lib/savedGames';
import { BTN_GHOST, PANEL } from '@/components/uiClasses';

function LocalGame({
  players,
  aiPlayerIds,
  payload,
  resumedState,
  onExit,
  onRestore,
}: {
  players: SetupPlayerInput[];
  aiPlayerIds: ReadonlySet<PlayerId>;
  payload: HotseatStartPayload;
  /** Set only when THIS mount is resuming a persisted session/saved game — see HotseatApp's
   *  `bundle` state. `LocalGame`'s own lazy useState initializer only ever reads this once, on
   *  mount, which is exactly the semantics we want (a fresh game started later via HotseatSetup
   *  gets its own fresh LocalGame mount — forced via the `key` prop HotseatApp renders this
   *  with — with resumedState back to null). */
  resumedState: GameState | null;
  onExit: () => void;
  /** [DEFAULT — direct request: "a third tab which holds all saved games and allows you to
   *  restore it"] Threaded all the way down into GameBoardApp's Saves sidebar tab — see
   *  components/SavedGamesPanel.tsx. Restoring mid-game replaces this entire LocalGame mount via
   *  HotseatApp's own handleRestore, same mechanism a fresh HotseatSetup start or an exit uses. */
  onRestore: (save: SavedGame) => void;
}) {
  const [initialState] = useState(() => resumedState ?? createGame(`local-${Date.now()}`, players, `${Date.now()}-${Math.random()}`, 'hotseat'));
  const { state, dispatch, error } = useLocalGame(initialState);
  // Hotseat's "am I allowed to click things" question is really "is the seat on turn a human
  // one" — an AI seat plays itself via useAiTurn (inside GameBoardApp), so isMyTurn is false
  // for those turns even though there's no separate "online player identity" concept here.
  const isMyTurn = !aiPlayerIds.has(state.currentPlayerId);

  // [DEFAULT — direct request: "sessions are persisted in localstorage so that the game
  // continues where left off when you reload the tab"] Every state change (production, a tile
  // placed, a build, a whole turn) re-saves — cheap relative to a click, and means "reload right
  // now" never loses more than the in-flight click itself.
  useEffect(() => {
    saveHotseatSession({ payload, state });
  }, [payload, state]);

  return (
    <GameBoardApp
      state={state}
      dispatch={dispatch}
      error={error}
      isMyTurn={isMyTurn}
      aiPlayerIds={aiPlayerIds}
      onExit={onExit}
      currentHotseatPayload={payload}
      onRestore={onRestore}
    />
  );
}

/** [DEFAULT — direct request: "Add the feature to save a current game so it can be resumed
 *  later"] One bundle instead of separate payload/state useStates — `key` is what lets a restore
 *  FORCE `LocalGame` (below) to fully remount with the restored state as its initial state (React
 *  `key` prop semantics: a changed key tears the old instance down and mounts a brand new one,
 *  re-running LocalGame's own lazy useState initializer against the NEW resumedState). Every
 *  transition (starting fresh via HotseatSetup, exiting, restoring a saved game) goes through
 *  `transition` below, which is the one place `key` gets bumped — the sole exception is the very
 *  first mount, which reads a possibly-persisted session once via lazy useState init and needs no
 *  key bump (there is no previous LocalGame instance to remount away from yet).
 */
interface HotseatBundle {
  payload: HotseatStartPayload | null;
  state: GameState | null;
  key: number;
}

export function HotseatApp() {
  const [bundle, setBundle] = useState<HotseatBundle>(() => {
    const session = loadHotseatSession();
    return { payload: session?.payload ?? null, state: session?.state ?? null, key: 0 };
  });
  // [DEFAULT — direct request: "add the input for name and save button in a third tab .. no need
  // to redesign"] Toggles the pre-game screen between the default HotseatSetup form and a list of
  // saved hotseat games to resume instead — an additional option alongside the existing flow, not
  // a replacement for it. Reset back to the default on every transition so the next time this
  // screen is reached (a later Exit, say) it starts back on HotseatSetup rather than wherever the
  // player last left it.
  const [showLoadScreen, setShowLoadScreen] = useState(false);

  const players = useMemo<SetupPlayerInput[] | null>(
    () => bundle.payload?.players?.map((p) => ({ id: p.id, name: p.name, color: p.color, classId: p.classId })) ?? null,
    [bundle.payload]
  );
  const aiPlayerIds = useMemo<ReadonlySet<PlayerId>>(
    () => new Set((bundle.payload?.players ?? []).filter((p) => p.isAI).map((p) => p.id)),
    [bundle.payload]
  );

  function transition(next: { payload: HotseatStartPayload | null; state: GameState | null }) {
    setBundle((prev) => ({ ...next, key: prev.key + 1 }));
  }

  function handleExit() {
    clearHotseatSession();
    setShowLoadScreen(false);
    transition({ payload: null, state: null });
  }

  function handleStart(payload: HotseatStartPayload) {
    setShowLoadScreen(false);
    transition({ payload, state: null });
  }

  /** [DEFAULT — direct request: "a third tab .. allows you to restore it"] Persists the restored
   *  session as the new active hotseat session (so a reload right after restoring picks the SAME
   *  restored game back up, exactly like starting a fresh game already does) and forces LocalGame
   *  to remount with it via `transition`'s key bump. */
  function handleRestore(save: SavedGame) {
    saveHotseatSession({ payload: save.hotseatPayload!, state: save.state });
    setShowLoadScreen(false);
    transition({ payload: save.hotseatPayload!, state: save.state });
  }

  if (!bundle.payload || !players) {
    return (
      <div className="relative flex h-full w-full items-center justify-center overflow-hidden p-4">
        {/* Full-bleed hero art, same treatment as the main menu (LandingPage.tsx) — centered,
            same scrim shape — so all three screens (menu / new game / in-game) read as one
            consistent set rather than each doing its own thing. */}
        {SCREEN_ART.newgame && (
          <>
            <Image
              src={SCREEN_ART.newgame}
              alt=""
              aria-hidden="true"
              fill
              priority
              sizes="100vw"
              className="pointer-events-none object-cover motion-safe:animate-ken-burns"
            />
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  'radial-gradient(ellipse 80% 55% at 50% 32%, color-mix(in srgb, var(--color-hx-bg) 15%, transparent) 0%, color-mix(in srgb, var(--color-hx-bg) 55%, transparent) 70%, var(--color-hx-bg) 100%), ' +
                  'linear-gradient(180deg, color-mix(in srgb, var(--color-hx-bg) 35%, transparent) 0%, color-mix(in srgb, var(--color-hx-bg) 45%, transparent) 40%, var(--color-hx-bg) 100%)',
              }}
            />
          </>
        )}
        <div className="relative z-10 flex w-full flex-col items-center gap-3">
          {showLoadScreen ? (
            <div className={`${PANEL} mx-auto flex w-full max-w-md flex-col gap-3 motion-safe:animate-fade-up`}>
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-display text-xl font-bold text-hx-ink">📂 Load a saved game</h2>
                <button type="button" onClick={() => setShowLoadScreen(false)} className={BTN_GHOST}>
                  ← Back
                </button>
              </div>
              <SavedGamesPanel mode="hotseat" onRestore={handleRestore} />
            </div>
          ) : (
            <>
              <HotseatSetup onStart={handleStart} />
              <button type="button" onClick={() => setShowLoadScreen(true)} className={BTN_GHOST}>
                📂 Load a saved game
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <LocalGame
      key={bundle.key}
      players={players}
      aiPlayerIds={aiPlayerIds}
      payload={bundle.payload}
      resumedState={bundle.state}
      onExit={handleExit}
      onRestore={handleRestore}
    />
  );
}
