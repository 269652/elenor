/**
 * Lightweight room-session auth — no accounts (docs/architecture.md §8). A signed, httpOnly
 * cookie scoped to one room proves "this browser is player X in room Y" without a password.
 * `cookies()` is async in Next.js 16 — see node_modules/next/dist/docs/01-app/03-api-reference/
 * 04-functions/cookies.md, checked before writing this file per this project's AGENTS.md.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { cookies } from 'next/headers';

export interface RoomSession {
  roomId: string;
  roomCode: string;
  playerId: string;
  displayName: string;
}

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET is not set — see .env.example');
  return s;
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

function cookieName(roomCode: string): string {
  return `hexrealms_session_${roomCode}`;
}

/** Call from a Server Action or Route Handler after a successful joinGame/createGame. */
export async function setRoomSession(session: RoomSession) {
  const payload = JSON.stringify(session);
  const signature = sign(payload);
  const cookieStore = await cookies();
  cookieStore.set(cookieName(session.roomCode), `${Buffer.from(payload).toString('base64url')}.${signature}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7, // a week — long enough to support async-mode play
  });
}

/** Reads and verifies the session cookie for a given room. Returns null if absent/tampered —
 *  callers should treat that as "not authenticated for this room," not throw. */
export async function getRoomSession(roomCode: string): Promise<RoomSession | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(cookieName(roomCode))?.value;
  if (!raw) return null;

  const [payloadB64, signature] = raw.split('.');
  if (!payloadB64 || !signature) return null;

  const payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
  const expected = sign(payload);

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    return JSON.parse(payload) as RoomSession;
  } catch {
    return null;
  }
}

export async function clearRoomSession(roomCode: string) {
  const cookieStore = await cookies();
  cookieStore.delete(cookieName(roomCode));
}
