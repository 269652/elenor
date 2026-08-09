'use client';

import { useMemo, useState } from 'react';
import Image from 'next/image';
import { createGame, type PlayerId, type SetupPlayerInput } from '@/engine';
import { useLocalGame } from '@/hooks/use-local-game';
import { HotseatSetup, type HotseatPlayerSetup } from '@/components/lobby/HotseatSetup';
import { GameBoardApp } from '@/components/GameBoardApp';
import { SCREEN_ART } from '@/components/screenArt';

function LocalGame({ players, aiPlayerIds }: { players: SetupPlayerInput[]; aiPlayerIds: ReadonlySet<PlayerId> }) {
  const [initialState] = useState(() => createGame(`local-${Date.now()}`, players, `${Date.now()}-${Math.random()}`, 'hotseat'));
  const { state, dispatch, error } = useLocalGame(initialState);
  // Hotseat's "am I allowed to click things" question is really "is the seat on turn a human
  // one" — an AI seat plays itself via useAiTurn (inside GameBoardApp), so isMyTurn is false
  // for those turns even though there's no separate "online player identity" concept here.
  const isMyTurn = !aiPlayerIds.has(state.currentPlayerId);
  return <GameBoardApp state={state} dispatch={dispatch} error={error} isMyTurn={isMyTurn} aiPlayerIds={aiPlayerIds} />;
}

export function HotseatApp() {
  const [setup, setSetup] = useState<HotseatPlayerSetup[] | null>(null);

  const players = useMemo<SetupPlayerInput[] | null>(
    () => setup?.map((p) => ({ id: p.id, name: p.name, color: p.color, classId: p.classId })) ?? null,
    [setup]
  );
  const aiPlayerIds = useMemo<ReadonlySet<PlayerId>>(
    () => new Set((setup ?? []).filter((p) => p.isAI).map((p) => p.id)),
    [setup]
  );

  if (!setup || !players) {
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
          <HotseatSetup onStart={setSetup} />
        </div>
      </div>
    );
  }

  return <LocalGame players={players} aiPlayerIds={aiPlayerIds} />;
}
