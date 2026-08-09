/** GET snapshot — used for initial load, reconnects, and async-mode polling on focus.
 *  Next.js 16: route params are a Promise — must `await ctx.params` (checked against the
 *  bundled docs, see AGENTS.md). */

import { NextResponse } from 'next/server';
import { getRoomSession } from '@/server/auth';
import { loadGameByRoomCode } from '@/server/game-store';

export async function GET(_request: Request, ctx: { params: Promise<{ roomCode: string }> }) {
  const { roomCode } = await ctx.params;

  const session = await getRoomSession(roomCode);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in to this room' }, { status: 401 });
  }

  const loaded = await loadGameByRoomCode(roomCode);
  if (!loaded) {
    return NextResponse.json({ error: 'No active game for this room yet' }, { status: 404 });
  }

  return NextResponse.json({ state: loaded.state, version: loaded.version });
}
