'use server';

/**
 * Server Actions for room lifecycle (create/join/start) — these naturally want a redirect
 * after mutating, which is exactly the "single roundtrip" shape Server Actions cover well
 * (node_modules/next/dist/docs/01-app/02-guides/server-actions.md). The high-frequency
 * `submitAction` gameplay path is deliberately a Route Handler instead — see
 * app/api/games/[roomCode]/actions/route.ts for why.
 */

import { redirect } from 'next/navigation';
import { createGame as engineCreateGame, type SetupPlayerInput } from '@/engine';
import { clearRoomSession, getRoomSession, setRoomSession } from '@/server/auth';
import { createGameRecord, createRoom, getRoomByCode, joinRoom, listRoomPlayers } from '@/server/game-store';
import { isSupabaseConfigured } from '@/lib/supabase-client';

const PLAYER_COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#eab308', '#a855f7', '#f97316'];

function requireBackendConfigured() {
  if (!isSupabaseConfigured()) {
    throw new Error('Online play needs a Supabase project — copy .env.example to .env.local and fill in your credentials. Local hotseat mode works without this.');
  }
}

export async function createGameAction(formData: FormData) {
  requireBackendConfigured();
  const displayName = String(formData.get('displayName') ?? '').trim();
  if (!displayName) throw new Error('Display name is required');

  const { roomId, roomCode, playerId } = await createRoom(displayName);
  await setRoomSession({ roomId, roomCode, playerId, displayName });
  redirect(`/play/${roomCode}`);
}

export async function joinGameAction(formData: FormData) {
  requireBackendConfigured();
  const displayName = String(formData.get('displayName') ?? '').trim();
  const roomCode = String(formData.get('roomCode') ?? '').trim().toUpperCase();
  if (!displayName || !roomCode) throw new Error('Display name and room code are required');

  const { roomId, playerId } = await joinRoom(roomCode, displayName);
  await setRoomSession({ roomId, roomCode, playerId, displayName });
  redirect(`/play/${roomCode}`);
}

export async function startGameAction(roomCode: string) {
  requireBackendConfigured();
  const session = await getRoomSession(roomCode);
  if (!session) throw new Error('You are not signed in to this room');

  const room = await getRoomByCode(roomCode);
  if (!room) throw new Error('Room not found');
  if (room.hostPlayerId !== session.playerId) throw new Error('Only the host can start the game');
  if (room.status !== 'lobby') throw new Error('This game has already started');

  const players = await listRoomPlayers(room.id);
  if (players.length < 2) throw new Error('Need at least 2 players to start (§1.1)');

  const setupPlayers: SetupPlayerInput[] = players.map((p, i) => ({
    id: p.id,
    name: p.displayName,
    color: PLAYER_COLORS[i % PLAYER_COLORS.length],
  }));

  const seed = `${roomCode}-${room.id}`; // deterministic per room, fine for a non-adversarial party game
  const initialState = engineCreateGame(room.id, setupPlayers, seed, 'async');
  await createGameRecord(room.id, initialState);

  redirect(`/play/${roomCode}`);
}

export async function leaveRoomAction(roomCode: string) {
  await clearRoomSession(roomCode);
  redirect('/');
}
