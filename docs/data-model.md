# HexRealms — Engine Data Model

TypeScript-flavored spec for the shared game-state engine. This file defines the canonical
`GameState` shape and the `Action` union a single reducer function consumes. Every identifier
below is derived directly from the design canon — resource, tile, building, class, and phase
names are used verbatim (as comments, string literals, or union members) so the type layer can't
drift from the rulebook.

The engine is written once and driven by three transports (Realtime, Async, Hotseat) — see
[Replay parity across modes](#replay-parity-across-realtime-async-and-hotseat-modes) at the end.

---

## 1. Coordinates

```typescript
/** Axial hex coordinate. */
export interface HexCoord {
  q: number;
  r: number;
}

/** Stable string key for map lookups, always "${q},${r}". */
export type HexKey = `${number},${number}`;

export function hexKey(coord: HexCoord): HexKey {
  return `${coord.q},${coord.r}`;
}

/** **New in the territory rework.** Stable key for the EDGE between two adjacent hexes, always
 *  "q1,r1|q2,r2" with the two endpoints in canonical (sorted) order — so the same border produces
 *  the same key no matter which side names it first, and `roads[edgeKey(a, b)]` and
 *  `roads[edgeKey(b, a)]` are the same slot. Roads live on edges, not tiles: see `GameState.roads`
 *  in §10 and Rules Reference §7.7. */
export type EdgeKey = string;

export function edgeKey(a: HexCoord, b: HexCoord): EdgeKey {
  const ka = hexKey(a);
  const kb = hexKey(b);
  return ka <= kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}
```

`EdgeKey` is a plain `string` rather than a template-literal type on purpose — the canonical
ordering is a runtime property of `edgeKey()`, not something the type system can enforce, so
pretending otherwise would only invite hand-built keys that skip the sort. **Never construct an edge
key by hand; always call `edgeKey()`.**

---

## 2. Resources

Six resources, per canon. `Meat` was added in the balance rework (Rules Reference's second
Changelog, §1.2/§7.1/§6.3a) — it's the Cow Stable's product and the cheaper of the two Soldier
Upkeep currencies; every other resource-shaped type below just iterates the union, so adding it
here is the one place that mattered.

```typescript
export type ResourceType = 'Wood' | 'Stone' | 'Food' | 'Ore' | 'Meat' | 'Gold';

/** A full accounting of a player's stockpile — always has all six keys. */
export type ResourceBundle = Record<ResourceType, number>;

/** A cost or partial delta, e.g. Windmill's "2 Stone + 2 Wood". */
export type ResourceCost = Partial<Record<ResourceType, number>>;

export function emptyResourceBundle(): ResourceBundle {
  return { Wood: 0, Stone: 0, Food: 0, Ore: 0, Meat: 0, Gold: 0 };
}
```

Starting resources (Rules Reference §1.2) are zeroed out as of the balance rework — every seat
begins with `emptyResourceBundle()` plus whatever its class's own starting bonus adds on top
(unchanged: Woodcutter +2 Wood, Miner +1 Ore, Merchant +2 Gold).

---

## 3. Tiles

```typescript
export type TileType =
  | 'Forest'   // -> Wood
  | 'Hills'    // -> Stone
  | 'Plains'   // -> Food
  | 'Mountain' // -> Ore
  | 'Desert'   // -> Gold (scarce, low yield)
  | 'River'    // "water" — no resource yield; unlocks hero boat movement; raises the troop cap
  | 'Ruins'    // "Ruins/Dungeon" — no resource; hosts a Monster Den; Watchtower-only
  | 'Volcano'  // rare; no regular resource; one-time tame cache, then becomes Ashland
  | 'Ashland'; // post-tame Volcano; weak Stone yield

/** Static lookup: base resource produced per tile type (null = no automatic yield). */
export const TILE_RESOURCE: Record<TileType, ResourceType | null> = {
  Forest: 'Wood',
  Hills: 'Stone',
  Plains: 'Food',
  Mountain: 'Ore',
  Desert: 'Gold',
  // **Troop-cap rework: was 'Food'.** River tiles produce nothing at all now — their whole value
  // moved to raising `troopCapFor(waterTileCount)` (Rules Reference §6.3b) instead. A tile that
  // both fed the economy AND was the sole route to a much bigger army made every other terrain a
  // strict downgrade the moment one River tile was available; splitting the two roles keeps the
  // choice real.
  River: null,
  Ruins: null,
  Volcano: null,
  Ashland: 'Stone',
};

export interface Tile {
  coord: HexCoord;
  type: TileType;
  ownerId: PlayerId | null;
  building: Building | null;
  /** Ruins/Dungeon only — the Monster occupying this tile's Monster Den, if undefeated. */
  monsterDenCardId: string | null;
  /** Volcano only — flips true after a successful tame; type then narrates as Ashland. */
  isTamed?: boolean;
  /** Ruins only — set once a hero has taken this dungeon's treasure (Rules Reference §5/§5.2).
   *  **New field in balance rework pass 2.** Absent/false means the hoard is still there; a
   *  LootRuins Gather flips it true and every later attempt on that hex is rejected, for the rest
   *  of the game and regardless of who owns the tile by then. Without it the Gather was infinitely
   *  repeatable — a cleared Ruins tile could be looted every turn forever, draining the whole Loot
   *  supply from one hex (an all-AI game livelocked on exactly that, burning 5,810 consecutive
   *  LootRuins actions on a single tile). Note this is independent of `monsterDenCardId`: clearing
   *  the Den and taking the hoard are two separate one-time rewards from the same tile. */
  hasBeenLooted?: boolean;
  /** **Meaning changed in the territory rework: how many Soldiers are physically standing on this
   *  tile, WHOEVER they belong to.** It is no longer safe to assume they are the tile owner's — an
   *  invading stack sits on a tile it does not own for at least a full round before the tile
   *  changes hands. Read `garrisonOwnerOf(tile)` (§3a) to find out whose they are; never infer it
   *  from `ownerId`.
   *
   *  Sources: a Barracks recruits into its own tile every round at
   *  `max(1, floor(ownedTiles / 3))` (`soldiersPerRoundFor`, territory-scaled — it was a flat +3
   *  before the rework), capped at `BARRACKS_RESERVE_CAP` = 9 and throttled to rounds where the
   *  player can afford the upkeep of the army they already have (`soldierUpkeepUnits` measured
   *  against wallet `Food + Meat * MEAT_UPKEEP_VALUE`); `DeploySoldiersAction` moves that reserve
   *  onto any tile the player owns; `MoveSoldiersAction` marches Soldiers one hex onto an adjacent
   *  tile, across borders, which is what triggers §6.3 combat. Every Soldier costs Soldier Upkeep
   *  (§6.3a) each round to whoever OWNS it, wherever it happens to be standing. */
  militiaCount?: number;
  /** **New in the territory rework.** Whose Soldiers `militiaCount` represents. `undefined` means
   *  "the tile owner's", which is the ordinary case and why most tiles never set it; it differs
   *  only while a force is standing on ground it has not (yet) claimed. Set to the invader's id on
   *  a successful march, and nulled when a tile's stack empties out.
   *
   *  This field is the whole reason `garrisonOwnerOf` exists: since the rework, a tile's
   *  **occupier** and its **owner** are genuinely separate facts, and every reader has to say which
   *  one it means. */
  garrisonOwnerId?: PlayerId | null;
  /** **New in the territory rework.** The round in which the current garrison arrived on a tile its
   *  owner does not own — i.e. the occupation clock. Ownership transfers at the start of one of the
   *  occupier's LATER turns, when `currentRound > occupationSinceRound` (see `claimHeldTerritory`
   *  in `engine/reducers.ts`), so a rival always gets a turn in between to march back and contest
   *  it. Cleared when the claim settles, and also cleared when the tile is reinforced by its actual
   *  owner. Undefined on any tile whose garrison belongs to its owner. Rules Reference §6.3. */
  occupationSinceRound?: number;
  /** Resources this tile has produced but nobody has collected yet (Rules Reference §2a), capped
   *  per resource type at TILE_STOCKPILE_CAP — 5 as of balance rework pass 2, lowered from 10 so
   *  a full tile is roughly one Level-1 hero-load rather than two. A hero standing here collects
   *  into their own carriedResources via a Gather action (§5) — production never auto-banks to
   *  the player directly. */
  stockpile: ResourceBundle;
}
```

### 3a. Whose Soldiers are standing here — **territory rework**

**Breaking semantic change.** Before the rework, `militiaCount` unambiguously belonged to
`ownerId`, and plenty of code read it that way. That assumption is now wrong: territory is taken by
**marching onto it** and then **holding it through a round**, so between the march and the claim a
tile is owned by one player and garrisoned by another. Every read of `militiaCount` must go through
one helper, exported from `engine/reducers.ts`:

```typescript
/** Whose Soldiers are standing on a tile — null when there are none. A garrison with no explicit
 *  garrisonOwnerId belongs to whoever owns the tile, which is the ordinary case. */
export function garrisonOwnerOf(tile: Tile): PlayerId | null;
```

Rules of thumb for callers:

- **"Are these my troops?"** → `garrisonOwnerOf(tile) === playerId`. Never `tile.ownerId ===
  playerId`.
- **Upkeep** (§6.3a) bills every tile where `garrisonOwnerOf(tile)` is the player, including tiles
  they do not own — troops abroad are still on the payroll.
- **`MoveSoldiers`** validates its source with `garrisonOwnerOf`, so a stack that has taken foreign
  ground can keep advancing from it, and treats a destination as contested only when
  `garrisonOwnerOf(toTile)` is some *other* player.
- **Ownership-derived state** — Victory Points, production, road connectivity — still reads
  `ownerId` / `Player.ownedTiles`, which is exactly the point: occupying a tile grants none of it
  until the claim settles.

---

## 4. Buildings

```typescript
export type BuildingType =
  | 'Sawmill'       // Forest, +1 Wood/turn (round 3+)
  | 'HuntingLodge'  // Forest, "Hunting Lodge" — +1 Food/turn, +1 XP on first hunt each round (round 5+)
  | 'Quarry'        // Hills, +1 Stone/turn (round 4+, 2 upgrade tiers — balance rework)
  | 'Farm'          // Plains, +1 Food/turn (round 4+, 2 upgrade tiers — balance rework)
  | 'Windmill'      // Plains, requires Farm — converts 2 Food into 1 Gold/turn (round 6+)
  | 'Mine'          // Mountain, +1 Ore/turn (round 3+)
  | 'Smithy'        // Mountain, crafts hero gear from Ore + Gold (round 5+)
  | 'TradePost'     // Desert, "Trade Post" — +1 Gold/turn, unlocks 2:1 bank trade (round 3+)
  | 'Dock'          // River, unlocks boat movement (round 3+); produces no resource (troop cap rework)
  | 'Watchtower'    // any owned tile — +1 per defending die (cap 6) for whoever HOLDS the tile
  | 'Barracks'      // Plains only (balance rework) — unlocks Soldier recruitment and nothing else:
                    // recruits max(1, floor(ownedTiles / 3))/round into its own tile (territory
                    // rework; was a flat +3), throttled by current-army upkeep affordability
                    // (pass 2). Grants NO attack privilege and no adjacency rule.
  | 'CowStable'     // Plains, +1 Meat/turn at tier 1, 4 upgrade tiers to +5 — balance rework
  | 'Capital';      // starting tile only — hero max HP up per tier

/** Runtime instance sitting on a specific tile. */
export interface Building {
  id: string;
  type: BuildingType;
  coord: HexCoord;
  ownerId: PlayerId;
  /** Position on this building type's upgrade track. Left **undefined until the first upgrade**
   *  and MUST be read as 1 when absent — use `tierOf(building)` rather than touching this field
   *  directly. Each UpgradeBuildingAction advances it by exactly 1, up to `maxTierFor(def)`. Only
   *  Farm/Quarry/CowStable currently define a track; Capital tier is tracked separately on
   *  `Player.capitalTier`, not here. */
  tier?: number;
}

/** Static catalog entry — one per BuildingType, not per instance. Drives Phase 5 — Build. */
export interface BuildingDefinition {
  type: BuildingType;
  allowedTileTypes: TileType[] | 'any' | 'starting-tile-only';
  cost: ResourceCost;
  requiresBuilding?: BuildingType; // e.g. Windmill requires Farm built first
  producesResource?: ResourceType; // for the tile-production loop (Rules Reference §2a)
  produceAmount?: number;          // the TIER-1 rate; higher tiers read `upgrades` below
  /** Earliest round this building may be constructed — undefined means no gate. Every production
   *  building sets one as of balance rework pass 2 (Sawmill/Mine/TradePost/Dock 3, Farm/Quarry 4,
   *  HuntingLodge/Smithy 5, Windmill 6); Barracks, CowStable, Watchtower and Capital are
   *  deliberately ungated. A resource-cost gate alone doesn't stop a turn-1 rush once a player
   *  has any income, so the tree needs its own staging. Rules Reference §7.1b. */
  minRound?: number;
  /** Ordered list of the tiers ABOVE tier 1, each bought by one UpgradeBuildingAction:
   *  `upgrades[0]` takes the building from tier 1 to tier 2, `upgrades[1]` from 2 to 3, and so on
   *  — a definition with 4 entries tops out at tier 5. Farm/Quarry/CowStable define this for
   *  resource production; Watchtower/Barracks (balance rework pass 4) also define it for their
   *  own non-resource per-tier effects (defense bonus, reserve cap — see WATCHTOWER_TIERS/
   *  BARRACKS_TIERS in `engine/constants.ts`, the actual source of truth for those, keyed by the
   *  same `Building.tier` this array's index advances) — which is why `produceAmount` below is
   *  optional rather than required: present for the resource-producing trio, omitted for the
   *  other two. Balance rework pass 2 replaced a single `upgrade?: { cost, produceAmount }`
   *  object with this array. */
  upgrades?: { cost: ResourceCost; produceAmount?: number }[];
  effectDescription: string;
}
```

### 4a. Reading a building's tier — **balance rework pass 2**

**Breaking schema change.** `BuildingDefinition.upgrade` — a single optional
`{ cost, produceAmount }` object describing the one step from tier 1 to tier 2 — is **gone**,
replaced by `BuildingDefinition.upgrades`, an ordered **array** of every tier above 1. The field is
renamed, not merely retyped, so any reader still looking for `.upgrade` gets `undefined` rather than
a type error. Two invariants come with it:

- `upgrades` is **0-based over tiers starting at 2**: `upgrades[0]` takes a building from tier 1 to
  tier 2, `upgrades[1]` from 2 to 3, and so on. A definition with 4 entries tops out at tier 5.
- `Building.tier` is **undefined until the first upgrade** and must be read as **1** when absent. It
  is never written at construction time.

Because that arithmetic is easy to get subtly wrong in either direction, it lives in exactly four
selectors, exported from `@/engine`. Reducers, AI, and UI all go through these — **no caller should
index `upgrades` directly or compare `building.tier` against a raw number:**

```typescript
/** Highest tier this building type can reach: 1 if it has no track, else 1 + upgrades.length. */
export function maxTierFor(def: BuildingDefinition): number;

/** Current tier of a placed building, normalizing the undefined-means-1 convention. */
export function tierOf(building: { tier?: number }): number;

/** What this building yields per round at `tier`. Tier 1 returns the base `produceAmount`;
 *  higher tiers read the matching `upgrades` entry. Clamped, so an out-of-range tier can't
 *  return undefined and poison production arithmetic with NaN. */
export function produceAmountForTier(def: BuildingDefinition, tier: number): number;

/** The upgrade entry that would take a building from `currentTier` to the next one, or null
 *  when it is already maxed (or was never upgradable). Null is the canonical "no further
 *  upgrade" signal — both the reducer's validation and the UI's affordance check read it. */
export function nextUpgradeFor(
  def: BuildingDefinition,
  currentTier: number,
): { cost: ResourceCost; produceAmount: number } | null;
```

Current tracks (Rules Reference §7.1a): Quarry and Farm each carry 2 entries and max at tier 3
(+3/turn); CowStable carries 4 and maxes at tier 5, climbing +1 → +5 Meat/turn.

---

## 5. Classes

Drawn randomly at game start; each grants a starting-tile bonus.

```typescript
export type ClassName =
  | 'Woodcutter'
  | 'Miner'
  | 'Farmer'
  | 'Warrior'
  | 'Mage'
  | 'Merchant'
  | 'Rogue';

/** Discriminated union so each class's bonus is structurally typed, not free text. */
export type ClassStartingBonus =
  | { kind: 'Woodcutter'; prebuiltBuilding: 'Sawmill'; forestWoodBonusPerTile: number }
  | { kind: 'Miner'; startingOreBonus: number; startingTileBiasedNear: ('Hills' | 'Mountain')[] }
  | { kind: 'Farmer'; foodPerTurnBonus: number; heroMaxHpBonus: number }
  // startingWeaponAttackBonus is added to HeroState.attack once at spawn (base 1 -> 3, see Rules
  // Reference §1.4/§1.3). extraCombatDie means Fight-phase rolls (Rules Reference §6.1/§6.2 only,
  // NOT the per-unit §6.3 army dice) use 2d6-keep-highest instead of 1d6.
  | { kind: 'Warrior'; startingWeaponAttackBonus: number; extraCombatDie: true }
  | { kind: 'Mage'; buildingCostReduction: number; hasRangedAttackBeforeMelee: true }
  | { kind: 'Merchant'; bankTradeRatio: readonly [number, number]; startingGoldBonus: number }
  | { kind: 'Rogue'; passesThroughUnownedOrRivalTiles: true; stealsPerRound: number };

export interface ClassDefinition {
  id: ClassName;
  name: ClassName;
  startingBonus: ClassStartingBonus;
}
```

---

## 6. Loot, curses, and monsters

```typescript
export type LootRarity = 'Common' | 'Uncommon' | 'Rare' | 'Legendary';

/** Flat combat bonus tiers: +1 / +2 / +3 / +5, plus occasional special ability. */
export const LOOT_RARITY_BONUS: Record<LootRarity, 1 | 2 | 3 | 5> = {
  Common: 1,
  Uncommon: 2,
  Rare: 3,
  Legendary: 5,
};

export interface LootCard {
  id: string;
  name: string;
  rarity: LootRarity;
  combatBonus: 1 | 2 | 3 | 5;
  specialAbility?: string;
  /** Structured form of the one "occasional special ability" that Rules Reference §4.1's movement
   *  formula names explicitly (`loot.movementBonus`). A handful of cards grant it; most leave it
   *  undefined and carry their ability as flavor text in `specialAbility` above. */
  movementBonus?: number;
}

/** Drawn on a lost Hero vs Monster roll. */
export interface BadStuffCard {
  id: string;
  name: string;
  effectDescription: string;
  hpDamage?: number;
}

export interface MonsterCard {
  id: string;
  name: string;
  level: number;
  specialAbility?: string;
  /** Rarity tier of the LootCard draw a winning hero receives. */
  lootRarityOnWin: LootRarity;
}
```

---

## 6a. The Door deck — **Munchkin exploration layer**

The engine-complete piece of the "walk somewhere new and something's behind the door" system —
Rules Reference §6.4 has the full player-facing rules (the trigger, why it's one combined deck, the
three outcomes, the mandatory-fight exemption, and how it interacts with a Ruins Den's own guaranteed
Monster Den). This section is just the shapes.

```typescript
/** A small, closed set of effect shapes — deliberately not open-ended, so N flavorful Utility
 *  cards (`engine/catalogs.ts`) can share a handful of reducer branches (`applyUtilityEffect` in
 *  `engine/reducers.ts`) instead of each needing bespoke logic. `'FreeTreasure'` is Munchkin's
 *  "it's a small treasure, no fight" card (draws 1 Common Loot card, no combat); `'Nothing'` is a
 *  pure flavor whiff ("the door was stuck") so not every draw is mechanically loaded. */
export type UtilityEffectKind =
  | 'GainWood'
  | 'GainStone'
  | 'GainFood'
  | 'GainOre'
  | 'GainMeat'
  | 'GainGold'
  | 'HealHp'
  | 'DamageHp'
  | 'GainXp'
  | 'FreeTreasure'
  | 'Nothing';

export interface UtilityCard {
  id: string;
  name: string;
  flavor: string;
  effectKind: UtilityEffectKind;
  /** Meaning depends on effectKind: resource/HP/XP amount. Unused (undefined) for FreeTreasure and
   *  Nothing. */
  amount?: number;
}

/** One shuffled Door deck mixes both outcomes — most of it is Monster cards (fight, using the same
 *  `MonsterCard` shape and dice math a Ruins Den fight uses), the rest is smaller non-combat
 *  Utility swings — exactly like the physical Munchkin game shuffles monsters and non-monster cards
 *  into a single Door pile rather than dealing from two separate decks. */
export type DoorCard = { kind: 'Monster'; monster: MonsterCard } | { kind: 'Utility'; utility: UtilityCard };

export interface DoorDeckState {
  drawPile: DoorCard[];
  discardPile: DoorCard[];
}
```

Unlike `LootDeckState` (§10a), the Door deck **recirculates**: a resolved card — fought (win or
lose) or an immediately-resolved Utility — returns to `discardPile` rather than being kept, so
genuine exhaustion (both piles momentarily empty at the instant of a draw) should be rare. `drawDoor`
(`engine/decks.ts`) still returns `card: DoorCard | null` defensively, matching `drawLoot`'s contract,
since "no encounter" is a legal (if unlikely) outcome of arriving somewhere new.

---

## 7. Hero

```typescript
export interface HeroState {
  id: string;
  ownerId: PlayerId;
  isSecondHero: boolean; // Capital (Town) upgrade unlock, tier 4 + 10 VP — Rules Reference §7.3
  level: number; // 1-10
  /** Reaching 0 means two different things depending on what the hero was fighting when it happened
   *  — Rules Reference §6.1a/§6.3c. Everywhere except Army vs Territory combat (a lost Monster fight,
   *  a Bad Stuff card, a Door `DamageHp` effect) it's the "downed" rule: retreat to the Capital, heal
   *  to full, nothing else changes. Losing a hero's own pairing in Army vs Territory combat
   *  (`MoveSoldiersAction.heroJoins`, below) is permanent instead — the hero slot is replaced by a
   *  freshly-spawned Level 1 hero (`freshHeroState` in `engine/selectors.ts`) carrying none of this
   *  hero's level/XP/gear/Loot/curses, only the player's own class and Town-tier bonuses. Which rule
   *  applies is decided entirely by which combat the hero was in, never by anything stored here. */
  hp: number;
  maxHp: number;
  /** Base Attack stat: 1 at spawn (Rules Reference §1.4), plus any permanent class bonus
   *  (e.g. Warrior's startingWeaponAttackBonus). Feeds directly into every Fight-phase roll
   *  in §6.1/§6.2 alongside level and equipped-Loot gearBonus — distinct from gear. */
  attack: number;
  xp: number;
  /** current Level * 3, cumulative — recomputed, not stored authoritatively. */
  xpToNextLevel: number;
  position: HexCoord;
  movementRange: number;
  canBoat: boolean; // unlocked via a built Dock
  inventory: LootCard[];
  equippedLootIds: string[];
  activeCurses: BadStuffCard[];
  /** Resources physically gathered (Rules Reference §5) or stolen, capped by carry capacity
   *  (§5.1: 4 + level, across all six resource types combined). Spendable on a
   *  Build/UpgradeBuilding/Capital-upgrade action targeting the hero's own current tile;
   *  otherwise must be deposited at the Capital first (§7.6). Deploying Soldiers has no cost
   *  and never draws from this. */
  carriedResources: ResourceBundle;
  /** **Munchkin exploration layer.** Every `HexKey` this hero has ever stood on, seeded at spawn
   *  with its own starting tile (spawning there does not itself count as a fresh arrival). The
   *  FIRST time it grows to include a given key — the hero's move ending somewhere new — triggers
   *  a Door card draw (`resolveDoorCardIfNewTile` in `engine/reducers.ts`; Rules Reference §6.4). */
  visitedTiles: HexKey[];
}
```

---

## 8. Player

```typescript
export type PlayerId = string;

export interface Player {
  id: PlayerId;
  name: string;
  color: string;
  classId: ClassName;
  resources: ResourceBundle;
  ownedTiles: HexCoord[];
  capitalTile: HexCoord;
  /** The Town's current tier, 1-5. **Territory rework: 5 tiers, was 2.** Starts at `1` for every
   *  player — tier 1 is granted free at spawn, not purchased (`setup.ts`'s `buildStartingPlayer`) —
   *  and climbs one tier per `'Build'` action with `buildingType: 'Capital'`, indexing
   *  `CAPITAL_TIERS[capitalTier]` for the next tier's cost/effect. Rules Reference §7.3. */
  capitalTier: number;
  hero: HeroState;
  victoryPoints: number;
  isEliminated: boolean;
  /** [give, receive] — default [4,1]; [2,1] via Trade Post; [3,1] via Merchant class. */
  bankTradeRatio: readonly [number, number];
}
```

---

## 9. Turn / phase structure

```typescript
/** Numeric values match the canonical phase numbers 0-5. */
export enum Phase {
  Production = 0,
  DrawAndPlaceTile = 1,
  MoveHero = 2,
  Gather = 3,
  Fight = 4,
  Build = 5,
}

/** Verbatim canon labels, for UI/log display only — never branch logic on these strings. */
export const PHASE_LABEL: Record<Phase, string> = {
  [Phase.Production]: 'Phase 0 — Production',
  [Phase.DrawAndPlaceTile]: 'Phase 1 — Draw & Place Tile',
  [Phase.MoveHero]: 'Phase 2 — Move Hero',
  [Phase.Gather]: 'Phase 3 — Gather',
  [Phase.Fight]: 'Phase 4 — Fight',
  [Phase.Build]: 'Phase 5 — Build',
};
```

---

## 10. Decks, event log, and full GameState

```typescript
export interface TileDeckState {
  drawPile: TileType[];
  discardPile: TileType[];
}

export interface MonsterDeckState {
  drawPile: MonsterCard[];
  discardPile: MonsterCard[];
}

/** Per-rarity piles. Unlike the other three decks this one does not recirculate: a drawn Loot card
 *  is kept by its hero permanently and no rule ever returns it, so `discardPiles` stays empty in
 *  practice and a rarity's `drawPiles` entry is a hard finite budget for the whole game. See the
 *  exhaustion note under this block. */
export interface LootDeckState {
  drawPiles: Record<LootRarity, LootCard[]>;
  discardPiles: Record<LootRarity, LootCard[]>;
}

export interface BadStuffDeckState {
  drawPile: BadStuffCard[];
  discardPile: BadStuffCard[];
}

/** Append-only record of everything that happened; the source of truth for replay. */
export interface GameEvent {
  id: string;
  round: number;
  phase: Phase;
  actorId: PlayerId | 'system';
  type: string; // e.g. 'TilePlaced' | 'ProductionResolved' | 'CombatResolved' | 'HeroLeveledUp'
  payload: Record<string, unknown>;
  /** Logical sequence tick, not wall-clock time — see replay note below. */
  seq: number;
}

export type GameMode = 'realtime' | 'async' | 'hotseat';

/** [DEFAULT — balance rework pass 4] 'CapitalConquest' added: the instant ANY rival's Capital
 *  tile's occupation claim settles in a player's favor, that player wins immediately — checked
 *  and set at the moment of settlement (`engine/reducers.ts`'s `claimHeldTerritory`), not at
 *  round end like the other three, and exempt from `WIN_MIN_ROUND`. Supersedes the old
 *  eliminate-all-rivals Domination trigger outright — see Rules Reference §11. */
export type WinCondition = 'VictoryPoints' | 'Domination' | 'HeroLevelRace' | 'CapitalConquest';

export interface GameState {
  gameId: string;
  mode: GameMode;
  /** Seeds all deck shuffles and dice rolls so any transport can reproduce results. */
  rngSeed: string;
  roundNumber: number;
  turnOrder: PlayerId[];
  currentPlayerId: PlayerId;
  currentPhase: Phase;
  map: Record<HexKey, Tile>;
  /** **New in the territory rework.** Road segments, keyed by the EDGE between two adjacent hexes
   *  (`edgeKey`, §1) and valued by the player who paid for it. One road per edge, ever, owned by
   *  exactly one player — the key's canonical ordering is what makes "this border already has a
   *  road" a single lookup from either side. Roads are the supply network: any owned tile joined to
   *  its owner's Capital by an unbroken chain of that player's roads has its stockpile collected
   *  straight into the wallet each round (`collectRoadConnectedTiles` in `engine/reducers.ts`,
   *  emitting a `RoadSupplyCollected` event) instead of needing a hero to walk there and haul it
   *  home. Rules Reference §7.7. */
  roads: Record<EdgeKey, PlayerId>;
  players: Player[];
  tileDeck: TileDeckState;
  monsterDeck: MonsterDeckState;
  lootDeck: LootDeckState; // the Treasure deck, doing double duty — see LootCard's doc comment (§6)
  badStuffDeck: BadStuffDeckState;
  /** **Munchkin exploration layer.** One shuffled deck mixing Monster and Utility outcomes — see
   *  `DoorCard`'s doc comment (§6a) for why it's a single combined deck rather than two separately
   *  drawn ones. Rules Reference §6.4. */
  doorDeck: DoorDeckState;
  /** **Munchkin exploration layer.** A Door card came up Monster and hasn't been fought yet. Set by
   *  `applyMoveHero` the instant a hero first sets foot on a tile; `applyAdvancePhase` refuses to
   *  leave Phase 4 (Fight) while this is non-null for the hero it names, and `EndTurn`/`AdvancePhase`
   *  both refuse to end the turn at all while it's pending (`requireNoPendingDoorMonster`) — the
   *  Munchkin rule that you can't just walk away from what's behind the door. Cleared by the
   *  matching `Fight` action, win or lose alike (losing doesn't mean it's still there). Keyed by
   *  `heroId` so two heroes (post Town-tier-4) can't collide if both somehow had one pending at once,
   *  even though only one hero moves per turn in practice. Rules Reference §6.4. */
  pendingDoorMonster: { heroId: string; coord: HexCoord; monsterCardId: string } | null;
  eventLog: GameEvent[];
  winnerId: PlayerId | null;
  winCondition: WinCondition | null;
}
```

### 10a. Loot exhaustion is part of the draw contract — **balance rework pass 2**

Because a Loot rarity can genuinely run dry (see the note on `LootDeckState` above), `drawLoot`
returns `card: LootCard | null` rather than `card: LootCard`, and **every caller must handle the
null:**

```typescript
export function drawLoot(
  deck: LootDeckState,
  rarity: LootRarity,
  rng: RngStream,
): { card: LootCard | null; deck: LootDeckState };
```

All call sites — a Monster win, a Loot Ruins Gather, a Volcano tame, and (as of the Munchkin
exploration layer, §6a) a won Door monster fight or a drawn `FreeTreasure` Utility card — resolve
**normally but empty-handed** when the card is null: the XP, the cleared Den, the consumed Gather, the
tamed tile and its 5 Gold, the resolved Door card, all still happen, and the event is logged with a
null card id. It previously destructured an empty array and handed back `undefined` typed as
`LootCard`, so the first draw past exhaustion crashed with a `TypeError` deep inside a reducer instead
of failing as a rule. Modeling exhaustion in the return type is what keeps that honest. The catalog in
`engine/catalogs.ts` was roughly doubled in balance rework pass 2 (31 cards, up from 17), then expanded
again to carry the Door deck's added draw volume — it now totals **60 cards** (21 Common, 16 Uncommon,
13 Rare, 10 Legendary) — so running out stays a rare late-game event rather than the norm. Rules
Reference §5.3/§6.4.

### 10b. Road connectivity — **territory rework**

Two read-only selectors in `engine/selectors.ts` are the only sanctioned way to ask questions about
`GameState.roads`:

```typescript
/** Is there a road belonging to `playerId` on the edge between these two adjacent hexes? */
export function hasRoadBetween(
  state: GameState,
  playerId: PlayerId,
  a: HexCoord,
  b: HexCoord,
): boolean;

/** Every tile the player has joined to their Capital by an unbroken chain of their OWN roads,
 *  travelling only over tiles they own. */
export function roadConnectedTiles(state: GameState, player: Player): Set<HexKey>;
```

`roadConnectedTiles` is a breadth-first walk outward from `player.capitalTile`, and three properties
of it are load-bearing rather than incidental — implementations and UI both depend on them:

- **The Capital is the anchor, not a member.** The walk *seeds* its visited set with the Capital but
  never adds it to the returned set. Including it would give every player automatic income on their
  starting tile before they had built anything.
- **Traversal refuses to enter a tile the player does not own.** A supply line cannot run through
  neutral or rival ground, so a road out to an unclaimed frontier hex pays nothing until that hex is
  claimed.
- **It is a connectivity query, not a cache.** Losing a mid-chain tile — to an occupation settling
  under §6.3 — silently drops every tile behind it out of the set on the next call, and a captured
  Capital returns the empty set outright.

Rules Reference §7.7 states the same three points as player-facing rules.

---

## 11. Actions

One discriminated union, covering every player action across all six phases, suitable for a
single `(state, action) => state` reducer. `Phase 0 — Production` has no player action — it
resolves automatically when a turn's `AdvancePhaseAction` enters that phase, appending a
`ProductionResolved` `GameEvent` for every owned tile with a resource-producing building.

```typescript
interface BaseAction {
  actorId: PlayerId;
  /** Accepted but currently always resolves to the player's one hero — see selectors.ts's
   *  resolveHero. A holdover from a removed second-hero feature; harmless to keep. */
  heroId?: string;
}

// --- Phase 1 — Draw & Place Tile -------------------------------------------------

export interface DrawTileAction extends BaseAction {
  type: 'DrawTile';
}

export interface PlaceTileAction extends BaseAction {
  type: 'PlaceTile';
  /** The tile type drawn this phase (echoed back for a pure/replayable reducer). */
  tileType: TileType;
  /** Must touch at least one tile the actor owns and be currently unoccupied. */
  coord: HexCoord;
}

// --- Phase 2 — Move Hero -----------------------------------------------------------

export interface MoveHeroAction extends BaseAction {
  type: 'MoveHero';
  /** Ordered steps; total length bounded by hero movementRange (or a River chain if viaBoat).
   *  One MoveHero action per turn — it must cover the whole move, not one step at a time
   *  (Rules Reference §4.1). */
  path: HexCoord[];
  viaBoat?: boolean;
}

// --- Phase 3 — Gather ----------------------------------------------------------------

export type GatherKind =
  | 'CollectResources' // own tile with a non-empty stockpile — collect into carriedResources
  | 'Forage'      // Forest/Plains/Hills/Mountain/Desert tile NOT owned by the active player
  | 'LootRuins'   // Ruins/Dungeon tile, Monster Den already cleared and Tile.hasBeenLooted unset —
                  // once per tile for the whole game (balance rework pass 2)
  | 'Hunt'        // own Forest tile with a built Hunting Lodge
  | 'RogueSteal'; // Rogue class only — steal 1 resource from an adjacent rival-owned tile

export interface GatherAction extends BaseAction {
  type: 'Gather';
  /** Must equal the acting hero's current position. */
  coord: HexCoord;
  gatherKind: GatherKind;
}

// --- Phase 4 — Fight -------------------------------------------------------------------

export interface FightMonsterAction extends BaseAction {
  type: 'Fight';
  combatType: 'HeroVsMonster';
  coord: HexCoord; // Ruins/Dungeon tile hosting the Monster Den
  monsterCardId: string;
}

export interface FightHeroAction extends BaseAction {
  type: 'Fight';
  combatType: 'HeroVsHero'; // PvP duel or backstab
  targetPlayerId: PlayerId;
  targetHeroId: string;
  isBackstab: boolean;
}

/** REMOVED in the territory rework — `FightTerritoryAction` (`combatType: 'ArmyVsTerritory'`,
 *  carrying fromCoord/targetCoord/attackingUnits) is **deleted from the union**, not deprecated in
 *  place, so nothing can keep dispatching the old shape and have it type-check. Territory combat is
 *  no longer a Phase-4 declared attack launched from a Barracks; it happens when Soldiers march
 *  onto occupied ground — see MoveSoldiersAction below. The dice math is untouched and still lives
 *  in `resolveArmyVsTerritory` (`engine/combat.ts`); only the trigger moved. */

export interface TameVolcanoAction extends BaseAction {
  type: 'Fight';
  combatType: 'TameVolcano'; // high-difficulty fight; success converts tile to Ashland
  coord: HexCoord;
}

export type FightAction =
  | FightMonsterAction
  | FightHeroAction
  | TameVolcanoAction;

// --- Phase 5 — Build ---------------------------------------------------------------------

export interface BuildBuildingAction extends BaseAction {
  type: 'Build';
  buildingType: BuildingType;
  coord: HexCoord;
}

export interface LevelUpHeroAction extends BaseAction {
  type: 'LevelUpHero';
}

/** Balance rework, supersedes the old BuyMilitiaAction: Soldiers are no longer purchased — a
 *  Barracks produces them passively (BuildingDefinition doesn't model this directly; see the
 *  Barracks entry in Rules Reference §7.1/§6.3) into a reserve sitting at that tile. This action
 *  reassigns count from that reserve onto the Barracks tile itself or ONE adjacent owned tile
 *  (fromCoord === toCoord is a harmless no-op "leave them at the Barracks"). Gated to Phase 5 like
 *  the old BuyMilitiaAction but — same reasoning as before — does NOT count against the
 *  one-Build-action-per-turn limit (§7): redeploying a standing army shouldn't cost you your one
 *  construction/level-up for the turn.
 *
 *  **[BUG FIX — direct report] Not "any owned tile" any more — Soldiers do not teleport.** `toCoord`
 *  must now be `fromCoord` itself or `isAdjacent(fromCoord, toCoord)`, the same physical reach
 *  `MoveSoldiersAction` has; reaching further takes one or more follow-up `MoveSoldiers` marches.
 *  `fromCoord`'s *garrison* must be the actor's (`garrisonOwnerOf`, §3a), not merely its `ownerId` —
 *  an occupied Barracks still recruits, and those recruits belong to the occupier, not the tile's
 *  nominal owner. And unless `toCoord === fromCoord`, the same `MIN_SOLDIERS_LEFT_BEHIND` (= 1) floor
 *  `MoveSoldiersAction` enforces applies here too: the Barracks reserve can never be marched down to
 *  zero by a Deploy any more than a garrison can by a March. Rules Reference §6.3, "Deploy
 *  Soldiers." */
export interface DeploySoldiersAction extends BaseAction {
  type: 'DeploySoldiers';
  fromCoord: HexCoord; // an owned tile with a Barracks whose GARRISON is the actor's, reserve >= count
  toCoord: HexCoord; // fromCoord itself, or one adjacent tile the actor owns
  count: number;
}

/** **New in the territory rework, and now the ONLY way territory changes hands.** Marches `count`
 *  Soldiers one hex onto an ADJACENT placed tile. There is no ranged "attack that tile" action and
 *  no Barracks-adjacency rule: a Barracks exists purely to unlock recruitment, and an army takes
 *  ground the way an army actually does — by walking onto it and staying.
 *
 *  `fromCoord` must be a tile whose garrison is the actor's (`garrisonOwnerOf`, §3a) — NOT merely a
 *  tile they own — so a force standing on captured ground can keep advancing. `count` must leave at
 *  least `MIN_SOLDIERS_LEFT_BEHIND` (= 1) Soldier standing on `fromCoord` — a tile can never be
 *  marched down to zero in one action (Risk's classic "always leave a garrison" rule; `constants.ts`).
 *  Three outcomes, decided by what is already on the destination (see `applyMoveSoldiers` in
 *  `engine/reducers.ts`):
 *
 *    - Destination friendly (yours, or holding your Soldiers)  -> plain reinforcement.
 *    - Destination hostile/neutral and UNDEFENDED              -> you occupy it; `garrisonOwnerId`
 *                                                                becomes yours and
 *                                                                `occupationSinceRound` starts.
 *    - Destination defended by another player                  -> `resolveArmyVsTerritory` resolves
 *                                                                immediately. Winner holds the
 *                                                                tile; a repulsed attacker's
 *                                                                survivors fall back to fromCoord.
 *
 *  Ownership never transfers here — only occupation. `claimHeldTerritory` settles it at the start of
 *  a later turn (§3's `occupationSinceRound`). Phase 5, and a FREE action: it does not consume the
 *  one-Build-per-turn slot, and no per-turn cap is applied, so a border can be reinforced and probed
 *  in the same turn. Rules Reference §6.3.
 *
 *  **[DEFAULT — hero battle participation] `heroId`/`heroJoins`: a hero can lend this side's fight
 *  one extra die**, without a separate action. `heroJoins: true` has the named hero (or the player's
 *  primary hero, `resolveHero`'s usual default, if `heroId` is omitted) join the roll-off — but only
 *  if that hero is physically standing on `fromCoord` when this action is submitted, or the action is
 *  rejected outright. Ignored on an uncontested move (nothing to fight). A DEFENDING hero needs
 *  neither field: it joins automatically just by standing on `toCoord` when the march lands, checked
 *  directly against `player.hero.position`. Either way this action never writes the hero's own
 *  `position` — winning, losing, or never getting a pairing all leave it exactly where it was; only
 *  `MoveHeroAction` (Rules Reference §4) ever relocates a hero.
 *
 *  `resolveArmyVsTerritory` (`engine/combat.ts`) folds the joining hero's roll (`rollHeroAttack` — the
 *  same formula every other Fight-phase action uses, Rules Reference §6.1) into that side's sorted
 *  dice as one extra, uncounted entry, and reports the result as `attacker/defenderHeroOutcome`
 *  (`'won' | 'lost' | null`) and `attacker/defenderHeroDamage`, both spread into this action's own
 *  `CombatResolved` event alongside the troop outcome. A win grants `HERO_BATTLE_XP_ON_WIN` flat XP; a
 *  loss subtracts the reported `*HeroDamage` from the hero's `hp` and logs a `HeroDamaged` event — and
 *  if that brings `hp` to 0 or below, `respawnHeroFromDeath` replaces the hero in-slot with a fresh
 *  Level 1 hero and logs a `HeroDied` event, per `HeroState.hp`'s own doc comment above. Rules
 *  Reference §6.3c. */
export interface MoveSoldiersAction extends BaseAction {
  type: 'MoveSoldiers';
  fromCoord: HexCoord; // a tile holding YOUR Soldiers (garrisonOwnerOf === actorId)
  toCoord: HexCoord;   // an adjacent placed tile — anyone's, or nobody's
  count: number;
  /** [DEFAULT — hero battle participation] Which hero joins, if `heroJoins` is true — defaults to the
   *  player's primary hero (`resolveHero`'s convention) when omitted. Irrelevant if `heroJoins` isn't
   *  set. */
  heroId?: string;
  /** [DEFAULT — hero battle participation] true = the hero named by `heroId` (or the primary hero)
   *  lends this side's attack one extra die — see this interface's own doc comment above. */
  heroJoins?: boolean;
}

/** **New in the territory rework.** Lays one road segment along the edge between two adjacent
 *  hexes, for `ROAD_COST` (1 Wood). Both ends must be placed tiles, at least one must be owned by
 *  the actor, and the edge (`edgeKey(from, to)`, §1) must not already carry a road — one road per
 *  border, ever, owned by one player.
 *
 *  A free action AND not phase-gated at all (unlike DeploySoldiers/MoveSoldiers, which are Phase 5):
 *  a road is cheap infrastructure, and making it compete with constructing a building would mean
 *  nobody ever builds the supply network the economy is designed around. Payment follows the usual
 *  two-pool rule with the hero's position tested against BOTH endpoints. Rules Reference §7.7. */
export interface BuildRoadAction extends BaseAction {
  type: 'BuildRoad';
  from: HexCoord;
  to: HexCoord;
}

/** Balance rework; generalized in pass 2. Spends the cost of the NEXT entry in the building's
 *  upgrade track (`nextUpgradeFor(def, tierOf(building))`) to advance it exactly one tier, raising
 *  its produce rate — only Farm/Quarry/CowStable currently define a track, and CowStable's runs all
 *  the way to tier 5, so four separate actions across four turns. Rejected when the building is
 *  already at `maxTierFor(def)` (i.e. `nextUpgradeFor` returns null). DOES count against the
 *  one-Build-action-per-turn limit (§7): it's a construction-scale investment, not a free action
 *  like DeploySoldiers above. Not subject to `minRound` — that gates first construction only. */
export interface UpgradeBuildingAction extends BaseAction {
  type: 'UpgradeBuilding';
  coord: HexCoord; // owned tile with an upgradable building, not already at max tier
}

/** [DEFAULT — balance rework pass 4, new mechanic] Spends `SMITHY_CRAFT_COSTS[rarity]`
 *  (`engine/constants.ts`) — Ore + Gold, scaled steeply by rarity — to draw ONE guaranteed-rarity
 *  LootCard from the shared `lootDeck`, subject to the same §5.3/§9 exhaustion contract every
 *  other draw site follows (a genuinely empty rarity still spends the resources but resolves
 *  empty-handed, never throws). The hero must be standing on their own tile with a built Smithy.
 *  Phase 5, free — like DeploySoldiers/MoveSoldiers/BuildRoad, does NOT consume the turn's one
 *  Build slot, so it can repeat every turn the wallet allows. Rules Reference §7.1c. */
export interface CraftGearAction extends BaseAction {
  type: 'CraftGear';
  coord: HexCoord;
  rarity: LootRarity;
}

/** [DEFAULT — balance rework pass 4, new mechanic, direct request: "treasure/equipment has a
 *  gold value like in Munchkin which can be sold for additional troops"] CraftGearAction's
 *  inverse: sells one owned Loot card (equipped or not — an equipped card is unequipped as part
 *  of the sale) for `LOOT_SELL_TROOPS[rarity]` Soldiers, granted straight into an owned
 *  Barracks's reserve — "higher level equip = more troops." The hero must be standing on that
 *  Barracks tile; the grant is clamped by the Barracks's own tier reserve cap and the player's
 *  overall `troopCapFor` the same way ordinary recruitment is, and rejected outright (not
 *  silently truncated) if there's no room for even one Soldier. Phase 5, free. Rules Reference
 *  §7.1c. */
export interface SellLootAction extends BaseAction {
  type: 'SellLoot';
  lootCardId: string;
  coord: HexCoord;
}

export interface EquipLootAction extends BaseAction {
  type: 'EquipLoot';
  lootCardId: string;
}

export interface UnequipLootAction extends BaseAction {
  type: 'UnequipLoot';
  lootCardId: string;
}

// --- Cross-phase / auxiliary --------------------------------------------------------------

export interface TradeWithBankAction extends BaseAction {
  type: 'TradeWithBank';
  give: ResourceType;
  giveAmount: number; // typically player's bankTradeRatio[0]
  receive: ResourceType;
}

/** Free action, like Equip/Unequip (Rules Reference §7.6). Requires the acting hero to be
 *  standing on the player's Capital tile. Moves everything the hero is carrying into the
 *  player's wallet (`Player.resources`), clearing `HeroState.carriedResources` to zero. */
export interface DepositResourcesAction extends BaseAction {
  type: 'DepositResources';
}

export interface AdvancePhaseAction extends BaseAction {
  type: 'AdvancePhase';
}

export interface EndTurnAction extends BaseAction {
  type: 'EndTurn';
}

// --- The union -----------------------------------------------------------------------------

export type Action =
  | DrawTileAction
  | PlaceTileAction
  | MoveHeroAction
  | GatherAction
  | FightAction
  | BuildBuildingAction
  | LevelUpHeroAction
  | DeploySoldiersAction
  | MoveSoldiersAction
  | UpgradeBuildingAction
  | BuildRoadAction
  | CraftGearAction
  | SellLootAction
  | EquipLootAction
  | UnequipLootAction
  | TradeWithBankAction
  | DepositResourcesAction
  | AdvancePhaseAction
  | EndTurnAction;

export type Reducer = (state: GameState, action: Action) => GameState;
```

---

## Replay parity across Realtime, Async, and Hotseat modes

`GameState` and `Action` are the entire contract. The reducer (`Reducer` above) is a pure
function — `rngSeed` plus the ordered `eventLog`/action stream fully determine all deck draws,
dice rolls, and combat outcomes, so identical `(state, action)` pairs always yield an identical
next state regardless of who dispatched the action or when.

- **Realtime synchronous**: a server holds the canonical `GameState`, runs every dispatched
  `Action` through the same reducer, and pushes the resulting diff/event to all connected clients
  over a WebSocket-style channel. `mode: 'realtime'`.
- **Async turn-based**: the same server-authoritative reducer runs on receipt of each `Action`,
  but delivery is a queued/notified request-response instead of a live push; players are pinged
  when `currentPlayerId` becomes theirs. `mode: 'async'`.
- **Local hotseat**: no backend — the identical reducer module runs client-side in the browser,
  fed actions from whichever player is "at the keyboard." `mode: 'hotseat'`.

Because `mode` is only a field on `GameState` (a transport/config choice) and never branches the
reducer's rules logic, a game can in principle be exported from one mode and replayed exactly in
another by re-dispatching its `eventLog` in order against a fresh reducer instance seeded with the
same `rngSeed`.
