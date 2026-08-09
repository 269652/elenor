/**
 * HexRealms engine — canonical types.
 *
 * Mirrors docs/data-model.md verbatim (that doc is the source of truth for this file's
 * shape). This module has ZERO imports from React, Next.js, or any DB/network client —
 * see docs/architecture.md §3 "One Engine, Three Modes." Keep it that way.
 */

// ── 1. Coordinates ──────────────────────────────────────────────────────────────────────

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

/** [DEFAULT — roads] Stable key for the EDGE between two adjacent hexes, always
 *  "q1,r1|q2,r2" with the two endpoints in canonical (sorted) order so the same border yields
 *  the same key regardless of which side you name first. Roads live on edges, not tiles — see
 *  GameState.roads. */
export type EdgeKey = string;

export function edgeKey(a: HexCoord, b: HexCoord): EdgeKey {
  const ka = hexKey(a);
  const kb = hexKey(b);
  return ka <= kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

// ── 2. Resources ─────────────────────────────────────────────────────────────────────────

/** Six resources, per canon. Meat added in the [DEFAULT — balance rework] pass: it's the
 *  Cow Stable's product and the cheaper of the two Soldier-upkeep currencies (see
 *  constants.ts's MEAT_UPKEEP_VALUE) — everything else in the file still just iterates
 *  RESOURCE_TYPES, so adding it here was the one place that mattered. */
export type ResourceType = 'Wood' | 'Stone' | 'Food' | 'Ore' | 'Meat' | 'Gold';

export const RESOURCE_TYPES: ResourceType[] = ['Wood', 'Stone', 'Food', 'Ore', 'Meat', 'Gold'];

/** A full accounting of a player's stockpile — always has all six keys. */
export type ResourceBundle = Record<ResourceType, number>;

/** A cost or partial delta, e.g. Windmill's "2 Stone + 2 Wood". */
export type ResourceCost = Partial<Record<ResourceType, number>>;

export function emptyResourceBundle(): ResourceBundle {
  return { Wood: 0, Stone: 0, Food: 0, Ore: 0, Meat: 0, Gold: 0 };
}

// ── 3. Tiles ─────────────────────────────────────────────────────────────────────────────

export type TileType =
  | 'Forest' // -> Wood
  | 'Hills' // -> Stone
  | 'Plains' // -> Food
  | 'Mountain' // -> Ore
  | 'Desert' // -> Gold (scarce, low yield)
  | 'River' // "water" — no resource yield; unlocks hero boat movement; raises the troop cap (constants.ts's troopCapFor)
  | 'Ruins' // "Ruins/Dungeon" — no resource; hosts a Monster Den; Watchtower-only
  | 'Volcano' // rare; no regular resource; one-time tame cache, then becomes Ashland
  | 'Ashland'; // post-tame Volcano; weak Stone yield

/** Static lookup: base resource produced per tile type (null = no automatic yield). */
export const TILE_RESOURCE: Record<TileType, ResourceType | null> = {
  Forest: 'Wood',
  Hills: 'Stone',
  Plains: 'Food',
  Mountain: 'Ore',
  Desert: 'Gold',
  // [DEFAULT — troop cap rework: was 'Food'] Water tiles no longer produce anything — their
  // whole value moved to raising the troop cap (constants.ts's troopCapFor). A tile that both
  // fed the economy AND was the sole route to a much larger army made every other terrain a
  // strict downgrade the moment one was available; splitting the roles keeps the choice real.
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
  /** Ruins only — set once a hero has taken this dungeon's treasure (§5 LootRuins).
   *  [DEFAULT — balance rework pass 2] Without it the Gather was infinitely repeatable: a
   *  cleared Ruins tile could be looted every action forever, draining the whole Loot deck from
   *  one hex. An all-AI sweep livelocked on exactly this, burning 5,810 consecutive LootRuins
   *  actions on a single tile, and a human clicking the same button would have farmed it just as
   *  freely. A dungeon's hoard is finite — you can only clean it out once. */
  hasBeenLooted?: boolean;
  /** How many Soldiers are physically standing on this tile, whoever they belong to. Upkeep is
   *  charged on them every round by whoever owns them — see reducers.ts's resolveSoldierUpkeep. */
  militiaCount?: number;
  /** [DEFAULT — territory rework] Whose Soldiers those are. Undefined means "the tile owner's",
   *  which is the common case; it differs only while an invading force is standing on ground it
   *  has not yet claimed. Troops take territory by WALKING ONTO it (MoveSoldiersAction), not by
   *  attacking from a distance, so a tile's occupier and its owner are now genuinely separate
   *  facts and every reader has to ask which one it means. */
  garrisonOwnerId?: PlayerId | null;
  /** [DEFAULT — territory rework] The round an invading garrison arrived on a tile it doesn't
   *  own. Holding through to a LATER round transfers ownership (see reducers.ts's
   *  claimHeldTerritory) — ground is taken by occupying it, not by winning one dice roll, so a
   *  rival gets a full turn to counter-attack before the flag actually changes. */
  occupationSinceRound?: number;
  /** Resources this tile has produced but nobody has collected yet — accumulates at the
   *  start of its owner's Phase 3 (see engine/reducers.ts's accumulateTileProduction), capped
   *  per resource type (TILE_STOCKPILE_CAP in constants.ts) so an unvisited tile doesn't grow
   *  unbounded. A hero standing here collects from this pile via a Gather action, into their
   *  own carried inventory — resources are never auto-banked to the player directly. */
  stockpile: ResourceBundle;
}

// ── 4. Buildings ─────────────────────────────────────────────────────────────────────────

export type BuildingType =
  | 'Sawmill' // Forest, +1 Wood/turn
  | 'HuntingLodge' // Forest, "Hunting Lodge" — +1 Food/turn, +1 XP on first hunt each round
  | 'Quarry' // Hills, +1 Stone/turn (round 4+, upgradable) — see constants.ts [DEFAULT]
  | 'Farm' // Plains, +1 Food/turn (round 4+, upgradable) — see constants.ts [DEFAULT]
  | 'Windmill' // Plains, requires Farm — converts 2 Food into 1 Gold/turn
  | 'Mine' // Mountain, +1 Ore/turn
  | 'Smithy' // Mountain, crafts hero gear from Ore + Gold
  | 'TradePost' // Desert, "Trade Post" — +1 Gold/turn, unlocks 2:1 bank trade
  | 'Dock' // River, +1 Food/turn, unlocks boat movement
  | 'Watchtower' // any owned tile — defense bonus in territory combat
  | 'Barracks' // Plains only — passively produces Soldiers; see constants.ts [DEFAULT]
  | 'CowStable' // Plains, +3 Meat/turn, upgradable — feeds Soldier upkeep [DEFAULT]
  | 'Capital'; // starting tile only — hero max HP up, second hero at high VP milestone

/** Runtime instance sitting on a specific tile. */
export interface Building {
  id: string;
  type: BuildingType;
  coord: HexCoord;
  ownerId: PlayerId;
  /** Capital upgrade only; cost and effect scale with tier. */
  tier?: number;
}

/** Static catalog entry — one per BuildingType, not per instance. Drives Phase 5 — Build. */
export interface BuildingDefinition {
  type: BuildingType;
  allowedTileTypes: TileType[] | 'any' | 'starting-tile-only';
  cost: ResourceCost;
  requiresBuilding?: BuildingType; // e.g. Windmill requires Farm built first
  producesResource?: ResourceType; // for the Phase 0 base-producer loop
  produceAmount?: number;
  /** [DEFAULT — balance rework] Earliest round this building may be constructed — undefined
   *  means no gate. Farm/Quarry use this: a naive resource-cost gate alone doesn't stop a
   *  turn-1 rush once a player has ANY income, so production buildings that compound need
   *  their own cooldown before they start snowballing. */
  minRound?: number;
  /** [DEFAULT — balance rework] Ordered list of tiers ABOVE tier 1, each reached by one
   *  UpgradeBuildingAction. upgrades[0] takes the building from tier 1 to tier 2, upgrades[1]
   *  from 2 to 3, and so on — so a definition with 4 entries tops out at tier 5. Only
   *  Farm/Quarry/CowStable define this; everything else stays single-tier. See selectors.ts's
   *  maxTierFor/produceAmountForTier/upgradeToTier for the lookups, and reducers.ts's
   *  applyUpgradeBuilding + accumulateTileProduction for how tier drives production. */
  upgrades?: { cost: ResourceCost; produceAmount: number }[];
  effectDescription: string;
}

// ── 5. Classes ───────────────────────────────────────────────────────────────────────────

export type ClassName = 'Woodcutter' | 'Miner' | 'Farmer' | 'Warrior' | 'Mage' | 'Merchant' | 'Rogue';

/** Discriminated union so each class's bonus is structurally typed, not free text. */
export type ClassStartingBonus =
  | { kind: 'Woodcutter'; prebuiltBuilding: 'Sawmill'; forestWoodBonusPerTile: number }
  | { kind: 'Miner'; startingOreBonus: number; startingTileBiasedNear: ('Hills' | 'Mountain')[] }
  | { kind: 'Farmer'; foodPerTurnBonus: number; heroMaxHpBonus: number }
  // startingWeaponAttackBonus is added to HeroState.attack once at spawn (base 1 -> 3, see
  // Rules Reference §1.4/§1.3). extraCombatDie means Fight-phase rolls (§6.1/§6.2 only, NOT
  // the per-unit §6.3 army dice) use 2d6-keep-highest instead of 1d6.
  | { kind: 'Warrior'; startingWeaponAttackBonus: number; extraCombatDie: true }
  | { kind: 'Mage'; buildingCostReduction: number; hasRangedAttackBeforeMelee: true }
  | { kind: 'Merchant'; bankTradeRatio: readonly [number, number]; startingGoldBonus: number }
  | { kind: 'Rogue'; passesThroughUnownedOrRivalTiles: true; stealsPerRound: number };

export interface ClassDefinition {
  id: ClassName;
  name: ClassName;
  startingBonus: ClassStartingBonus;
}

// ── 6. Loot, curses, and monsters ───────────────────────────────────────────────────────

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
  /** Structured form of "occasional special ability" for the one mechanical effect Rules
   *  Reference §4.1's movement formula names explicitly (`loot.movementBonus`) — a handful of
   *  loot cards grant this; most don't (undefined). Everything else stays flavor text above. */
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

// ── 6a. The Door deck [DEFAULT — Munchkin exploration layer] ───────────────────────────────
// Munchkin's core loop, grafted onto hex exploration: the FIRST time a hero ever sets foot on
// a given tile, something is behind the door. One shuffled deck mixes both outcomes — most of
// it is monsters (fight or nothing happens without one), the rest is smaller non-combat swings
// — exactly like the physical game shuffles monsters and curses/items into a single Door pile
// rather than drawing from separate decks. See reducers.ts's applyMoveHero for the trigger and
// resolveHeroVsMonster/applyFight for how a drawn monster is fought (same math a Ruins Den
// uses) — a Door monster and a Den monster are mechanically the same fight from two different
// doors in.

/** A small, closed set of effect shapes — deliberately not open-ended, so N flavorful Utility
 *  cards can share a handful of reducer branches instead of each needing bespoke logic.
 *  'FreeTreasure' is Munchkin's "it's a small treasure, no fight" card; 'Nothing' is a pure
 *  flavor whiff ("the door was stuck") so not every draw is mechanically loaded. */
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
  /** Meaning depends on effectKind: resource/HP/XP amount. Unused (undefined) for FreeTreasure
   *  and Nothing. */
  amount?: number;
}

export type DoorCard = { kind: 'Monster'; monster: MonsterCard } | { kind: 'Utility'; utility: UtilityCard };

export interface DoorDeckState {
  drawPile: DoorCard[];
  discardPile: DoorCard[];
}

// ── 7. Hero ──────────────────────────────────────────────────────────────────────────────

export interface HeroState {
  id: string;
  ownerId: PlayerId;
  level: number; // 1-10
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
  /** Engine bookkeeping (not in the original doc, needed to enforce "once per round" rules). */
  hasHuntedThisRound: boolean;
  /** Set once accumulated XP crosses the next-level threshold; consumed by a Phase 5
   *  LevelUpHeroAction (§7.4 — earning a level-up and applying it are separate steps). */
  pendingLevelUp: boolean;
  /** Resources this hero is physically holding, gathered from tile stockpiles (or stolen).
   *  Spendable immediately on a Build action targeting the hero's CURRENT tile; otherwise
   *  must be deposited at the player's Capital first (DepositResourcesAction) before it's
   *  usable elsewhere. Bounded by carryCapacityFor(hero) — see engine/selectors.ts. */
  carriedResources: ResourceBundle;
  /** [DEFAULT — Munchkin exploration layer] Every HexKey this hero has ever stood on, starting
   *  with their spawn tile (setup.ts). The FIRST time it grows to include a given key —
   *  i.e. the hero arriving somewhere new — triggers a Door card draw in applyMoveHero. */
  visitedTiles: HexKey[];
}

// ── 8. Player ────────────────────────────────────────────────────────────────────────────

export type PlayerId = string;

export interface Player {
  id: PlayerId;
  name: string;
  color: string;
  classId: ClassName;
  resources: ResourceBundle;
  ownedTiles: HexCoord[];
  capitalTile: HexCoord;
  capitalTier: number;
  hero: HeroState;
  victoryPoints: number;
  isEliminated: boolean;
  /** [give, receive] — default [4,1]; [2,1] via Trade Post; [3,1] via Merchant class. */
  bankTradeRatio: readonly [number, number];
  /** Engine bookkeeping: Rogue's once-per-round steal, tiles foraged this round. */
  hasStolenThisRound: boolean;
  foragedTilesThisRound: HexKey[];
}

// ── 9. Turn / phase structure ───────────────────────────────────────────────────────────

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

// ── 10. Decks, event log, and full GameState ───────────────────────────────────────────

export interface TileDeckState {
  drawPile: TileType[];
  discardPile: TileType[];
}

export interface MonsterDeckState {
  drawPile: MonsterCard[];
  discardPile: MonsterCard[];
}

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

export type WinCondition = 'VictoryPoints' | 'Domination' | 'HeroLevelRace';

export type GameStatus = 'lobby' | 'active' | 'finished';

export interface GameState {
  gameId: string;
  mode: GameMode;
  status: GameStatus;
  /** Seeds all deck shuffles and dice rolls so any transport can reproduce results. */
  rngSeed: string;
  /** Advances on every rng draw; part of state so the reducer stays a pure function of
   *  (state, action) without a module-level PRNG instance. See engine/rng.ts. */
  rngCursor: number;
  roundNumber: number;
  turnOrder: PlayerId[];
  currentPlayerId: PlayerId;
  currentPhase: Phase;
  map: Record<HexKey, Tile>;
  /** [DEFAULT — roads] Road segments, keyed by the EDGE between two adjacent hexes (see
   *  edgeKey), valued by the player who paid for it. Roads are the supply network: any owned
   *  tile joined to its owner's Capital by an unbroken chain of that player's roads has its
   *  stockpile collected automatically each round instead of needing a hero to walk there and
   *  carry it home (see reducers.ts's collectRoadConnectedTiles). That frees the hero — which is
   *  otherwise both the logistics unit AND the adventurer, at movement 2 — to actually go fight
   *  monsters. See selectors.ts's roadConnectedTiles for the connectivity rule. */
  roads: Record<EdgeKey, PlayerId>;
  players: Player[];
  tileDeck: TileDeckState;
  monsterDeck: MonsterDeckState;
  lootDeck: LootDeckState; // the Treasure deck — see LootCard's doc comment
  badStuffDeck: BadStuffDeckState;
  /** [DEFAULT — Munchkin exploration layer] One shuffled deck mixing Monster and Utility
   *  outcomes — see DoorCard's doc comment in this file for why it's a single combined deck
   *  rather than two separately-drawn ones. */
  doorDeck: DoorDeckState;
  /** [DEFAULT — Munchkin exploration layer] A Door card came up Monster and hasn't been fought
   *  yet. Set by applyMoveHero the instant a hero first sets foot on a tile; applyAdvancePhase
   *  refuses to leave Phase 4 (Fight) while this is non-null for the CURRENT player — the
   *  Munchkin rule that you can't just walk away from what's behind the door. Cleared by the
   *  matching Fight action (win or lose both resolve it — losing doesn't mean it's still there).
   *  Keyed by heroId so two heroes (post Town-tier-4) can't collide if they somehow both had one
   *  pending, even though only one hero moves per turn in practice. */
  pendingDoorMonster: { heroId: string; coord: HexCoord; monsterCardId: string } | null;
  eventLog: GameEvent[];
  winnerId: PlayerId | null;
  winCondition: WinCondition | null;
  /** Engine-internal: the tile type drawn this turn's Phase 1, awaiting PlaceTileAction.
   *  Not part of docs/data-model.md's minimal contract, added because a reducer needs
   *  somewhere to hold it between DrawTileAction and PlaceTileAction — see engine/reducers.ts. */
  pendingTileDraw: TileType | null;
  /** Engine-internal: set once the active player has placed their one tile this turn (§3 —
   *  "draw one hex tile... place it"). Without this, pendingTileDraw alone can't distinguish
   *  "haven't drawn yet" from "already drew AND placed" — both leave it null, which would let
   *  a player draw-and-place repeatedly in a single Phase 1. */
  hasPlacedTileThisTurn: boolean;
  /** Engine-internal: set true once the active player has resolved one Fight-phase action
   *  this turn (§6 "at most one combat resolution per Phase 4"). */
  hasFoughtThisTurn: boolean;
  /** Engine-internal: set true once the active player has taken their one Phase 5 action
   *  (§7 "EITHER construct one building, OR apply one earned hero level-up"). */
  hasBuiltThisTurn: boolean;
  /** Engine-internal: set once the active player has submitted a MoveHeroAction this turn.
   *  Without this, checkMovePath validates each MoveHeroAction's path length against the
   *  hero's full movementRange independently — nothing stops a client from submitting several
   *  separate moves in one Phase 2, each getting a fresh budget, walking far past their actual
   *  range. The reference UI already only ever sends one consolidated path per turn (see
   *  components/GameBoardApp.tsx's path-building flow), so this only bites a client calling
   *  the reducer directly (e.g. a modified online client hitting the Route Handler). */
  hasMovedThisTurn: boolean;
}

// ── 11. Actions ──────────────────────────────────────────────────────────────────────────

interface BaseAction {
  actorId: PlayerId;
  /** Disambiguates which hero acts once a Capital unlocks a second hero. */
  heroId?: string;
}

// --- Phase 1 — Draw & Place Tile -------------------------------------------------

export interface DrawTileAction extends BaseAction {
  type: 'DrawTile';
}

export interface PlaceTileAction extends BaseAction {
  type: 'PlaceTile';
  /** The tile type drawn this phase (echoed back for a pure/replayable reducer; also
   *  validated server-side against GameState.pendingTileDraw — never trusted blindly). */
  tileType: TileType;
  /** Must touch at least one tile the actor owns and be currently unoccupied. */
  coord: HexCoord;
}

// --- Phase 2 — Move Hero -----------------------------------------------------------

export interface MoveHeroAction extends BaseAction {
  type: 'MoveHero';
  /** Ordered steps; total length bounded by hero movementRange (or a River chain if viaBoat). */
  path: HexCoord[];
  viaBoat?: boolean;
}

// --- Phase 3 — Gather ----------------------------------------------------------------

export type GatherKind =
  | 'CollectResources' // own tile with a non-empty stockpile — collect into carried inventory
  | 'Forage' // Forest/Plains/Hills/Mountain/Desert tile NOT owned by the active player
  | 'LootRuins' // Ruins/Dungeon tile with no active Monster Den encounter pending
  | 'Hunt' // own Forest tile with a built Hunting Lodge
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

/** [DEFAULT — territory rework] REMOVED as a Phase-4 action. Territory combat is no longer a
 *  thing you declare from behind a Barracks — it happens when Soldiers march onto hostile ground
 *  (MoveSoldiersAction). The dice math itself is unchanged and still lives in combat.ts's
 *  resolveArmyVsTerritory; only the trigger moved. This type is intentionally gone rather than
 *  deprecated-in-place so nothing can keep dispatching the old shape. */

export interface TameVolcanoAction extends BaseAction {
  type: 'Fight';
  combatType: 'TameVolcano'; // high-difficulty fight; success converts tile to Ashland
  coord: HexCoord;
}

export type FightAction = FightMonsterAction | FightHeroAction | TameVolcanoAction;

// --- Phase 5 — Build ---------------------------------------------------------------------

export interface BuildBuildingAction extends BaseAction {
  type: 'Build';
  buildingType: BuildingType;
  coord: HexCoord;
}

export interface LevelUpHeroAction extends BaseAction {
  type: 'LevelUpHero';
}

/** [DEFAULT — balance rework, supersedes the old BuyMilitiaAction] Soldiers are no longer
 *  purchased — a Barracks produces them passively (constants.ts's SOLDIERS_PER_BARRACKS_PER_ROUND)
 *  into a reserve sitting at that tile. This action reassigns count from that reserve onto any
 *  owned tile (fromCoord === toCoord is a harmless no-op "leave them at the Barracks"). Gated
 *  to Phase 5 like the old action but — same reasoning as before — does NOT count against the
 *  one-Build-action-per-turn limit (§7): redeploying a standing army shouldn't cost you your
 *  one construction/level-up for the turn. */
export interface DeploySoldiersAction extends BaseAction {
  type: 'DeploySoldiers';
  fromCoord: HexCoord; // must be an owned tile with a Barracks and a non-empty reserve
  toCoord: HexCoord; // any owned tile
  count: number;
}

/** [DEFAULT — balance rework] Spends the next entry in a building's `upgrades` list
 *  (constants.ts's BUILDING_DEFINITIONS) to advance it one tier, raising its produceAmount.
 *  Only Farm/Quarry/CowStable currently define upgrades — CowStable runs all the way to tier 5.
 *  DOES count against the one-Build-action-per-turn limit (§7) — it's a construction-scale
 *  investment, not a free action. */
export interface UpgradeBuildingAction extends BaseAction {
  type: 'UpgradeBuilding';
  coord: HexCoord; // owned tile with an upgradable building, not already at max tier
}

/** [DEFAULT — roads] Lays one road segment along the edge between two adjacent hexes, for
 *  ROAD_COST (1 Wood). Both hexes must be placed, at least one must be owned by the actor, and
 *  the edge must not already carry a road. A free action (does NOT consume the one-Build-per-turn
 *  slot, §7): a road is cheap infrastructure, and making it compete with constructing a building
 *  would mean nobody ever builds the supply network the economy is designed around. */
export interface BuildRoadAction extends BaseAction {
  type: 'BuildRoad';
  from: HexCoord;
  to: HexCoord;
}

/** [DEFAULT — territory rework] Marches Soldiers one hex onto an ADJACENT tile — and this is now
 *  the ONLY way territory changes hands. There is no separate ranged "attack that tile" action
 *  and no Barracks-must-be-adjacent rule: a Barracks exists purely to unlock recruitment, and an
 *  army takes ground the way an army actually does, by walking onto it and staying.
 *
 *  Three outcomes, decided by what is already on the destination (see reducers.ts's
 *  applyMoveSoldiers):
 *    - Your own tile           -> simple reinforcement.
 *    - Hostile tile, undefended -> your troops occupy it; it becomes yours once they are still
 *                                  standing there in a LATER round (Tile.occupationSinceRound).
 *    - Hostile troops present   -> combat resolves immediately (§6.3 dice). The winner holds the
 *                                  tile; if that's the attacker, the same hold-through-a-round
 *                                  rule then applies before ownership actually transfers.
 *
 *  Phase 5, after combat has resolved, and a free action — so a border can be reinforced or
 *  probed every turn without spending the turn's one build.
 *
 *  [DEFAULT — hero battle participation] heroJoins: true has this hero lend their die to a
 *  contested fight (engine/combat.ts's resolveArmyVsTerritory) — the hero must physically be
 *  standing on fromCoord (leading the charge from the front line, not marching into the target
 *  tile themselves — their position is untouched either way; hero movement stays MoveHeroAction's
 *  job in Phase 2). Ignored on an uncontested move (nothing to fight). A defending hero needs no
 *  flag of their own — they participate automatically just by being physically present on
 *  toCoord when the attack lands, symmetric with how territory combat already triggers on
 *  contact rather than a deliberate opt-in. Losing a pairing costs the hero HP, not the army a
 *  Soldier — see HERO_BATTLE_DAMAGE_FLOOR; HP reaching 0 this way is permadeath (a fresh level-1
 *  hero replaces them, see reducers.ts's respawnHeroFromDeath), distinct from the softer
 *  downed-and-retreat rule that still governs ordinary monster-fight losses. */
export interface MoveSoldiersAction extends BaseAction {
  type: 'MoveSoldiers';
  fromCoord: HexCoord;
  toCoord: HexCoord;
  count: number;
  heroId?: string;
  heroJoins?: boolean;
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

/** Free action, like Equip/Unequip — not phase- or once-per-turn-gated. Requires the acting
 *  hero to be standing on the player's Capital tile ("hometown"). Moves everything the hero
 *  is carrying into the player's spendable resources, clearing carriedResources to zero. */
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
  | EquipLootAction
  | UnequipLootAction
  | TradeWithBankAction
  | DepositResourcesAction
  | AdvancePhaseAction
  | EndTurnAction;

export type Reducer = (state: GameState, action: Action) => GameState;

/** Thrown by validators for illegal actions; server/UI layers catch this and surface a
 *  rejection instead of a crash. Never thrown for "normal" game outcomes (e.g. losing a
 *  fight is a valid, successfully-applied action, not an error). */
export class IllegalActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalActionError';
  }
}
