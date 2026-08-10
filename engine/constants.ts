/**
 * Every numeric/tunable value from docs/rules-reference.md, as named constants — never as
 * inline magic numbers in reducer code. Each is commented with its [CANON]/[DEFAULT] tag and
 * source section so retuning stays traceable back to the rulebook.
 */

import type {
  BuildingDefinition,
  BuildingType,
  ClassDefinition,
  LootRarity,
  ResourceBundle,
  ResourceCost,
  TileType,
} from './types';

// ── §1.2 Starting Resources [DEFAULT — balance rework: zeroed out] ─────────────────────────
// Every seat starts with an empty wallet — the only day-1 resources a player has are whatever
// their class's own starting bonus grants (see setup.ts's buildStartingPlayer: Woodcutter +2
// Wood, Miner +1 Ore, Merchant +2 Gold), which are class-identity perks layered ON TOP of this
// zero baseline, not "starting resources" in the generic sense this table used to provide.
export const STARTING_RESOURCES: ResourceBundle = { Wood: 0, Stone: 0, Food: 0, Ore: 0, Meat: 0, Gold: 0 };

// ── §1.4 Starting Tile Placement [DEFAULT] ─────────────────────────────────────────────────
export const CAPITAL_MIN_DISTANCE = 3;
export const BASE_HERO_STATS = { level: 1, hp: 10, maxHp: 10, attack: 1, xp: 0 } as const;

// ── Resource economy redesign (post-launch change, not in original rules-reference.md):
// tiles accumulate a stockpile at the start of Phase 3 instead of auto-banking in Phase 0;
// the hero must visit and collect, bounded by carry capacity, and deposit at the Capital to
// make carried resources spendable away from where they were picked up. ──────────────────

// Base 4, +1 per hero level — a level 1 hero carries 5 total (any mix of resource types), a
// level 5 hero carries 9. [DEFAULT]
export const CARRY_CAPACITY_BASE = 4;
export function carryCapacityForLevel(level: number): number {
  return CARRY_CAPACITY_BASE + level;
}

/** Per-resource-type cap on how much a single tile can stockpile before production stops
 *  accumulating there — prevents unbounded growth on a tile nobody visits. [DEFAULT —
 *  balance rework: lowered 10 -> 5] At 10 an untouched tile quietly banked two full hero-loads,
 *  so territory paid out whether or not anyone ever walked to it and the early economy ran hot.
 *  At 5 a tile tops out at roughly one level-1 hero's carry capacity: collection trips are a
 *  real logistical decision again, and holding ground you never visit stops being free income. */
export const TILE_STOCKPILE_CAP = 5;

// ── §4.1 Movement Range [DEFAULT] ──────────────────────────────────────────────────────────
export const MOVEMENT_BASE = 2;
export const MOVEMENT_LEVEL5_BONUS = 1;
export const MOVEMENT_LEVEL5_THRESHOLD = 5;

// ── §4.2 Terrain cost [DEFAULT] ─────────────────────────────────────────────────────────────
export const TERRAIN_COST_DEFAULT = 1;

// ── §3.3 Tile Deck [DEFAULT] ─────────────────────────────────────────────────────────────────
export function tileDeckSize(playerCount: number): number {
  return 100 + 20 * (playerCount - 2);
}

/** [DEFAULT — direct request] River ("water") tiles are no longer a percentage of the deck —
 *  see decks.ts's buildTileDeck, which pulls exactly this many out before the percentage
 *  composition below is applied to what's left. A flat 8% scaled UP with deck size (which
 *  grows 20 tiles per extra player) while the troop-cap payoff for owning water is what it is
 *  regardless of player count, so a big game could flood the map with far more water than any
 *  one empire's cap curve was ever tuned around. A small per-player count keeps water scarce
 *  and roughly proportional to how much territory actually exists to hold it. */
export const RIVER_TILES_PER_PLAYER = 1.5;
export function riverTileCountFor(playerCount: number): number {
  return Math.floor(RIVER_TILES_PER_PLAYER * playerCount);
}

/** Percent of the NON-RIVER remainder of the deck per tile type — must sum to 100 among
 *  themselves (River is carved out separately, see riverTileCountFor above, and always reads 0
 *  here on purpose — decks.ts's buildTileDeck skips it explicitly rather than relying on that).
 *  [DEFAULT — direct request] Forest raised 20% -> 28%, absorbing River's old 8% share (rather
 *  than spreading it thin across every type) — a live 6-round report found a player with zero
 *  Wood the entire game, and Wood is both a base building cost across nearly every early
 *  structure AND Roads' one ingredient, so it's the resource that can least afford to be scarce.
 *  [DEFAULT — balance rework pass 2] Ruins raised 6% -> 12%, taken evenly off the four bulk
 *  economy terrains. Ruins are the ONLY source of Monster Dens, and therefore the only source of
 *  hero XP, levels, and loot outside a Hunting Lodge — at 6% a full game put just 2-5 of them on
 *  the board, so even a hero that hunted perfectly could not level more than once or twice and
 *  the entire Munchkin layer stayed vestigial. Doubling the share gives that half of the game
 *  enough material to actually be played. */
export const TILE_DECK_COMPOSITION: Record<TileType, number> = {
  Forest: 28,
  Plains: 20,
  Hills: 17,
  Mountain: 15,
  River: 0, // carved out separately by count — see RIVER_TILES_PER_PLAYER above
  Desert: 6,
  Ruins: 12,
  Volcano: 2,
  Ashland: 0, // never drawn — only created by taming a Volcano
};

// ── §6.1 Hero vs Monster [DEFAULT thresholds/rewards, CANON formula shape] ─────────────────
export const MONSTER_THRESHOLD_OFFSET = 3; // threshold = monster.level + 3
export const MONSTER_XP_REWARD_EQUALS_LEVEL = true; // XP gained on win = monster.level
export const MONSTER_HP_DAMAGE_EQUALS_LEVEL = true; // HP lost on loss = monster.level

export function lootRarityForMonsterLevel(level: number): LootRarity {
  if (level <= 2) return 'Common';
  if (level <= 4) return 'Uncommon';
  if (level <= 7) return 'Rare';
  return 'Legendary';
}

// ── §6.1 Volcano taming [DEFAULT] ───────────────────────────────────────────────────────────
export const VOLCANO_MONSTER_LEVEL = 10;
export const VOLCANO_WIN_GOLD_REWARD = 5;
/** Quarry built on a tamed Volcano (narrated as Ashland) only produces on even round
 *  numbers — a simple, deterministic stand-in for "every 2 turns" that needs no extra
 *  per-building state. */
export const ASHLAND_QUARRY_PRODUCES_ON_EVEN_ROUNDS_ONLY = true;

// ── §6.3 Army vs Territory [DEFAULT] ────────────────────────────────────────────────────────
export const WATCHTOWER_DIE_BONUS = 1;
export const WATCHTOWER_DIE_CAP = 6;

/** [DEFAULT — balance rework pass 4] Watchtower's upgrade track — same generalized-tier
 *  mechanism as Farm/Quarry/CowStable (BuildingDefinition.upgrades, selectors.ts's
 *  tierOf/nextUpgradeFor), except the thing that scales per tier is a defense bonus, not a
 *  producesResource/produceAmount pair, so it's looked up here instead of read generically —
 *  see combat.ts's resolveArmyVsTerritory, which takes the defending tile's Watchtower tier
 *  directly and indexes this array. Tier 1 is the existing base build (WATCHTOWER_DIE_BONUS/CAP
 *  above, unchanged) and costs nothing further; tiers 2-3 are real Stone+Ore(+some Wood) sinks
 *  a mature economy actually wants, since a stronger Watchtower is exactly what makes "protect
 *  your Capital and borders" a genuine building investment rather than only a garrison number —
 *  directly motivated by Capital Conquest (§11) making a captured Capital an instant loss. */
export const WATCHTOWER_TIERS = [
  { tier: 1, cost: {} as ResourceCost, dieBonus: WATCHTOWER_DIE_BONUS, dieCap: WATCHTOWER_DIE_CAP },
  { tier: 2, cost: { Wood: 3, Stone: 5, Ore: 3 } as ResourceCost, dieBonus: 2, dieCap: 6 },
  { tier: 3, cost: { Wood: 6, Stone: 9, Ore: 6 } as ResourceCost, dieBonus: 3, dieCap: 8 },
] as const;
/** [DEFAULT — territory rework, tuned per designer feedback: was effectively 1 round] How many
 *  FULL rounds an occupier must hold a tile, uncontested, before ownership actually transfers
 *  (engine/reducers.ts's claimHeldTerritory). At 1 a raid could plant a flag and walk away with
 *  the deed almost immediately; 3 gives the defender real time to notice an incursion and march
 *  back before it's permanent, which is the whole point of occupation being a process rather
 *  than an instant capture. */
export const TERRITORY_CLAIM_ROUNDS = 3;
// ── Troop cap [DEFAULT — direct request] ────────────────────────────────────────────────────
/** A player's TOTAL Soldier count — every tile they garrison anywhere, the same basis
 *  resolveSoldierUpkeep bills against (see garrisonOwnerOf) — can never exceed this, and it
 *  scales with how much water the player controls. Base 25 with no River tiles; owning one
 *  jumps it to 100, a second to 150, a third to 175, and it holds flat at the stated ceiling of
 *  200 from a fourth tile on. Water tiles produce no resource of their own (TILE_RESOURCE.River
 *  is null) — this is their entire value proposition, deliberately a much bigger lever than
 *  incremental economy buildings so that securing water is a real strategic choice, not a
 *  rounding error. Enforced at the one place new Soldiers ever enter existence — Barracks
 *  recruitment in accumulateTileProduction — since every other militiaCount writer only moves
 *  or removes existing troops and can never push a total above what was already legal. */
export const TROOP_CAP_BASE = 25;
const TROOP_CAP_BY_WATER_TILES: readonly number[] = [TROOP_CAP_BASE, 100, 150, 175]; // index = water tile count, 0-3
export const TROOP_CAP_MAX = 200;

export function troopCapFor(waterTileCount: number): number {
  if (waterTileCount < TROOP_CAP_BY_WATER_TILES.length) return TROOP_CAP_BY_WATER_TILES[waterTileCount];
  return TROOP_CAP_MAX;
}

/** [DEFAULT — territory rework, Risk's classic rule] MoveSoldiers can never fully vacate its
 *  source tile — you always leave at least this many behind. Without it a player could empty
 *  every garrison into one all-in strike, which both trivializes "defend your border" (there's
 *  nothing stopping a tile from being left at zero) and doesn't match how the designer pictures
 *  the war: standing garrisons on both sides of a border, not armies that evaporate the instant
 *  they're needed elsewhere. */
export const MIN_SOLDIERS_LEFT_BEHIND = 1;

// ── §6.3 Hero battle participation [DEFAULT — direct request] ──────────────────────────────
/** A hero who joins a MoveSoldiers march (or is simply standing on a tile being attacked)
 *  contributes ONE extra die to that side's Army vs Territory roll-off — computed with the exact
 *  same formula as every other Fight-phase roll (rollHeroAttack: die + level + attack + gear).
 *  The hero isn't a counted unit, so their die doesn't feed attackerLosses/defenderLosses; losing
 *  their own pairing costs HP instead (engine/combat.ts's heroBattleDamage), floored here so even
 *  a near-tie loss still stings and scaling up with the margin so getting blown out by a much
 *  stronger roll genuinely hurts — the same "bigger threat, bigger consequence" shape as Hero vs
 *  Monster's damage-equals-monster-level rule, just derived from the opposing roll instead of a
 *  fixed monster stat since there's no monster card to read a level off of here. */
export const HERO_BATTLE_DAMAGE_FLOOR = 2;
/** Flat XP for winning a battle pairing — deliberately modest (versus Hero vs Monster's
 *  level-scaled reward) since a Risk skirmish is a much lower-stakes, more frequent event than a
 *  deliberate Door-card monster fight; it's a nudge to make joining worthwhile, not the main way
 *  to level up. */
export const HERO_BATTLE_XP_ON_WIN = 2;

// ── Barracks & Soldier economy [DEFAULT — balance rework, supersedes the old MILITIA_COST
// purchase model] Soldiers are no longer bought — a Barracks produces them passively each
// round into a reserve at that tile (DeploySoldiers then reassigns them anywhere owned), and
// every Soldier anywhere on a player's territory costs upkeep every round regardless of
// whether it's deployed or still sitting in reserve. ──────────────────────────────────────
/** [DEFAULT — balance rework pass 3] Recruitment now scales with TERRITORY, Risk-style, instead
 *  of being a flat +3: a Barracks raises floor(ownedTiles / SOLDIERS_PER_TILES_DIVISOR) Soldiers
 *  per round, with a floor of SOLDIERS_PER_BARRACKS_MIN so a Barracks is never literally idle.
 *  A flat rate meant a sprawling empire and a three-tile holdout fielded identical armies, which
 *  is exactly the coupling Risk uses reinforcements to express — holding more ground should
 *  BE the military advantage. */
export const SOLDIERS_PER_TILES_DIVISOR = 3;
export const SOLDIERS_PER_BARRACKS_MIN = 1;

/** [DEFAULT — balance rework pass 4] tilesPerSoldier defaults to the tier-1 divisor above so
 *  every existing single-argument call site (a tier-1 Barracks) is unaffected. A tiered
 *  Barracks (BARRACKS_TIERS below) passes its own, smaller divisor to recruit faster per owned
 *  tile — see accumulateTileProduction in reducers.ts. */
export function soldiersPerRoundFor(ownedTileCount: number, tilesPerSoldier: number = SOLDIERS_PER_TILES_DIVISOR): number {
  return Math.max(SOLDIERS_PER_BARRACKS_MIN, Math.floor(ownedTileCount / tilesPerSoldier));
}
/** Caps an unvisited/undeployed Barracks reserve, same philosophy as TILE_STOCKPILE_CAP for
 *  resources — generous enough that "deploy when convenient" never actually loses production.
 *  [DEFAULT — balance rework pass 2: lowered 15 -> 9] Barracks production is automatic and
 *  cannot be declined, and upkeep is charged on the reserve as well as on deployed garrisons,
 *  so the cap is really a cap on a FORCED recurring bill. At 15 a single Barracks compounded to
 *  10 food-equivalent per round — more than a tier-1 Cow Stable's 1 Meat could ever offset —
 *  and a measured sweep showed it draining every player's Food to zero every turn, which in turn
 *  starved hero level-ups (1 Food + 1 Gold) so completely that no hero leveled once all game.
 *  9 keeps a real standing army, still clears the AI's 6-soldier strike force, and bounds the
 *  unavoidable bill at 6 food-equivalent. */
export const BARRACKS_RESERVE_CAP = 9;

/** [DEFAULT — balance rework pass 4] Barracks's upgrade track, same generalized-tier mechanism
 *  as Watchtower's above — a real, escalating Wood+Ore+Food sink (a mature economy's other
 *  laggard resources, alongside Stone via Watchtower) that also raises the reserve cap and
 *  recruits faster per owned tile, so a bigger, better-fed empire can field a correspondingly
 *  bigger standing army rather than being permanently bottlenecked at the tier-1 numbers.
 *  Tier 1 matches the existing BARRACKS_RESERVE_CAP/SOLDIERS_PER_TILES_DIVISOR exactly (nothing
 *  about a freshly-built, unupgraded Barracks changes). A player may build more than one
 *  Barracks (one per owned Plains tile, §7.1/§7.2) and upgrade each independently, so the total
 *  sink scales with how large the empire already is. */
export const BARRACKS_TIERS = [
  { tier: 1, cost: {} as ResourceCost, reserveCap: BARRACKS_RESERVE_CAP, tilesPerSoldier: SOLDIERS_PER_TILES_DIVISOR },
  { tier: 2, cost: { Wood: 6, Ore: 4, Food: 4 } as ResourceCost, reserveCap: 15, tilesPerSoldier: 2 },
  { tier: 3, cost: { Wood: 10, Ore: 8, Food: 8 } as ResourceCost, reserveCap: 21, tilesPerSoldier: 1 },
] as const;
/** Upkeep is charged in food-equivalent units per full group of 3 Soldiers: 2 Food OR 1 Meat
 *  per group, combinable (MEAT_UPKEEP_VALUE says how much of the 2-unit bill one Meat covers).
 *  A partial trailing group (1-2 extra Soldiers) still costs a full group's bill — see
 *  reducers.ts's resolveSoldierUpkeep for the exact rounding and desertion-on-shortfall rule. */
export const SOLDIER_UPKEEP_GROUP_SIZE = 3;
export const SOLDIER_UPKEEP_FOOD_PER_GROUP = 2;
export const MEAT_UPKEEP_VALUE = 2; // 1 Meat = 2 Food-equivalent units, i.e. "1 Meat per 3 Soldiers"

/** Food-equivalent units owed per round for `soldierCount` soldiers. A partial trailing group
 *  still costs a full group. Shared by the upkeep charge itself and by the Barracks recruitment
 *  throttle so the two can never disagree about what an army costs. */
export function soldierUpkeepUnits(soldierCount: number): number {
  if (soldierCount <= 0) return 0;
  return Math.ceil(soldierCount / SOLDIER_UPKEEP_GROUP_SIZE) * SOLDIER_UPKEEP_FOOD_PER_GROUP;
}

// ── Roads [DEFAULT — balance rework pass 3] ─────────────────────────────────────────────────
/** One road segment along one tile edge. Deliberately cheap: roads are meant to be spammed
 *  outward from the Capital into a supply network, and the interesting decision is WHERE the
 *  network reaches, not whether you can afford the next segment. */
export const ROAD_COST: ResourceCost = { Wood: 1 };

// ── §7.3 Town (Capital) Tiers [DEFAULT — territory rework: 2 tiers -> 5, tier 1 now free] ──────
/** [DEFAULT] Every player's starting tile is special: it carries a Town from turn one, not an
 *  empty hex waiting for someone to spend a Build action on it — see setup.ts's
 *  buildStartingPlayer. Index 0 here is that free starting grant (capitalTier begins at 1, this
 *  entry's cost is never actually paid); indices 1-4 are the four tiers a player can still buy,
 *  reached one at a time via a 'Build' action with buildingType 'Capital' (applyBuild in
 *  reducers.ts indexes this array by player.capitalTier, so CAPITAL_TIERS[capitalTier] is
 *  always "the next tier up"). Was a 2-tier table; stretched to 5 so the Town keeps being a real
 *  investment choice deep into a game that now often runs 20+ rounds, and so its VP contribution
 *  (VP_CAPITAL_TIER below) scales sensibly against the raised WIN_VP_THRESHOLD (30). */
/** [DEFAULT — balance rework pass 4] Tier 6, "the Grand Bazaar," added on top of the 5-tier
 *  ladder above — a genuine late-game wonder rather than a new BuildingType, so it reuses this
 *  exact table/applyBuild code path with zero new tile-slot handling (a separate BuildingType
 *  restricted to the Capital tile would collide with the Town/Capital Building already
 *  occupying that tile's one building slot — see setup.ts). Its cost deliberately spans FIVE of
 *  the six resources at once (only Meat excluded, since Meat's whole purpose is Soldier upkeep,
 *  §6.3a) specifically to give Wood, Stone, Ore, and Gold — the four resources with no other
 *  late-game sink (see the Building Cost Table below and Smithy/Watchtower/Barracks upgrades
 *  above) — one big, satisfying, one-time drain each once the rest of the build tree is spent
 *  out. */
export const CAPITAL_TIERS = [
  { tier: 1, cost: {} as ResourceCost, heroMaxHpBonus: 2 }, // granted free at spawn
  { tier: 2, cost: { Wood: 3, Stone: 3, Food: 3 } as ResourceCost, heroMaxHpBonus: 3 },
  { tier: 3, cost: { Stone: 4, Ore: 3, Food: 4 } as ResourceCost, heroMaxHpBonus: 3 },
  { tier: 4, cost: { Ore: 5, Gold: 5 } as ResourceCost, heroMaxHpBonus: 3 },
  { tier: 5, cost: { Gold: 8, Ore: 6, Stone: 6 } as ResourceCost, heroMaxHpBonus: 5 },
  { tier: 6, cost: { Wood: 15, Stone: 12, Ore: 10, Gold: 15, Food: 8 } as ResourceCost, heroMaxHpBonus: 4 },
] as const;

// ── §7.4 Hero Level-Up & Equip [DEFAULT] ────────────────────────────────────────────────────
/** [DEFAULT — balance rework pass 2: was 1 Food + 1 Gold] The Gold half made hero progression
 *  hostage to terrain luck. Gold only comes from Desert tiles (6% of the deck), a Trade Post
 *  built on one, or a Windmill — so a player who simply never drew a Desert had no Gold income
 *  at all, and a measured sweep caught exactly that: one seat sat on an earned level-up for 23
 *  consecutive Build phases holding 6-8 Food and 0 Gold, and no hero in any game ever reached
 *  level 2. XP is meant to be the gate on leveling; the resource cost should be a modest tax on
 *  a currency everyone actually earns, not a second lottery on top of the first. */
export const LEVEL_UP_COST: ResourceBundle = { Wood: 0, Stone: 0, Food: 2, Ore: 0, Meat: 0, Gold: 0 };
export const GEAR_SLOT_COUNT = 3;
export function xpToReachNextLevel(currentLevel: number): number {
  return currentLevel * 3; // §8.1 [CANON]
}

// ── §7.5 Bank Trade [CANON ratios] ──────────────────────────────────────────────────────────
export const BANK_TRADE_DEFAULT_RATIO: readonly [number, number] = [4, 1];
export const TRADE_POST_RATIO: readonly [number, number] = [2, 1];
export const MERCHANT_RATIO: readonly [number, number] = [3, 1];

// ── §8.2 Level-Up Effects [DEFAULT] ─────────────────────────────────────────────────────────
export const LEVEL_UP_MAX_HP_BONUS = 2;

// ── §10 Victory Point Scoring [DEFAULT] ─────────────────────────────────────────────────────
export const VP_PER_OWNED_TILE = 1;
export const VP_PER_BUILDING = 1;
/** [DEFAULT — territory rework: extended to 5 tiers, alongside CAPITAL_TIERS above] Tier 1 is
 *  free but still scores — it's the Town that already exists, not a discount. */
export const VP_CAPITAL_TIER = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 6, 6: 8 } as const;
export const VP_HERO_LEVEL_MILESTONES: Record<number, number> = { 3: 1, 5: 2, 7: 3, 10: 5 };
export const VP_PER_LEGENDARY_LOOT = 2;

// ── §11 Win Conditions [CANON thresholds] ───────────────────────────────────────────────────
/** [DEFAULT — balance rework: raised 15 -> 30] Owned tiles alone pay 1 VP each and every player
 *  places one tile per round unopposed, so VP accrued at a near-fixed ~1/round metronome
 *  regardless of how anyone actually played. At 15 that clock ran out around round 12-14 —
 *  before heroes had leveled enough to matter (the Munchkin layer) and long before anyone had
 *  the economy to field an army (the Risk layer), so games were decided by pure tile-laying.
 *  30 pushes the finish line past the point where both of those systems come online.
 *  [DEFAULT — doubled twice per direct feedback: 30 -> 60 -> 120] Even at 60, VP was still
 *  reported as the game's default ending rather than Domination or Hero-Level-Race getting a
 *  real chance to land first — every owned tile and every building keeps paying VP every round
 *  regardless of how the war is going, so a large, peaceful economy still out-scores a smaller
 *  empire that's actually winning the fight for territory. 120 pushes the VP finish line well
 *  past what steady tile/building accumulation alone can plausibly reach in a normally-paced
 *  game, so a war has to actually be won (or a hero actually has to hit level 10) before VP
 *  becomes the tiebreaker instead of the headline. */
export const WIN_VP_THRESHOLD = 120;
export const WIN_DOMINATION_TILE_SHARE = 0.6;
export const WIN_HERO_LEVEL_THRESHOLD = 10;
/** [DEFAULT — balance rework] Hard floor on the round any threshold-based win may trigger, so
 *  no combination of lucky draws, a rushed hero, or an early snowball can end the game before
 *  the mid-game systems exist at all. Conquest is deliberately EXEMPT (see selectors.ts's
 *  checkWinConditions): eliminating every rival is a decisive military result that earned its
 *  ending whenever it lands, and gating it would mean play continuing with nobody left to
 *  play against. */
export const WIN_MIN_ROUND = 12;
/** [DEFAULT — gap in the original canon] The 60% share is only a meaningful signal once the
 *  board has actually developed: with e.g. 3 tiles total placed in a fresh 2-player game, one
 *  player owning 2 of them already clears 60% despite nobody having "dominated" anything. The
 *  eliminate-all-rivals path (§11's alternate Domination trigger) is exempt — an elimination
 *  is a real win regardless of map size. Scales with seat count so a 6-player game needs a
 *  proportionally larger board before percentage-based Domination can trigger too. */
export const WIN_DOMINATION_MIN_TILES_PER_PLAYER = 8;

// ── §1.3 Classes [CANON bonuses] ────────────────────────────────────────────────────────────
export const CLASS_DEFINITIONS: Record<string, ClassDefinition> = {
  Woodcutter: {
    id: 'Woodcutter',
    name: 'Woodcutter',
    startingBonus: { kind: 'Woodcutter', prebuiltBuilding: 'Sawmill', forestWoodBonusPerTile: 1 },
  },
  Miner: {
    id: 'Miner',
    name: 'Miner',
    startingBonus: { kind: 'Miner', startingOreBonus: 1, startingTileBiasedNear: ['Hills', 'Mountain'] },
  },
  Farmer: {
    id: 'Farmer',
    name: 'Farmer',
    startingBonus: { kind: 'Farmer', foodPerTurnBonus: 1, heroMaxHpBonus: 2 },
  },
  Warrior: {
    id: 'Warrior',
    name: 'Warrior',
    startingBonus: { kind: 'Warrior', startingWeaponAttackBonus: 2, extraCombatDie: true },
  },
  Mage: {
    id: 'Mage',
    name: 'Mage',
    startingBonus: { kind: 'Mage', buildingCostReduction: 1, hasRangedAttackBeforeMelee: true },
  },
  Merchant: {
    id: 'Merchant',
    name: 'Merchant',
    startingBonus: { kind: 'Merchant', bankTradeRatio: MERCHANT_RATIO, startingGoldBonus: 2 },
  },
  Rogue: {
    id: 'Rogue',
    name: 'Rogue',
    startingBonus: { kind: 'Rogue', passesThroughUnownedOrRivalTiles: true, stealsPerRound: 1 },
  },
};

// ── Smithy — CraftGear [DEFAULT — balance rework pass 4, new mechanic] ─────────────────────
/** The Smithy's effectDescription ("crafts hero gear from Ore + Gold") predates any actual
 *  implementation — see CraftGearAction in types.ts for the action this finally wires up. Cost
 *  scales steeply with the rarity requested, deliberately the single largest recurring Ore AND
 *  Gold sink in the game (both otherwise thin on late-game demand — see the Building Cost Table
 *  below for everything else that touches them) — a player can keep crafting every turn their
 *  wallet allows, which is what makes this a genuine sink rather than a one-off purchase.
 *  Guaranteed rarity (unlike a monster kill's level-scaled odds) is the trade-off for the cost:
 *  you're buying certainty, not a chance at one. */
export const SMITHY_CRAFT_COSTS: Record<LootRarity, ResourceCost> = {
  Common: { Ore: 3, Gold: 2 },
  Uncommon: { Ore: 6, Gold: 4 },
  Rare: { Ore: 10, Gold: 8 },
  Legendary: { Ore: 16, Gold: 14 },
};

// ── SellLoot — gear-for-troops [DEFAULT — balance rework pass 4, new mechanic, direct request] ─
/** "Treasure/equipment has a gold value, like in Munchkin, sellable for additional troops —
 *  higher level equip = more troops." A Loot card sold at a Barracks (SellLootAction, the
 *  inverse of CraftGear) grants this many Soldiers straight into that Barracks's reserve,
 *  clamped by its BARRACKS_TIERS reserve cap and the player's overall troopCapFor the same way
 *  ordinary recruitment is. Scales with rarity, not linearly with LOOT_RARITY_BONUS's own +1/+2/
 *  +3/+5 combat-bonus curve — a Legendary is both rarer AND a much bigger one-time army swing
 *  than 5x a Common would suggest, matching how much harder it is to come by in the first
 *  place. */
export const LOOT_SELL_TROOPS: Record<LootRarity, number> = {
  Common: 1,
  Uncommon: 2,
  Rare: 4,
  Legendary: 7,
};

// ── §7.1 Building Cost Table [CANON] ────────────────────────────────────────────────────────
export const BUILDING_DEFINITIONS: Record<BuildingType, BuildingDefinition> = {
  // [DEFAULT — balance rework] Every production building now carries a minRound. Without one,
  // the whole build tree was open on turn 1-2 and the opening played itself: grab whatever tile
  // came up, stack its producer immediately, compound from there. Staging them gives the early
  // rounds an actual shape (explore and collect first, industrialize second) and stops a lucky
  // first draw from deciding the game. The schedule is deliberately tiered rather than one flat
  // gate — see each entry. Barracks is intentionally NOT round-gated (its cost is its gate);
  // delaying it further would push the Risk layer even later, which is the opposite of the goal.
  Sawmill: {
    type: 'Sawmill',
    allowedTileTypes: ['Forest'],
    // [DEFAULT — bugfix/balance, found via a full-game AI balance simulation] Was Wood:2/Stone:1.
    // A permanent +1/turn producer this cheap, with no cap on how many an AI can build (one per
    // owned Forest tile, and there's no upper bound on that), measurably explains why Wood was in
    // 900-1500+ net surplus in every one of four full measured games (one player finished with 11
    // Sawmills). Raised, not capped — a real diminishing-returns or per-player-limit mechanic
    // would be a bigger, separate change; this at least slows how fast the surplus compounds.
    cost: { Wood: 3, Stone: 2 },
    producesResource: 'Wood',
    produceAmount: 1,
    minRound: 3, // basic single-resource producer
    effectDescription: '+1 Wood/turn; round 3+',
  },
  HuntingLodge: {
    type: 'HuntingLodge',
    allowedTileTypes: ['Forest'],
    cost: { Wood: 2, Food: 1 },
    producesResource: 'Food',
    produceAmount: 1,
    // Later than the plain producers: it pays Food AND feeds the hero XP engine, so having it
    // available in round 2 (as it was) meant free early leveling on top of free early income.
    minRound: 5,
    effectDescription: '+1 Food/turn; hero gains +1 XP on first hunt each round; round 5+',
  },
  Quarry: {
    type: 'Quarry',
    allowedTileTypes: ['Hills', 'Ashland'], // Ashland follows Hills placement rules, §7.2
    // [DEFAULT — bugfix/balance, see Sawmill's identical note] Was Stone:2/Wood:1 — Stone showed
    // the same 600-750+ net surplus pattern across every measured game (one player built 7 of
    // these on top of 2 upgraded tiers each).
    cost: { Stone: 3, Wood: 2 },
    producesResource: 'Stone',
    produceAmount: 1,
    minRound: 4, // [DEFAULT — balance rework] see BuildingDefinition.minRound doc comment
    upgrades: [
      { cost: { Stone: 4, Ore: 2 }, produceAmount: 2 },
      { cost: { Stone: 6, Ore: 4 }, produceAmount: 3 },
    ],
    effectDescription: '+1 Stone/turn (Ashland: half rate); round 4+; upgradable to +3/turn',
  },
  Farm: {
    type: 'Farm',
    allowedTileTypes: ['Plains'],
    cost: { Food: 2, Wood: 1 },
    producesResource: 'Food',
    produceAmount: 1,
    minRound: 4, // [DEFAULT — balance rework] see BuildingDefinition.minRound doc comment
    upgrades: [
      { cost: { Food: 4, Wood: 2 }, produceAmount: 2 },
      { cost: { Food: 6, Wood: 4 }, produceAmount: 3 },
    ],
    effectDescription: '+1 Food/turn; round 4+; upgradable to +3/turn',
  },
  Windmill: {
    type: 'Windmill',
    allowedTileTypes: ['Plains'],
    cost: { Stone: 2, Wood: 2 },
    requiresBuilding: 'Farm',
    minRound: 6, // second-order building — Farm (round 4+) has to exist and pay out first
    effectDescription: 'Converts 2 Food into 1 Gold/turn; round 6+',
  },
  Mine: {
    type: 'Mine',
    allowedTileTypes: ['Mountain'],
    // [DEFAULT — bugfix/balance, see Sawmill's identical note] Was Ore:2/Stone:1 — Ore surplus
    // ranged 700-1000+ across every measured game (one player finished with 9 unupgraded Mines).
    cost: { Ore: 3, Stone: 2 },
    producesResource: 'Ore',
    produceAmount: 1,
    minRound: 3, // basic single-resource producer
    effectDescription: '+1 Ore/turn; round 3+',
  },
  Smithy: {
    type: 'Smithy',
    allowedTileTypes: ['Mountain'],
    cost: { Ore: 3, Stone: 2 },
    minRound: 5, // gear crafting is a mid-game power spike, not an opening move
    // [DEFAULT — balance rework pass 4] The crafting this describes is now real — see
    // CraftGearAction / SMITHY_CRAFT_COSTS above.
    effectDescription: 'Crafts a guaranteed Loot card of a chosen rarity from Ore + Gold (CraftGear, a free Phase 5 action); round 5+',
  },
  TradePost: {
    type: 'TradePost',
    allowedTileTypes: ['Desert'],
    cost: { Gold: 2, Stone: 2 },
    producesResource: 'Gold',
    produceAmount: 1,
    minRound: 3, // basic single-resource producer
    effectDescription: '+1 Gold/turn; unlocks 2:1 bank trade instead of default 4:1; round 3+',
  },
  Dock: {
    type: 'Dock',
    allowedTileTypes: ['River'],
    cost: { Wood: 2, Stone: 1 },
    // [DEFAULT — troop cap rework: dropped the +1 Food/turn] Water tiles no longer produce Food
    // at all — see TileType's TILE_RESOURCE doc comment in types.ts. Dock keeps its boat-unlock,
    // unrelated to the economy change.
    minRound: 3,
    effectDescription: 'Unlocks boat movement; round 3+',
  },
  Watchtower: {
    type: 'Watchtower',
    allowedTileTypes: 'any',
    cost: { Stone: 2, Ore: 2 },
    // [DEFAULT — balance rework pass 4] Upgrade costs are DERIVED from WATCHTOWER_TIERS above
    // (tiers 2-3) rather than duplicated here, so the two can never drift out of sync — that
    // table stays the single source of truth for both cost and effect (dieBonus/dieCap read
    // directly off Building.tier by combat.ts, not through producesResource/produceAmount).
    upgrades: WATCHTOWER_TIERS.slice(1).map((t) => ({ cost: t.cost })),
    effectDescription: '+1 to each defending die (cap 6) in territory combat; upgradable through tier 3 to +3 (cap 8)',
  },
  Barracks: {
    type: 'Barracks',
    allowedTileTypes: ['Plains'], // [DEFAULT — balance rework] was 'any' — now a real investment
    // [DEFAULT — balance rework] Still ~4 rounds of a developing economy's income (10 total),
    // but the Ore share dropped 4 -> 2. Ore only comes from Mountain tiles, so an Ore-heavy
    // price meant "no Mountain in your draws, no army, no Risk layer at all" — the bill should
    // measure how much you've built, not whether one specific terrain showed up.
    cost: { Wood: 3, Ore: 2, Food: 5 },
    // [DEFAULT — balance rework pass 4] Same derive-from-the-tier-table pattern as Watchtower
    // above — BARRACKS_TIERS stays the one place reserveCap/tilesPerSoldier per tier live.
    upgrades: BARRACKS_TIERS.slice(1).map((t) => ({ cost: t.cost })),
    effectDescription:
      'Recruits Soldiers into reserve each round, scaled by owned territory (deploy with DeploySoldiers); ' +
      'Soldiers cost upkeep — 2 Food or 1 Meat per 3; upgradable through tier 3 for a bigger reserve and faster recruiting',
  },
  CowStable: {
    type: 'CowStable',
    allowedTileTypes: ['Plains'], // [DEFAULT — balance rework, new building]
    cost: { Food: 3, Wood: 2 },
    producesResource: 'Meat',
    // [DEFAULT — balance rework] Starts at 1/turn and climbs to 5 across four upgrades (tiers
    // 1-5). Opening at 3 made a single cheap building cover a 9-Soldier army's upkeep outright,
    // so the whole upkeep economy was solved the moment you built one. Starting at 1 makes
    // feeding an army a sustained investment that scales alongside it.
    produceAmount: 1,
    upgrades: [
      { cost: { Food: 3, Wood: 2 }, produceAmount: 2 },
      { cost: { Food: 4, Wood: 3 }, produceAmount: 3 },
      { cost: { Food: 6, Wood: 4, Stone: 2 }, produceAmount: 4 },
      { cost: { Food: 8, Wood: 6, Stone: 4 }, produceAmount: 5 },
    ],
    effectDescription: '+1 Meat/turn (feeds Soldier upkeep); upgradable through tier 5 to +5/turn',
  },
  Capital: {
    type: 'Capital',
    allowedTileTypes: 'starting-tile-only',
    cost: {}, // handled separately via CAPITAL_TIERS, not a normal Build action cost
    // [DEFAULT — balance rework pass 4] "unlocks a second hero" was stale — that feature was
    // removed pre-launch (see selectors.ts's resolveHero doc comment); tier 6, "the Grand
    // Bazaar," is the new capstone instead.
    effectDescription: 'Increases hero max HP and Victory Points each tier; tier 6 ("the Grand Bazaar") is a late-game wonder capstone',
  },
};

/** Mage's -1-per-resource (floor 1 per listed resource) building/level-up discount, §7.2.
 *  [DEFAULT — bugfix, found via a full-game AI balance simulation] `if (!amount) continue`, not
 *  just `if (amount === undefined) continue` — every BuildingDefinition cost is a sparse
 *  ResourceCost (only nonzero entries ever present, e.g. { Wood: 2, Stone: 1 }), so those were
 *  never affected. But LEVEL_UP_COST is a DENSE ResourceBundle (every resource key present, most
 *  at 0 — see its definition above), and this function used to floor EVERY key at 1 regardless of
 *  whether it started at 0, so a Mage's level-up (nominally 2 Food, discounted to 1) was actually
 *  charging 1 of all six resources — a bug this simulation caught by reconciling produced vs.
 *  spent totals per resource type and finding Mage level-ups didn't match the cost table. */
export function applyMageDiscount(cost: ResourceCost): ResourceCost {
  const discounted: ResourceCost = {};
  for (const [resource, amount] of Object.entries(cost)) {
    if (!amount) continue; // 0 or undefined — nothing to discount, and 0-1 would wrongly floor up to 1
    discounted[resource as keyof ResourceCost] = Math.max(1, amount - 1);
  }
  return discounted;
}
