/** [DEFAULT — direct request: "add a 'Public' switch when hosting a P2P room which lists the room
 *  publicly using the next.js server api which keeps track of all open lobbies"] Collection-level
 *  handlers: GET lists every currently-live public lobby, POST is the host's heartbeat/register
 *  call (upsert by roomCode — see lib/publicLobbyStore.ts). No auth, same trust model the rest of
 *  the P2P layer already has (anyone who knows a room code can already dial straight into it via
 *  PeerJS) — this is a discovery convenience, not a security boundary. */

import { NextResponse } from 'next/server';
import { isPlausibleRoomCode, normalizeRoomCode } from '@/lib/webrtc/protocol';
import { listPublicLobbies, upsertPublicLobby } from '@/lib/publicLobbyStore';

export async function GET() {
  return NextResponse.json({ lobbies: listPublicLobbies() });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.roomCode !== 'string' || typeof body.hostName !== 'string') {
    return NextResponse.json({ error: 'Invalid lobby payload' }, { status: 400 });
  }
  const roomCode = normalizeRoomCode(body.roomCode);
  if (!isPlausibleRoomCode(roomCode)) {
    return NextResponse.json({ error: 'Invalid room code' }, { status: 400 });
  }
  const hostName = body.hostName.trim().slice(0, 40) || 'Host';
  const playerCount = Number.isFinite(body.playerCount) ? Math.max(0, Math.floor(body.playerCount)) : 0;
  const maxPlayers = Number.isFinite(body.maxPlayers) ? Math.max(1, Math.floor(body.maxPlayers)) : 6;

  upsertPublicLobby({ roomCode, hostName, playerCount, maxPlayers });
  return NextResponse.json({ ok: true });
}
