import { redirect } from 'next/navigation';
import { getRoomSession } from '@/server/auth';
import { getRoomByCode } from '@/server/game-store';
import { startGameAction } from '@/actions/game-actions';
import { OnlineGameClient } from '@/components/OnlineGameClient';
import type { GameState } from '@/engine';

export default async function PlayRoomPage({ params }: { params: Promise<{ roomCode: string }> }) {
  const { roomCode } = await params;
  const session = await getRoomSession(roomCode);
  if (!session) redirect('/');

  const room = await getRoomByCode(roomCode);
  if (!room) redirect('/');

  if (!room.game) {
    return (
      <main className="mx-auto flex h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="font-mono text-[11px] uppercase tracking-widest text-hx-copper">Room {roomCode}</p>
        <h1 className="font-display text-2xl font-bold text-hx-ink">Waiting for the host to start the game</h1>
        <ul className="flex flex-col gap-1.5">
          {room.players.map((p) => (
            <li key={p.id} className="text-sm text-hx-ink-dim">
              {p.displayName} {p.isHost && <span className="text-hx-ink-faint">(host)</span>}
            </li>
          ))}
        </ul>
        {session.playerId === room.hostPlayerId && (
          <form action={startGameAction.bind(null, roomCode)}>
            <button
              type="submit"
              disabled={room.players.length < 2}
              className="rounded-sm border border-hx-gold bg-hx-gold px-4 py-2 text-sm font-semibold text-hx-bg shadow-[0_0_14px_-4px_rgba(217,164,65,0.8)] transition hover:bg-hx-gold-bright disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
            >
              Start Game ({room.players.length}/6 players)
            </button>
          </form>
        )}
      </main>
    );
  }

  return (
    <main className="h-dvh p-4">
      <OnlineGameClient
        roomCode={roomCode}
        initialState={room.game.state as unknown as GameState}
        initialVersion={room.game.version}
        myPlayerId={session.playerId}
      />
    </main>
  );
}
