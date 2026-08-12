# Elenor — Technical Architecture

## 1. Overall Approach

Elenor is built around a single **server-authoritative reducer**: a pure function `applyAction(state, action) -> newState` that encodes every rule in the design canon (phase order, resource math, combat resolution, win conditions). This function is the *only* place game rules live. Everything else — UI, persistence, networking, auth — is a thin shell around it.

Two properties make this work across three very different multiplayer modes:

1. **Purity.** The reducer never touches `Date.now()`, `Math.random()`, the network, or the DOM. Given the same `(state, action)` pair, it always produces the same result. This is what lets the identical code run client-side with no backend (hotseat) *and* server-side as the source of truth (realtime/async).
2. **Determinism via seeded state.** Dice rolls, deck shuffles, and monster draws are derived from a PRNG stream seeded by `GameState.rngSeed`. "Roll a d6" is really "advance a seeded stream by the next draw index and read its value," where the draw index is itself deterministic — recovered by replaying `GameState.eventLog` (each `GameEvent.seq` marks a logical tick, so "how many random draws have happened so far" is always derivable from the log rather than needing its own mutable cursor field). This means replaying the same action log from the same seed always reaches the same state — required for server validation, reconnection, spectating, and client-side prediction.

The reducer is transport-agnostic. Whether an action arrives over a WebSocket, a Server Action HTTP call, or a plain in-memory `dispatch()` in a browser tab is irrelevant to it — that's the whole point of the design below.

## 2. Core Engine: GameState, Action, Reducer

`engine/types.ts` is not a parallel type definition — it is the same canonical `GameState`/`Action`/`Phase` shape specified in `docs/data-model.md`, reproduced here for readability. Field names, casing, and structure below match `data-model.md` exactly so the engine and the data model can never drift apart.

```ts
// engine/types.ts
export enum Phase {           // Production..Build, exact canon order — same enum as data-model.md
  Production = 0,
  DrawAndPlaceTile = 1,
  MoveHero = 2,
  Gather = 3,
  Fight = 4,
  Build = 5,
}

interface GameState {
  gameId: string;
  mode: "realtime" | "async" | "hotseat";
  rngSeed: string;                  // seeds all deck shuffles and dice rolls
  roundNumber: number;
  turnOrder: PlayerId[];
  currentPlayerId: PlayerId;
  currentPhase: Phase;
  map: Record<HexKey, Tile>;        // key: "q,r" axial coord
  players: Player[];                // each Player embeds its own `hero`
  tileDeck: TileDeckState;
  monsterDeck: MonsterDeckState;
  lootDeck: LootDeckState;
  badStuffDeck: BadStuffDeckState;
  eventLog: GameEvent[];            // append-only, for spectators/replay/rng-cursor recovery
  winnerId: PlayerId | null;
  winCondition: "VictoryPoints" | "Domination" | "HeroLevelRace" | null;
}

interface BaseAction {
  actorId: PlayerId;
  heroId?: string; // accepted but currently always resolves to the player's one hero — see selectors.ts's resolveHero
}

type Action =
  | ({ type: "DrawTile" } & BaseAction)
  | ({ type: "PlaceTile"; tileType: TileType; coord: HexCoord } & BaseAction)
  | ({ type: "MoveHero"; path: HexCoord[]; viaBoat?: boolean } & BaseAction)
  | ({ type: "Gather"; coord: HexCoord; gatherKind: "Forage" | "LootRuins" | "Hunt" | "RogueSteal" } & BaseAction)
  | ({ type: "Fight"; combatType: "HeroVsMonster"; coord: HexCoord; monsterCardId: string } & BaseAction)
  | ({ type: "Fight"; combatType: "HeroVsHero"; targetPlayerId: PlayerId; targetHeroId: string; isBackstab: boolean } & BaseAction)
  | ({ type: "Fight"; combatType: "ArmyVsTerritory"; fromCoord: HexCoord; targetCoord: HexCoord; attackingUnits: number } & BaseAction)
  | ({ type: "Fight"; combatType: "TameVolcano"; coord: HexCoord } & BaseAction)
  | ({ type: "Build"; buildingType: BuildingType; coord: HexCoord } & BaseAction)
  | ({ type: "LevelUpHero" } & BaseAction)
  | ({ type: "EquipLoot"; lootCardId: string } & BaseAction)
  | ({ type: "UnequipLoot"; lootCardId: string } & BaseAction)
  | ({ type: "TradeWithBank"; give: ResourceType; giveAmount: number; receive: ResourceType } & BaseAction)
  | ({ type: "AdvancePhase" } & BaseAction)
  | ({ type: "EndTurn" } & BaseAction);

// engine/reducer.ts
function applyAction(
  state: GameState,
  action: Action
):
  | { ok: true; state: GameState; events: GameEvent[] }
  | { ok: false; error: string };
```

Note on `version`: the type above deliberately has no `version` field. Optimistic-concurrency versioning is a *persistence-layer* concern, not a rules concern — it lives on the `games` table's `version` column (§5), one level outside the `GameState` blob the reducer operates on. Keeping it out of `GameState` also keeps the hotseat mode (which never touches a DB row) using the exact same type as the networked modes.

Each action type has a co-located validator (`engine/validators.ts`) checking turn ownership, current phase, adjacency/legality, and resource cost *before* mutating anything, so illegal actions fail cleanly with `{ ok: false }` instead of throwing. Phase 0 (Production) has no player-submitted action — it's applied automatically as part of the transition into a player's turn (a synthetic step the reducer runs when `currentPlayerId` changes), matching "Production happens automatically" in the canon.

Because the reducer is pure, it is trivially unit-testable: feed a `GameState` fixture and an `Action`, assert the output — no server, DB, or browser required.

## 3. One Engine, Three Modes (Transport as Config)

The engine package (`engine/`) has zero imports from React, Next.js, or any DB/network client. The three play modes differ only in **who calls `applyAction` and how the result gets to other players**:

| Mode | Where the reducer runs | How actions reach it | How other players see updates |
|---|---|---|---|
| **Local hotseat** | In-browser, via `useReducer` wrapping `applyAction` directly | Local `dispatch()` calls, no network | N/A — same screen, pass-and-play |
| **Async turn-based** | Server (Server Action / API route) | `submitAction` Server Action, persisted per call | Client re-fetches `getState()` on load/focus; no live push needed |
| **Realtime synchronous** | Server (authoritative) **and** client (optimistic prediction, same code) | `submitAction`, plus client applies the action locally before the ack | Realtime channel pushes the applied `Action` + new `version`; every subscribed client runs the *same* `applyAction` to reach the same state |

The key design choice for realtime is to **broadcast the Action, not the full State**. Every client already holds the persistence layer's `version N-1` and the shared reducer, so receiving `{ action, version: N }` (the `version` here is the DB row's optimistic-concurrency counter from §5, attached by the server alongside the broadcast — not a field of `GameState` itself) is enough to derive state `N` locally — bandwidth-light, and it means the engine is exercised identically on server and client rather than reimplemented twice. If a client's version ever falls behind by more than one (dropped message, reconnect), it just calls `getState()` to resync from the DB snapshot.

`hooks/use-game-state.ts` is the single seam where mode is selected: it exposes the same `{ state, dispatch, isMyTurn }` interface to UI components regardless of mode, internally choosing between "local reducer" and "server actions + realtime subscription." UI code never knows or cares which mode it's in.

## 4. Realtime Transport

Evaluated three options for pushing action updates to connected players:

- **Pusher** — pure pub/sub fan-out. It solves broadcasting but not authority: you still need a separate server (Vercel function + DB) to validate and persist every action, plus your own locking to avoid two near-simultaneous submissions racing each other. It adds a vendor without removing any of the hard problems, so it's the weakest fit here.
- **PartyKit (Cloudflare Durable Objects)** — a strong technical fit: one room = one single-threaded object that can hold `GameState` in memory, apply the reducer, and broadcast, which eliminates race conditions by construction and gives the lowest latency of the three. The cost is operational: it's a second deployment target (Cloudflare Workers, separate from Vercel), and room membership/session needs to be bridged from the Next.js side via a signed token. That's reasonable overhead for a game that truly needs sub-100ms sync, but Elenor is turn-based (hex placement, hero moves, dice rolls) — not a twitch game — so this buys latency the design doesn't need at solo-project scale.
- **Supabase Realtime** — pairs naturally with Postgres as the persistence layer (see below), which matters most for an indie/solo project: one vendor, one dashboard, one bill, and no second deployment target. The authoritative apply still happens in a Vercel Server Action (load row → `applyAction` → write row), with race safety handled by simple **optimistic concurrency**: the write is `UPDATE games SET state=…, version=version+1 WHERE id=… AND version=$expected`, retried on conflict. A `channel.send()`/`postgres_changes` broadcast then pushes the applied action to subscribers. The extra DB round-trip per action (tens of ms) is invisible for a game paced in seconds, not frames.

**Recommendation: Supabase Realtime**, paired with Supabase Postgres for persistence. For a solo/indie build the win isn't raw performance — it's collapsing "database" and "realtime pub/sub" into a single vendor and a single mental model (write to Postgres → subscribers get notified), with the entire authoritative path living in ordinary Vercel Server Actions and no always-on process to operate. PartyKit is the documented upgrade path if a future version needs true low-latency co-located state (the room's message handler would call the exact same `applyAction` — the engine doesn't change, only the adapter in `server/`).

## 5. Persistence

**Recommendation: Postgres (hosted on Supabase), accessed through Prisma.**

Reasoning for indie/solo scale:
- A single managed Postgres instance is durable, supports concurrent games via simple row-per-game locking (the `version` column above), and needs no separate cache/queue layer — avoiding a Redis + Postgres + message-broker stack that would be overkill for this project's traffic.
- Pairing it with Supabase also supplies Realtime "for free" on the same data (see §4) and leaves room to add Supabase Auth later (e.g., anonymous auth for persistent stats) without touching the engine, since auth is intentionally orthogonal to game logic.
- Prisma gives typed schema/migrations, which matters because `GameState` is a large evolving TypeScript shape — but the game state itself is stored as a **single JSONB column**, not fully normalized into relational tables. Round-tripping the whole state as one blob matches how the reducer consumes it (load → reduce → save) and keeps queries simple; JSONB still allows indexing/filtering (e.g., listing open lobbies) if needed later.
- Prisma's connection pooling (via Supabase's pooled/pgbouncer connection string) is required regardless, since Vercel Server Actions are short-lived serverless invocations that would otherwise exhaust Postgres connections.

Proposed schema (`prisma/schema.prisma`):

- `rooms` — `id, roomCode, status (lobby|active|finished), hostPlayerId, createdAt`
- `room_players` — `id, roomId, displayName, sessionSecret, isHost, joinedAt`
- `games` — `id, roomId, state (Json), version (Int), updatedAt` — the authoritative `GameState` blob, with `version` living on this row rather than inside the `state` JSON itself (see the note in §2)
- `game_events` (optional, cheap to add) — `id, gameId, seq, action (Json), createdAt` — append-only action log enabling replay, debugging, and a future spectator mode "for free" since the reducer can rebuild any prior state from seed + log

## 6. Next.js Project Structure

```
elenor/
  app/
    (marketing)/page.tsx              # landing page
    play/[roomCode]/page.tsx          # game board UI — mode-agnostic
    api/
      games/route.ts                  # POST create game (fallback if not using Server Actions)
      games/[roomCode]/route.ts       # GET snapshot
      games/[roomCode]/join/route.ts  # POST join
      games/[roomCode]/actions/route.ts # POST submit action (non-Server-Action clients)
    layout.tsx
  actions/
    game-actions.ts                   # createGame, joinGame, startGame, submitAction, getState
  engine/                             # pure, framework-agnostic — the shared core
    types.ts
    reducer.ts
    reducers/ (production.ts, placeTile.ts, moveHero.ts, gather.ts, fight.ts, build.ts)
    rng.ts                            # seeded PRNG + helpers
    decks.ts                          # deterministic shuffle from seed
    validators.ts
    selectors.ts
    index.ts                          # public engine API
  server/
    game-store.ts                     # persistence adapter (Prisma)
    game-server.ts                    # validate -> reduce -> persist -> broadcast
    realtime.ts                       # Supabase Realtime channel helpers
    auth.ts                           # room-code/session cookie helpers
  components/
    board/ hero/ hud/ lobby/
  hooks/
    use-game-state.ts                 # picks local-reducer vs realtime+server-actions
    use-local-game.ts                 # hotseat useReducer wrapper
  lib/
    prisma.ts  supabase-client.ts  room-code.ts
  prisma/schema.prisma
  docs/architecture.md
```

`engine/` is the only directory that must never import React, Next.js, or a DB client — that boundary is what keeps the "same engine, three modes" promise enforceable rather than aspirational (it can later be extracted to its own workspace package if desired).

## 7. Server Actions / API Surface

The mutating surface is intentionally small — almost all gameplay funnels through one endpoint, since the reducer (not the API layer) owns the rules:

- **`createGame()`** — generates a room code, seeds `rngSeed` from `crypto`, creates `rooms`/`games` rows, returns `{ roomCode, gameId }`.
- **`joinGame(roomCode, displayName)`** — validates the room is open, adds a `room_players` row (or reconnects an existing player via session cookie), issues a signed session cookie scoped to that room.
- **`startGame(gameId)`** — host-only; locks the player list, randomly draws classes, initializes the map with starting tiles, sets `currentPhase = Phase.Production`, writes `version = 1`.
- **`submitAction(gameId, action)`** — loads current state, checks `action.actorId`/turn/phase legality, calls `engine.applyAction`, persists with optimistic concurrency (`WHERE version = expected`, retry on conflict), broadcasts `{ action, version }` via Realtime, returns the result. Also exposed as `POST /api/games/[roomCode]/actions` for non-Server-Action callers.
- **`getState(gameId)`** — returns the current snapshot + version. Used for initial load, reconnects, async-mode polling on focus, and realtime resync after a missed broadcast.
- **Subscribe** — not a REST endpoint; the client opens a Supabase Realtime channel (`game:{gameId}`) after `getState()` and receives pushed `{ action, version }` messages, applying them through the same client-side `applyAction`.

There is deliberately no separate `endTurn`/`leaveGame`/etc. — ending a phase is just an `AdvancePhase` (or `EndTurn`) action through `submitAction`, keeping rules changes confined to `engine/`.

## 8. Auth & Sessions

No accounts for v1 — kept intentionally lightweight:

- **Room code**: a short, human-shareable code (e.g., 6-char base32, ambiguous characters excluded) generated at `createGame`, mapping to `gameId`.
- **Display name**: chosen at `joinGame`, no password.
- **Session**: on join, the server issues a signed, httpOnly cookie (`{ gameId, playerId, displayName }`, scoped to the room) via `cookies()` in a Server Action — enough to stop one player from spoofing another's moves, without any real account system. This also drives reconnection: reopening the room URL hours later (async mode) re-authenticates the same player from the cookie.
- **Host privileges** (start game, kick a player before start) are gated by an `isHost` flag set on the first joiner, not by any account system.
- Because auth is fully decoupled from the engine, swapping in Supabase Auth (e.g., anonymous auth for cross-device history, or real accounts later) is a `server/auth.ts` change only — the reducer and the multiplayer-mode logic are untouched.

## 9. Deployment

- **Vercel** hosts the Next.js app (App Router). Server Actions and API routes run as Vercel serverless functions; static/marketing pages serve from the edge.
- **Supabase** hosts Postgres (via pooled/pgbouncer connection string for serverless-safe pooling) and Realtime, as a separate managed service reached over the network — no infrastructure to operate.
- There is no always-on custom server: the "authoritative game server" is just the `submitAction` Server Action running per-request, with Postgres (plus the `version` column) providing the durability and race-safety that an in-memory process would otherwise need to provide. This scales to zero between sessions and fits a solo/indie cost profile.
- If realtime latency/scale ever demands it, PartyKit on Cloudflare is the documented escape hatch (§4) — it would run as a second deployment, reusing `engine/` unchanged inside its room message handler.

## 10. Explicitly Deferred (v1 Non-Goals)

OAuth/accounts, push notifications for async-mode turn alerts (v1 relies on poll-on-focus + a "your turn" indicator), spectator mode, matchmaking, in-game chat, and mobile apps. The architecture above doesn't block any of these — auth, notifications, and spectating are all additive to the engine/transport boundary, not changes to it.
