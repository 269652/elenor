'use client';

import { useState } from 'react';
import type { SetupPlayerInput } from '@/engine';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT, PANEL } from '@/components/uiClasses';

export interface HotseatPlayerSetup extends SetupPlayerInput {
  /** Drives ai/decideAction.ts via hooks/use-ai-turn.ts instead of waiting for a human click —
   *  see HotseatApp.tsx. Purely a UI/lobby concept: the engine itself has no notion of "AI",
   *  it just receives Actions from whoever calls dispatch. */
  isAI: boolean;
}

const PALETTE = ['#ef4444', '#3b82f6', '#22c55e', '#eab308', '#a855f7', '#f97316'];
const DEFAULT_NAMES = ['Alice', 'Bob', 'Carol', 'Dave', 'Erin', 'Frank'];

export interface GameSettings {
  /** Turn timer in seconds; 0 means no timer. */
  turnTimerSeconds: number;
}

export interface HotseatStartPayload {
  players: HotseatPlayerSetup[];
  settings: GameSettings;
}

export function HotseatSetup({ onStart }: { onStart: (payload: HotseatStartPayload) => void }) {
  const [names, setNames] = useState<string[]>([DEFAULT_NAMES[0], DEFAULT_NAMES[1]]);
  const [isAI, setIsAI] = useState<boolean[]>([false, false]);
  const [turnTimerSeconds, setTurnTimerSeconds] = useState<number>(0);

  function updateName(i: number, value: string) {
    setNames((prev) => prev.map((n, idx) => (idx === i ? value : n)));
  }

  function toggleAI(i: number) {
    setIsAI((prev) => prev.map((v, idx) => (idx === i ? !v : v)));
  }

  function addPlayer() {
    if (names.length >= 6) return;
    setNames((prev) => [...prev, DEFAULT_NAMES[prev.length]]);
    setIsAI((prev) => [...prev, false]);
  }

  function removePlayer(i: number) {
    if (names.length <= 2) return;
    setNames((prev) => prev.filter((_, idx) => idx !== i));
    setIsAI((prev) => prev.filter((_, idx) => idx !== i));
  }

  function start() {
    const players: HotseatPlayerSetup[] = names.map((name, i) => ({
      id: `local-${i}`,
      name: name.trim() || DEFAULT_NAMES[i],
      color: PALETTE[i % PALETTE.length],
      isAI: isAI[i],
    }));
    onStart({ players, settings: { turnTimerSeconds } });
  }

  const aiCount = isAI.filter(Boolean).length;

  return (
    <div className={`${PANEL} mx-auto flex max-w-md flex-col gap-4 motion-safe:animate-fade-up`}>
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-xl font-bold text-hx-ink">🪑 Local Hotseat Game</h2>
        <p className="text-sm text-hx-ink-dim">
          Pass the device between human turns — AI seats play themselves. Classes are dealt randomly, per §1.3.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <span className="font-mono text-[10px] uppercase tracking-wide text-hx-ink-faint">Players</span>
          <span className="font-mono text-[10px] uppercase tracking-wide text-hx-ink-faint">
            {names.length}/6{aiCount > 0 ? ` · ${aiCount} AI` : ''}
          </span>
        </div>

        <ul className="flex flex-col divide-y divide-hx-border overflow-hidden rounded-sm border border-hx-border">
          {names.map((name, i) => (
            <li
              key={i}
              className="flex items-center gap-2 px-2 py-1.5 transition-colors hover:bg-hx-panel-2 focus-within:bg-hx-panel-2"
            >
              <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: PALETTE[i % PALETTE.length] }} />
              <input
                value={name}
                onChange={(e) => updateName(i, e.target.value)}
                disabled={isAI[i]}
                className={`flex-1 ${INPUT} disabled:text-hx-ink-faint`}
                maxLength={20}
              />
              <button
                type="button"
                onClick={() => toggleAI(i)}
                title={isAI[i] ? 'AI-controlled — click to make human' : 'Human-controlled — click to make AI'}
                className={
                  isAI[i]
                    ? 'shrink-0 rounded-sm border border-hx-arcane bg-hx-arcane px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-hx-ink transition hover:brightness-110'
                    : 'shrink-0 rounded-sm border border-hx-border bg-hx-panel px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-hx-ink-faint transition hover:border-hx-border-strong hover:text-hx-ink'
                }
              >
                {isAI[i] ? '🤖 AI' : '🧑 Human'}
              </button>
              {names.length > 2 && (
                <button
                  type="button"
                  onClick={() => removePlayer(i)}
                  className="shrink-0 rounded-sm px-1 text-xs text-hx-ink-faint transition-colors hover:text-hx-blood"
                >
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>

      {names.length < 6 && (
        <button type="button" onClick={addPlayer} className={`w-full ${BTN_SECONDARY}`}>
          + Add player ({names.length}/6)
        </button>
      )}

      <div className="flex flex-col gap-2 border-t border-hx-border pt-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="turn-timer" className="font-mono text-[10px] uppercase tracking-wide text-hx-ink-faint">
            ⏱️ Turn Timer (seconds)
          </label>
          <div className="flex gap-2">
            <input
              id="turn-timer"
              type="number"
              min={0}
              max={600}
              step={5}
              value={turnTimerSeconds}
              onChange={(e) => setTurnTimerSeconds(Math.max(0, Number(e.target.value)))}
              className={INPUT}
            />
            <span className="flex items-center text-xs text-hx-ink-faint">
              {turnTimerSeconds === 0 ? 'No timer' : `${turnTimerSeconds}s per turn`}
            </span>
          </div>
          <p className="text-[11px] text-hx-ink-faint">Set to 0 for no time limit, or configure up to 10 minutes per turn.</p>
        </div>

        <button type="button" onClick={start} className={`${BTN_PRIMARY} w-full font-display tracking-wide`}>
          Start Game ▶
        </button>
      </div>
    </div>
  );
}
