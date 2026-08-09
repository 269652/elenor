'use client';

import { useOnlineGame } from '@/hooks/use-online-game';
import { GameBoardApp } from '@/components/GameBoardApp';
import type { GameState } from '@/engine';

interface OnlineGameClientProps {
  roomCode: string;
  initialState: GameState;
  initialVersion: number;
  myPlayerId: string;
}

export function OnlineGameClient({ roomCode, initialState, initialVersion, myPlayerId }: OnlineGameClientProps) {
  const { state, dispatch, error, isMyTurn, isSyncing } = useOnlineGame(roomCode, initialState, initialVersion, myPlayerId);

  return (
    <div className="flex h-full flex-col gap-2">
      {isSyncing && <div className="font-mono text-[11px] uppercase tracking-wide text-hx-ink-faint">Syncing…</div>}
      <GameBoardApp state={state} dispatch={dispatch} error={error} isMyTurn={isMyTurn} />
    </div>
  );
}
