/**
 * [DEFAULT — direct request: "add a 'Public' switch when hosting a P2P room which lists the room
 * publicly using the next.js server api which keeps track of all open lobbies"] A tiny, in-memory
 * directory of currently-open PUBLIC P2P rooms — NOT a database, and deliberately so: P2P's whole
 * pitch (lib/webrtc/protocol.ts's file header) is zero server, zero database, zero cost. This is
 * the one exception, and only for the opt-in "Public" listing itself — the actual game (state,
 * players, chat, voice) never touches this or any server at all, still purely WebRTC between
 * browsers. A host's own browser tab heartbeats this list (POST /api/lobbies via
 * hooks/use-public-lobby.ts) every LOBBY_HEARTBEAT_INTERVAL_MS while public and still in its
 * pre-game lobby; this module just remembers the last heartbeat per room code and prunes anything
 * that's gone stale.
 *
 * [KNOWN LIMITATION] A plain module-level Map only shares state across requests that land on the
 * SAME warm server instance. This project deploys to Netlify, whose Next.js runtime can reuse a
 * warm instance across nearby requests but offers no guarantee of exactly one instance, or that a
 * given instance stays warm — under real concurrent traffic, different instances could each end up
 * with their own, partially-overlapping view of the list. Acceptable for this project's actual
 * scale (a casual hobby game's public lobby board, not a matchmaking service under real load) — a
 * shared store (Redis, or the Prisma/Postgres this app already has for the Play Online mode, see
 * server/game-store.ts) would fix it, but that's a genuine infrastructure decision this project
 * hasn't made (and doesn't need, to ship this), not a default to reach for silently.
 */

export interface PublicLobbyEntry {
  roomCode: string;
  hostName: string;
  playerCount: number;
  maxPlayers: number;
  createdAt: number;
  lastPingAt: number;
}

// Module-level singleton — see the file header's [KNOWN LIMITATION] for what this does and
// doesn't guarantee under real serverless horizontal scaling.
const lobbies = new Map<string, PublicLobbyEntry>();

/** [DEFAULT — direct request: "the nextjs server should ping the lobby every 30s and clean up
 *  stale lobbies"] The server can't literally reach INTO a host's browser tab to ping it — there's
 *  no public address for a WebRTC host behind NAT, only the room code its PeerJS connection
 *  answers to. So this is inverted: the host's own tab pings THIS server every
 *  LOBBY_HEARTBEAT_INTERVAL_MS (hooks/use-public-lobby.ts) to prove it's still open, and the
 *  server's only job is to forget anything that stopped doing that. 3x the heartbeat interval's
 *  worth of grace (two missed beats) before eviction — long enough to absorb one occasional
 *  slow/dropped request, short enough that a genuinely closed room disappears from the list within
 *  about a minute and a half even if its own explicit unregister (also in use-public-lobby.ts)
 *  never arrives (a crashed tab, a lost network — the explicit DELETE is the fast path, this is
 *  the fallback that fires regardless). */
const STALE_MS = 90_000;

/** Defensive cap against unbounded growth from a buggy or abusive client hammering POST with
 *  fresh room codes — evicts the stalest entries first once over the limit. Nothing about this
 *  project's actual expected usage gets anywhere near this; it exists purely as a floor, not a
 *  tuned capacity number. */
const MAX_TRACKED_LOBBIES = 500;

function pruneStale() {
  const cutoff = Date.now() - STALE_MS;
  for (const [code, entry] of lobbies) {
    if (entry.lastPingAt < cutoff) lobbies.delete(code);
  }
}

export function listPublicLobbies(): PublicLobbyEntry[] {
  pruneStale();
  return [...lobbies.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function upsertPublicLobby(entry: { roomCode: string; hostName: string; playerCount: number; maxPlayers: number }) {
  pruneStale();
  const existing = lobbies.get(entry.roomCode);
  lobbies.set(entry.roomCode, {
    ...entry,
    createdAt: existing?.createdAt ?? Date.now(),
    lastPingAt: Date.now(),
  });
  if (lobbies.size > MAX_TRACKED_LOBBIES) {
    const stalestFirst = [...lobbies.entries()].sort((a, b) => a[1].lastPingAt - b[1].lastPingAt);
    for (const [code] of stalestFirst.slice(0, lobbies.size - MAX_TRACKED_LOBBIES)) lobbies.delete(code);
  }
}

/** [DEFAULT — direct request: "When the game starts or the room closes it should vanish from the
 *  list"] The explicit, immediate path — hooks/use-public-lobby.ts calls this the instant the
 *  host's lobby unmounts (game started) or the "Public" toggle goes off, rather than waiting out
 *  STALE_MS. */
export function removePublicLobby(roomCode: string) {
  lobbies.delete(roomCode);
}
