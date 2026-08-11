'use client';

/**
 * Drives AI-controlled seats: when it's an AI player's turn, calls ai/decideAction.ts for one
 * action, dispatches it, and — after a short delay so AI turns stay watchable instead of
 * resolving in a single instantaneous jump — schedules the next one itself.
 *
 * [BUG FIX] The original version drove this loop implicitly, by depending on the `state` object
 * in its effect: a successful dispatch produced a new `state`, which re-ran the effect, which
 * scheduled the next action. That's a hidden assumption — state changing is what makes progress
 * happen — and it broke exactly when progress stopped: if decideAction threw (nothing here ever
 * caught it) or a dispatch failed AND its AdvancePhase fallback also failed, `state` never
 * changed, so the effect never fired again, and the turn stalled forever with no error, no log,
 * and MAX_ACTIONS_PER_TURN never even exercised as the safety valve it was meant to be. This
 * version self-schedules explicitly: `step()` reads the latest state/dispatch through refs and
 * reschedules itself unconditionally (success, failure, or thrown error alike), so the only way
 * the loop stops is the turn actually ending, the game ending, or hitting the action cap.
 */

import { useEffect, useRef } from 'react';
import { decideAction } from '@/ai/decideAction';
import type { Action, GameState, PlayerId } from '@/engine';

const ACTION_DELAY_MS = 550;
/** Safety valve, not an expected ceiling — ai/__tests__/decideAction.test.ts drives full games
 *  end-to-end and asserts real turns stay far below this. If it ever fires, something's
 *  actually wrong (a decision loop that never reaches AdvancePhase), and stopping is safer
 *  than hammering the CPU or the RNG cursor indefinitely. */
const MAX_ACTIONS_PER_TURN = 60;

export function useAiTurn(state: GameState, aiPlayerIds: ReadonlySet<PlayerId>, dispatch: (action: Action) => boolean | Promise<boolean>) {
  const actionsThisTurnRef = useRef(0);
  const lastPlayerRef = useRef<PlayerId | null>(null);

  // "Latest ref" pattern: step() below always reads these, so a render that only updates state
  // or dispatch (without currentPlayerId/winnerId changing) doesn't need to tear down and
  // restart the effect — the already-scheduled tick just sees the new value when it fires.
  // Written from an effect (runs after every render, no deps array) rather than during render
  // itself — React 19's stricter ref rules flag a write to ref.current mid-render as an error.
  const stateRef = useRef(state);
  const dispatchRef = useRef(dispatch);
  useEffect(() => {
    stateRef.current = state;
    dispatchRef.current = dispatch;
  });

  // [DEFAULT — autoplay bugfix] Depend on a derived, content-based key rather than the Set
  // object's identity. A caller that recomputes `aiPlayerIds` with useMemo (e.g. GameBoardApp's
  // autoplay feature, which unions in the current player's id only while autoplay is engaged)
  // can legitimately hand this hook a BRAND NEW Set instance every render even when its members
  // haven't changed — React's default dependency comparison (Object.is) treats that as "changed"
  // regardless, tearing the effect down and rescheduling its setTimeout on every single render.
  // Observed: with the autoplay feature this fired fast enough that step()'s 550ms timer never
  // survived to actually execute — the AI turn froze completely, going from a smoothly ticking
  // loop to a hang. Sorting first makes the key order-independent, since a Set's own iteration
  // order isn't a meaningful part of its identity here.
  const aiPlayerIdsKey = Array.from(aiPlayerIds).sort().join(',');

  useEffect(() => {
    if (state.winnerId) return;
    if (!aiPlayerIds.has(state.currentPlayerId)) return;

    if (lastPlayerRef.current !== state.currentPlayerId) {
      lastPlayerRef.current = state.currentPlayerId;
      actionsThisTurnRef.current = 0;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function step() {
      if (cancelled) return;
      if (actionsThisTurnRef.current >= MAX_ACTIONS_PER_TURN) return; // safety valve — see doc comment

      const current = stateRef.current;
      // Re-check against the LATEST state, not the state this effect closed over — the turn or
      // the game may have already ended by the time a delayed tick fires.
      if (current.winnerId || !aiPlayerIds.has(current.currentPlayerId)) return;

      actionsThisTurnRef.current += 1;
      let applied = false;
      try {
        const action = decideAction(current, current.currentPlayerId);
        applied = await dispatchRef.current(action);
      } catch {
        // decideAction threw, or dispatch rejected — treated the same as "not applied" so the
        // fallback below gets a chance, rather than this becoming an unhandled rejection that
        // silently ends the loop.
        applied = false;
      }
      if (cancelled) return;

      if (!applied) {
        // decideAction proposed something the engine rejected (or the whole thing threw) —
        // fall back to a move that's (almost) always legal rather than stalling this player's
        // turn forever. Its own failure is swallowed for the same reason: we'd rather retry on
        // the next tick (bounded by MAX_ACTIONS_PER_TURN) than stop advancing silently.
        try {
          await dispatchRef.current({ type: 'AdvancePhase', actorId: current.currentPlayerId });
        } catch {
          // fall through to reschedule below regardless
        }
      }
      if (cancelled) return;

      timer = setTimeout(() => void step(), ACTION_DELAY_MS);
    }

    timer = setTimeout(() => void step(), ACTION_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // aiPlayerIdsKey stands in for aiPlayerIds by design; see its doc comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.currentPlayerId, state.winnerId, aiPlayerIdsKey]);
}
