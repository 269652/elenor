/**
 * The authoritative mutation path: validate -> reduce -> persist -> broadcast, per
 * docs/architecture.md §7. This is what app/api/games/[roomCode]/actions/route.ts calls — a
 * Route Handler rather than a Server Action deliberately (see that route file for why).
 */

import { applyAction, IllegalActionError, type Action, type GameState } from '@/engine';
import { appendGameEvent, loadGameByRoomCode, saveGame } from './game-store';
import { broadcastAction } from './realtime';
import type { RoomSession } from './auth';

export interface SubmitActionResult {
  ok: boolean;
  state?: GameState;
  version?: number;
  error?: string;
}

const MAX_RETRIES = 3;

export async function submitAction(roomCode: string, session: RoomSession, action: Action): Promise<SubmitActionResult> {
  // Never trust actorId from the client body alone — it must match the verified session.
  // See node_modules/next/dist/docs/01-app/02-guides/server-actions.md's "Safe" example,
  // the same principle applies to a Route Handler reading a signed cookie.
  if (action.actorId !== session.playerId) {
    return { ok: false, error: 'actorId does not match your session' };
  }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const loaded = await loadGameByRoomCode(roomCode);
    if (!loaded) return { ok: false, error: 'No active game for this room' };

    let nextState: GameState;
    try {
      nextState = applyAction(loaded.state, action);
    } catch (err) {
      if (err instanceof IllegalActionError) return { ok: false, error: err.message };
      throw err;
    }

    const saveResult = await saveGame(loaded.gameId, nextState, loaded.version);
    if (!saveResult.success) {
      continue; // another player's action landed first — reload latest state and retry
    }

    await appendGameEvent(loaded.gameId, nextState.eventLog.length - 1, action).catch(() => {
      // best-effort audit log — never block the authoritative write on this
    });
    await broadcastAction(loaded.gameId, action, saveResult.newVersion!);

    return { ok: true, state: nextState, version: saveResult.newVersion };
  }

  return { ok: false, error: 'Too many concurrent submissions — please retry' };
}
