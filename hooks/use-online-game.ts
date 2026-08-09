'use client';

/**
 * Realtime + async mode client hook — docs/architecture.md §3. Optimistically applies the
 * SAME reducer locally, POSTs to the authoritative Route Handler, and reconciles via either a
 * Supabase Realtime broadcast (if configured — realtime mode) or a focus-triggered poll
 * (async mode's fallback). Requires a live Supabase project — see .env.example; until then,
 * use hooks/use-local-game.ts (hotseat) instead.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { applyAction, IllegalActionError, type Action, type GameState } from '@/engine';
import { getSupabaseBrowserClient, isSupabaseConfigured } from '@/lib/supabase-client';

export function useOnlineGame(roomCode: string, initialState: GameState, initialVersion: number, myPlayerId: string) {
  const [state, setState] = useState(initialState);
  const [version, setVersion] = useState(initialVersion);
  const [error, setError] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const versionRef = useRef(version);
  useEffect(() => {
    versionRef.current = version;
  }, [version]);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/games/${roomCode}`);
    if (!res.ok) return;
    const data = (await res.json()) as { state: GameState; version: number };
    setState(data.state);
    setVersion(data.version);
  }, [roomCode]);

  // Realtime subscription — pushes other players' moves as they happen.
  useEffect(() => {
    if (!isSupabaseConfigured()) return;
    const supabase = getSupabaseBrowserClient();
    const channel = supabase.channel(`game:${initialState.gameId}`);
    channel.on('broadcast', { event: 'action' }, ({ payload }) => {
      const { action, version: incomingVersion } = payload as { action: Action; version: number };
      if (incomingVersion <= versionRef.current) return; // already applied — likely our own optimistic move
      if (incomingVersion !== versionRef.current + 1) {
        void refresh(); // missed a broadcast — resync rather than drift
        return;
      }
      setState((s) => {
        try {
          return applyAction(s, action);
        } catch {
          return s; // shouldn't happen if all clients run the same engine version
        }
      });
      setVersion(incomingVersion);
    });
    channel.subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [initialState.gameId, refresh]);

  // Async-mode fallback: re-check on window focus / tab return, no live socket required.
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const dispatch = useCallback(
    async (action: Action): Promise<boolean> => {
      let optimistic: GameState;
      try {
        optimistic = applyAction(state, action);
      } catch (err) {
        if (err instanceof IllegalActionError) {
          setError(err.message);
          return false;
        }
        throw err;
      }
      setState(optimistic);
      setError(null);
      setIsSyncing(true);

      try {
        const res = await fetch(`/api/games/${roomCode}/actions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(action),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? 'Action rejected by server');
          await refresh(); // roll back to authoritative state
          return false;
        }
        setState(data.state);
        setVersion(data.version);
        return true;
      } finally {
        setIsSyncing(false);
      }
    },
    [state, roomCode, refresh]
  );

  return { state, dispatch, error, isSyncing, isMyTurn: state.currentPlayerId === myPlayerId, refresh };
}
