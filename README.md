# Hexrealms

*(working title — placeholder, rename freely)*

A browser-based, turn-based hex world-builder that mixes **Settlers of Catan** (hex-tile resource
economy), **Risk** (contested territory, mass combat), and **Munchkin** (a leveling hero who fights
monsters, loots gear, and backstabs rivals) — all on one shared map. 2–6 players, ~45–90 minutes a
session, built as a Next.js web app.

> **Status:** playable. `engine/` implements all six phases against `docs/rules-reference.md` (56
> passing unit tests, including exact reproductions of the doc's worked combat examples), and the
> Next.js app is wired up end-to-end. **Local hotseat play works right now, no setup required** —
> see [Getting Started](#getting-started). Realtime/async online play is fully coded
> (Prisma schema, Route Handlers, Server Actions, Supabase Realtime client) but needs your own
> Supabase project's credentials to activate — see [Online play setup](#online-play-setup).

## The pitch

Every player places tiles onto the **same shared hex world**, so territories border rivals from
early in the game, not just the endgame. Each turn runs through six phases — **Production, Draw &
Place Tile, Move Hero, Gather, Fight, Build** — that force a player between long-term economic
development and short-term opportunism every single turn. One hero per player carries the
Munchkin half of the game: levels, equipped Loot, curses, and the occasional monster-induced
disaster. Three independent win conditions (Victory Points, Domination, or a hero reaching Level
10) are checked every round, so a builder, a conqueror, and a dungeon-diver can all be racing to
finish at once.

## Docs

| Doc | What's in it |
|---|---|
| [`docs/game-design.md`](docs/game-design.md) | The pitch, player experience goals, turn structure in prose, tile/resource/building overview, class flavor, hero/combat/loot narrative, win conditions, target player count & session length. Read this first. |
| [`docs/rules-reference.md`](docs/rules-reference.md) | The authoritative, implementable rulebook — exact formulas, costs, thresholds, and worked numeric examples for every phase. Every value is tagged **[CANON]** (fixed by the design) or **[DEFAULT]** (a concrete placeholder value supplied so the engine is fully buildable — retune freely, see [Open Placeholders](#open-placeholders-to-review)). |
| [`docs/data-model.md`](docs/data-model.md) | TypeScript types for `GameState`, `Tile`, `Player`, `HeroState`, `LootCard`, `MonsterCard`, `ClassDefinition`, and the `Action` discriminated union the reducer consumes. |
| [`docs/architecture.md`](docs/architecture.md) | How this becomes a real Next.js app: one framework-agnostic reducer (`engine/`) shared by all three multiplayer modes, recommended stack, project folder layout, server actions/API surface, auth, deployment. |
| [`docs/ui-spec.md`](docs/ui-spec.md) | Screens, hex-grid rendering approach, responsive/mobile notes, resource iconography, accessibility notes. |

These five were drafted from one shared design canon and then cross-checked against each other for
consistency (terminology, field names, numbers). Three gaps the cross-check surfaced — how a hero's
base Attack stat feeds into combat rolls, and exactly how the Warrior's "extra combat die" resolves
— have since been settled and folded into `rules-reference.md` §6.1/§6.2 and `data-model.md`.

## Core decisions locked in

These came out of design discussion and materially shape the docs above — noting them here so
they're not mistaken for defaults buried in the rules reference:

- **Shared frontier map**, not per-player boards — all tiles go on one world map.
- **Full Munchkin-depth hero** — XP/leveling, equipped Loot by rarity tier, Bad Stuff curse cards.
- **Three simultaneous win conditions** (Victory Points ≥ 15, Domination, Hero Level 10) — first to
  trigger any wins, ties broken by total VP.
- **All three multiplayer modes from day one** — realtime synchronous, async turn-based, and local
  hotseat all ship together in the initial build, sharing one server-authoritative reducer
  (`engine/`) that doesn't fork per mode. This was an explicit choice over a hotseat-first MVP.
- **Tiles produce onto themselves, not the wallet** — a post-launch redesign. Owned tiles
  accumulate a resource stockpile at the start of Phase 3; a hero must physically visit and
  collect it (capped by a carry capacity that scales with hero level), and can spend it
  immediately on the tile they're standing on or must carry it home to the Capital and deposit
  before spending it elsewhere. Buildings stay passive-income producers, but only once someone
  shows up to collect — see `docs/rules-reference.md`'s Changelog note at the top of the file,
  and §2a/§5/§7.6.

## Recommended stack

From `docs/architecture.md`:

- **Next.js (App Router)** + TypeScript, deployed on **Vercel**
- A pure, framework-agnostic **`engine/`** package (reducer + rules) shared by client (hotseat,
  optimistic prediction) and server (authoritative) — the same code runs everywhere, per mode is
  just "who calls it and how the result gets to other players"
- **Supabase Postgres** (via **Prisma**) for persistence — `GameState` stored as a single JSONB
  blob per game row, with an optimistic-concurrency `version` column for race-safety
- **Supabase Realtime** for pushing `{action, version}` updates to connected players — chosen over
  Pusher (doesn't solve authority) and PartyKit (better latency, but a second deployment target
  this turn-based game doesn't need at solo/indie scale); PartyKit is the documented upgrade path
  if that ever changes
- **No accounts for v1** — signed httpOnly session cookies scoped to a room code, host/display-name
  only

## Open placeholders to review

`docs/rules-reference.md` tags every number as **[CANON]** or **[DEFAULT]**. The **[DEFAULT]**
values worth a deliberate look before/while implementing:

- Starting resources (3 Wood / 2 Stone / 3 Food / 1 Ore / 1 Gold) and base hero stats (Level 1, HP
  10, Attack 1) — §1.2/§1.4
- Tile deck size/composition and Monster Level → Loot rarity brackets — §3.3, §6.1
- Full Victory Point scoring table (§10) — canon only fixed the win *threshold* (15), not how
  points are earned
- Capital-upgrade tier costs (§7.3) — canon says "cost scales with tier" without giving numbers
- Working title "Hexrealms," target player count (2–6), and session length (45–90 min) — all
  explicitly flagged as retunable placeholders in `game-design.md` §8

None of these block implementation — they're wired through as named constants specifically so
they're easy to retune without touching engine logic.

## Getting started

```bash
npm install
npm run dev
```

Open the printed localhost URL, click **Play Local (Hotseat)**, name 2–6 players, and play —
classes are dealt randomly per §1.3, the whole turn loop (all six phases) is live, and nothing
requires a database or account. Pass the device between turns.

Other useful commands:

```bash
npm test          # 56 unit tests — combat formulas, XP table, win conditions, a full-turn
                   # integration test, and a regression test for every bug live browser
                   # testing caught along the way
npm run build      # production build (also runs the TypeScript compiler)
npm run lint       # ESLint
```

## Online play setup

Realtime/async multiplayer needs your own Supabase project (Claude will not create one on your
behalf — see the repo's safety rules). To activate it:

1. Create a free project at [supabase.com](https://supabase.com).
2. Copy `.env.example` to `.env.local` and fill in `DATABASE_URL`, `DIRECT_URL` (Settings →
   Database), `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (Settings → API), and a
   random `SESSION_SECRET`.
3. `npx prisma migrate dev` to create the `rooms`/`room_players`/`games`/`game_events` tables
   (schema at `prisma/schema.prisma`).
4. Restart `npm run dev` — the landing page's **Play Online** create/join forms activate
   automatically once Supabase env vars are present (see `lib/supabase-client.ts`).

Until then, **Play Online** stays visibly disabled with an inline note — it's not silently broken,
it's gated on credentials only you can provide.

## Implementation map

| Path | What's there |
|---|---|
| `engine/` | The whole rules engine — pure TypeScript, zero framework imports, fully unit-tested (`engine/__tests__/`). `types.ts` mirrors `docs/data-model.md`; `reducers.ts` + `reducer.ts` implement every phase; `combat.ts`, `decks.ts`, `selectors.ts`, `constants.ts`, `catalogs.ts` back it up. A handful of gaps the spec left open (hero-death/respawn, PvP/RogueSteal target choice, Militia purchase having no action type, hero base Attack never wired into combat formulas) are resolved and commented in place — grep for "v1 simplification"/"v1 DEFAULT" to find every one. |
| `server/`, `lib/`, `actions/`, `app/api/` | The realtime/async persistence + transport layer per `docs/architecture.md` — Prisma-backed optimistic-concurrency writes, Supabase Realtime broadcast, signed room-session cookies. |
| `hooks/use-local-game.ts` | Hotseat: runs the engine directly in the browser. |
| `hooks/use-online-game.ts` | Realtime/async: optimistic local apply + Route Handler POST + Realtime subscription/focus-poll reconciliation. |
| `components/` | The board (SVG hex rendering), HUD, hero panel, build menu, and the lobby/setup flow. |

## Next steps

1. Play a few local hotseat games and retune whichever `[DEFAULT]` constant in
   `engine/constants.ts` doesn't feel right (they're all named constants specifically so this
   never means touching reducer logic).
2. If you want online play, follow [Online play setup](#online-play-setup) above.
3. Revisit the "v1 simplification" spots called out in [Implementation map](#implementation-map)
   — each was a genuine judgment call made to keep a first playable version moving, not a
   hidden bug.
