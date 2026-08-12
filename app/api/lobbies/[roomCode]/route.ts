/** [DEFAULT — direct request: "When the game starts or the room closes it should vanish from the
 *  list"] Item-level unregister — hooks/use-public-lobby.ts calls this the instant a public
 *  lobby's host tab leaves the pre-game lobby (game started) or the "Public" toggle goes off,
 *  ahead of lib/publicLobbyStore.ts's own STALE_MS fallback for the crashed-tab case.
 *  Next.js 16: route params are a Promise — must `await ctx.params` (see AGENTS.md). */

import { NextResponse } from 'next/server';
import { normalizeRoomCode } from '@/lib/webrtc/protocol';
import { removePublicLobby } from '@/lib/publicLobbyStore';

export async function DELETE(_request: Request, ctx: { params: Promise<{ roomCode: string }> }) {
  const { roomCode } = await ctx.params;
  removePublicLobby(normalizeRoomCode(roomCode));
  return NextResponse.json({ ok: true });
}
