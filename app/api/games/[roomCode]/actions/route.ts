/**
 * POST submit action — the high-frequency gameplay mutation path. Deliberately a Route
 * Handler rather than a Server Action:
 *  - Server Actions dispatch sequentially per client and bundle a full RSC re-render of the
 *    current route into the response on certain triggers (cookie writes, revalidation) — see
 *    node_modules/next/dist/docs/01-app/02-guides/server-actions.md. A dice roll doesn't need
 *    a server-rendered page re-render; the client already runs the same reducer locally
 *    (optimistic prediction, docs/architecture.md §3) and Realtime pushes the action to
 *    everyone else. A plain JSON response is a better fit than a full navigation payload.
 *  - createGame/joinGame/startGame stay Server Actions (actions/game-actions.ts) since those
 *    genuinely want a redirect.
 */

import { NextResponse } from 'next/server';
import { getRoomSession } from '@/server/auth';
import { submitAction } from '@/server/game-server';
import type { Action } from '@/engine';

export async function POST(request: Request, ctx: { params: Promise<{ roomCode: string }> }) {
  const { roomCode } = await ctx.params;

  const session = await getRoomSession(roomCode);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in to this room' }, { status: 401 });
  }

  let action: Action;
  try {
    action = (await request.json()) as Action;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const result = await submitAction(roomCode, session, action);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ state: result.state, version: result.version });
}
