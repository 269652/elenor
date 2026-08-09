import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/** True once the user has provisioned their own Supabase project and filled in .env.local —
 *  see .env.example. Realtime/async modes stay disabled (hotseat still works) until then. */
export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

let browserClient: SupabaseClient | null = null;

/** Client-side Supabase client (anon key) — used to subscribe to a game's Realtime channel. */
export function getSupabaseBrowserClient(): SupabaseClient {
  if (!isSupabaseConfigured()) {
    throw new Error('Supabase is not configured — copy .env.example to .env.local and fill in your project credentials.');
  }
  if (!browserClient) {
    browserClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  }
  return browserClient;
}

/** Server-side Supabase client, used only to publish a broadcast after a Server Action /
 *  Route Handler persists a new game state. Uses the same anon key — broadcasting a game
 *  event is not a privileged operation, the write path (Prisma) is what's authoritative. */
export function getSupabaseServerClient(): SupabaseClient {
  if (!isSupabaseConfigured()) {
    throw new Error('Supabase is not configured — copy .env.example to .env.local and fill in your project credentials.');
  }
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
}
