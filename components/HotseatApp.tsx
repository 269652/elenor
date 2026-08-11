'use client';

import { useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import { createGame, type GameState, type PlayerId, type SetupPlayerInput } from '@/engine';
import { useLocalGame } from '@/hooks/use-local-game';
import { HotseatSetup, type HotseatPlayerSetup, type HotseatStartPayload } from '@/components/lobby/HotseatSetup';
import { GameBoardApp } from '@/components/GameBoardApp';
import { SCREEN_ART } from '@/components/screenArt';
import { clearHotseatSession, loadHotseatSession, saveHotseatSession } from '@/lib/hotseatPersistence';

function LocalGame({
  players,
  aiPlayerIds,
  payload,
  resumedState,
  onExit,
}: {
  players: SetupPlayerInput[];
  aiPlayerIds: ReadonlySet<PlayerId>;
  payload: HotseatStartPayload;
  /** Set only when THIS mount is resuming a persisted session — see HotseatApp's
   *  `isResumedPayload` check. `LocalGame`'s own lazy useState initializer only ever reads this
   *  once, on mount, which is exactly the semantics we want (a fresh game started later via
   *  HotseatSetup gets its own fresh LocalGame mount with resumedState back to null). */
  resumedState: GameState | null;
  onExit: () => void;
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
    <GameBoardApp state={state} dispatch={dispatch} error={error} isMyTurn={isMyTurn} aiPlayerIds={aiPlayerIds} onExit={onExit} />
  );
}

export function HotseatApp() {
  // Read once, at first mount — HotseatSetup.onStart below always hands `payload` a BRAND NEW
  // object, so `payload === session?.payload` (checked below) stays a reliable "is this render
  // still showing the resumed game, or has the player since started a fresh one" test without
  // needing a separate ref/flag.
  const [session] = useState(() => loadHotseatSession());
  const [payload, setPayload] = useState<HotseatStartPayload | null>(session?.payload ?? null);

  const players = useMemo<SetupPlayerInput[] | null>(
    () => payload?.players?.map((p) => ({ id: p.id, name: p.name, color: p.color, classId: p.classId })) ?? null,
    [payload]
  );
  const aiPlayerIds = useMemo<ReadonlySet<PlayerId>>(
    () => new Set((payload?.players ?? []).filter((p) => p.isAI).map((p) => p.id)),
    [payload]
  );

  function handleExit() {
    clearHotseatSession();
    setPayload(null);
  }

  if (!payload || !players) {
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
        <div className="relative z-10">
          <HotseatSetup onStart={setPayload} />
        </div>
      </div>
    );
  }

  return (
    <LocalGame
      players={players}
      aiPlayerIds={aiPlayerIds}
      payload={payload}
      resumedState={payload === session?.payload ? (session?.state ?? null) : null}
      onExit={handleExit}
    />
  );
}
