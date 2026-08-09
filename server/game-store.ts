/**
 * Prisma-backed persistence adapter — docs/architecture.md §5. GameState round-trips as a
 * single JSONB blob; `version` lives on the `games` row (optimistic concurrency), not inside
 * the JSON itself.
 */

import { prisma } from '@/lib/prisma';
import { generateRoomCode } from '@/lib/room-code';
import type { GameState } from '@/engine';

export async function createRoom(hostDisplayName: string) {
  const roomCode = generateRoomCode();
  const room = await prisma.room.create({ data: { roomCode, status: 'lobby' } });
  const player = await prisma.player.create({
    data: { roomId: room.id, displayName: hostDisplayName, sessionSecret: cryptoRandom(), isHost: true },
  });
  await prisma.room.update({ where: { id: room.id }, data: { hostPlayerId: player.id } });
  return { roomId: room.id, roomCode: room.roomCode, playerId: player.id };
}

export async function joinRoom(roomCode: string, displayName: string) {
  const room = await prisma.room.findUnique({ where: { roomCode }, include: { players: true } });
  if (!room) throw new Error(`No room with code ${roomCode}`);
  if (room.status !== 'lobby') throw new Error('This game has already started');
  if (room.players.length >= 6) throw new Error('Room is full (max 6 players)');

  const player = await prisma.player.create({
    data: { roomId: room.id, displayName, sessionSecret: cryptoRandom(), isHost: false },
  });
  return { roomId: room.id, roomCode: room.roomCode, playerId: player.id };
}

export async function listRoomPlayers(roomId: string) {
  return prisma.player.findMany({ where: { roomId }, orderBy: { joinedAt: 'asc' } });
}

export async function getRoomByCode(roomCode: string) {
  return prisma.room.findUnique({ where: { roomCode }, include: { players: true, game: true } });
}

export async function createGameRecord(roomId: string, initialState: GameState) {
  await prisma.room.update({ where: { id: roomId }, data: { status: 'active' } });
  return prisma.game.create({ data: { roomId, state: initialState as unknown as object, version: 1 } });
}

export interface LoadedGame {
  gameId: string;
  version: number;
  state: GameState;
}

export async function loadGameByRoomCode(roomCode: string): Promise<LoadedGame | null> {
  const room = await prisma.room.findUnique({ where: { roomCode }, include: { game: true } });
  if (!room?.game) return null;
  return { gameId: room.game.id, version: room.game.version, state: room.game.state as unknown as GameState };
}

export interface SaveResult {
  success: boolean;
  newVersion?: number;
}

/** Optimistic-concurrency write: succeeds only if the row's version still matches
 *  `expectedVersion`. On conflict (another submitAction landed first), callers should reload
 *  and retry rather than silently overwrite a concurrent player's move. */
export async function saveGame(gameId: string, newState: GameState, expectedVersion: number): Promise<SaveResult> {
  const result = await prisma.game.updateMany({
    where: { id: gameId, version: expectedVersion },
    data: { state: newState as unknown as object, version: { increment: 1 } },
  });
  if (result.count === 0) return { success: false };
  return { success: true, newVersion: expectedVersion + 1 };
}

export async function appendGameEvent(gameId: string, seq: number, action: unknown) {
  await prisma.gameEventRow.create({ data: { gameId, seq, action: action as object } });
}

function cryptoRandom(): string {
  // Node's global crypto (Web Crypto) is available in the Next.js server runtime.
  return crypto.randomUUID();
}
