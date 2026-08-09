'use client';

/** Local hotseat mode: no backend, no network — the identical engine reducer runs directly in
 *  the browser (docs/data-model.md's "Replay parity" note, `mode: 'hotseat'`). */

import { useCallback, useState } from 'react';
import { applyAction, IllegalActionError, type Action, type GameState } from '@/engine';

export function useLocalGame(initialState: GameState) {
  const [state, setState] = useState(initialState);
  const [error, setError] = useState<string | null>(null);

  const dispatch = useCallback(
    (action: Action): boolean => {
      try {
        const next = applyAction(state, action);
        setState(next);
        setError(null);
        return true;
      } catch (err) {
        if (err instanceof IllegalActionError) {
          setError(err.message);
          return false;
        }
        throw err;
      }
    },
    [state]
  );

  return { state, dispatch, error, clearError: () => setError(null) };
}
