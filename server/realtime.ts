/**
 * Supabase Realtime publish helper — docs/architecture.md §4. Broadcasts the applied Action
 * (not the full State) to everyone subscribed to `game:{gameId}`; each client already holds
 * `version - 1` and the shared reducer, so `{action, version}` is enough to derive state
 * `version` locally. Silently no-ops if Supabase isn't configured — realtime mode is opt-in.
 */

import { getSupabaseServerClient, isSupabaseConfigured } from '@/lib/supabase-client';
import type { Action } from '@/engine';

export async function broadcastAction(gameId: string, action: Action, version: number) {
  if (!isSupabaseConfigured()) return; // hotseat/no-backend dev — nothing to broadcast to
  const supabase = getSupabaseServerClient();
  const channel = supabase.channel(`game:${gameId}`);
  await channel.send({ type: 'broadcast', event: 'action', payload: { action, version } });
}

export function gameChannelName(gameId: string): string {
  return `game:${gameId}`;
}
