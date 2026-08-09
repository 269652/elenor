/** Derived, read-only queries over GameState. No mutation lives here — reducers.ts owns that. */

import { BASE_HERO_STATS, BUILDING_DEFINITIONS, CAPITAL_TIERS, CARRY_CAPACITY_BASE, CLASS_DEFINITIONS, MOVEMENT_BASE, MOVEMENT_LEVEL5_BONUS, MOVEMENT_LEVEL5_THRESHOLD, TERRAIN_COST_DEFAULT, VP_CAPITAL_TIER, VP_HERO_LEVEL_MILESTONES, VP_PER_BUILDING, VP_PER_LEGENDARY_LOOT, VP_PER_OWNED_TILE, WIN_DOMINATION_MIN_TILES_PER_PLAYER, WIN_DOMINATION_TILE_SHARE, WIN_HERO_LEVEL_THRESHOLD, WIN_MIN_ROUND, WIN_VP_THRESHOLD, xpToReachNextLevel } from './constants';
import { hexKey, hexNeighbors } from './hex';
import { edgeKey, emptyResourceBundle } from './types';
import type {
  BuildingDefinition,
  ClassDefinition,
  ClassName,
  GameState,
  HeroState,
  HexCoord,
  HexKey,
  Player,
  PlayerId,
  ResourceBundle,
  ResourceCost,
  Tile,
  TileType,
  WinCondition,
} from './types';
import { RESOURCE_TYPES } from './types';

export function tileAt(state: GameState, coord: HexCoord): Tile | undefined {
  return state.map[hexKey(coord)];
}

export function findPlayer(state: GameState, playerId: PlayerId): Player {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) throw new Error(`No such player: ${playerId}`);
  return player;
}

/** Resolves which hero an action targets. Every player has exactly one hero — the optional
 *  heroId param survives on BaseAction and every call site for now (it costs nothing to accept
 *  and ignore), a holdover from when a Town-tier-4 unlock gave a player a second hero; that
 *  feature was removed (it never worked properly — see git history) rather than fixed, and
 *  nothing about heroId itself was broken, so there was no reason to also tear out every call
 *  site that still passes one. */
export function resolveHero(player: Player, _heroId?: string): HeroState {
  return player.hero;
}

export function classDefFor(player: Player): ClassDefinition {
  return CLASS_DEFINITIONS[player.classId];
}

/** True if this player owns a tile with a built Dock — the one-way unlock that lets a hero cross
 *  River tiles (HeroState.canBoat). Kept as a query over GameState rather than a per-hero flag
 *  read here because freshHeroState (below) needs to re-derive it for a brand-new hero body. */
export function playerHasDock(state: GameState, playerId: PlayerId): boolean {
  return state.players
    .find((p) => p.id === playerId)
    ?.ownedTiles.some((coord) => state.map[hexKey(coord)]?.building?.type === 'Dock') ?? false;
}

/** [DEFAULT — hero battle participation] Builds a brand-new level-1 hero from scratch: base
 *  stats (BASE_HERO_STATS) plus the two bonuses that belong to the PLAYER rather than to any one
 *  hero's body — the class's permanent bonus (Farmer's heroMaxHpBonus, Warrior's
 *  startingWeaponAttackBonus) and every Town tier's heroMaxHpBonus already reached (capitalTier
 *  1..N, see CAPITAL_TIERS) — plus, optionally, Dock's canBoat unlock. Those are standing
 *  investments the player already paid for, not "the last hero's skills," so they persist across
 *  a hero's death; everything individually earned (level, XP, gear, loot, curses) does not.
 *
 *  Single source of truth for hero creation, used by setup.ts (turn-zero spawn) and permadeath
 *  respawn (reducers.ts's applyMoveSoldiers) — the latter had drifted from setup.ts before this
 *  existed, hardcoding hp:10/attack:1 with none of the above bonuses applied. */
export function freshHeroState(params: {
  id: string;
  ownerId: PlayerId;
  classId: ClassName;
  capitalTier: number;
  capitalTile: HexCoord;
  canBoat?: boolean;
}): HeroState {
  const bonus = CLASS_DEFINITIONS[params.classId].startingBonus;
  const classMaxHpBonus = bonus.kind === 'Farmer' ? bonus.heroMaxHpBonus : 0;
  const classAttackBonus = bonus.kind === 'Warrior' ? bonus.startingWeaponAttackBonus : 0;
  const townHpBonus = CAPITAL_TIERS.slice(0, params.capitalTier).reduce(
    (sum, tier) => sum + ('heroMaxHpBonus' in tier ? tier.heroMaxHpBonus : 0),
    0,
  );
  const maxHp = BASE_HERO_STATS.maxHp + classMaxHpBonus + townHpBonus;
  return {
    id: params.id,
    ownerId: params.ownerId,
    level: BASE_HERO_STATS.level,
    hp: maxHp,
    maxHp,
    attack: BASE_HERO_STATS.attack + classAttackBonus,
    xp: BASE_HERO_STATS.xp,
    xpToNextLevel: xpToReachNextLevel(BASE_HERO_STATS.level),
    position: params.capitalTile,
    movementRange: MOVEMENT_BASE,
    canBoat: params.canBoat ?? false,
    inventory: [],
    equippedLootIds: [],
    activeCurses: [],
    hasHuntedThisRound: false,
    pendingLevelUp: false,
    carriedResources: emptyResourceBundle(),
    visitedTiles: [hexKey(params.capitalTile)],
  };
}

export function buildingDefFor(type: keyof typeof BUILDING_DEFINITIONS): BuildingDefinition {
  return BUILDING_DEFINITIONS[type];
}

// ── Building tiers [DEFAULT — balance rework] ────────────────────────────────────────────────
// A Building's `tier` is 1 when built (stored as undefined until the first upgrade, so treat
// undefined as 1 everywhere). BuildingDefinition.upgrades lists the tiers ABOVE 1 in order, so
// upgrades[tier - 2] is the entry that PRODUCED the current tier. These three helpers are the
// only places that arithmetic should live — reducers, AI, and UI all go through them.

/** Highest tier this building type can reach: 1 if it has no upgrades, else 1 + upgrade count. */
export function maxTierFor(def: BuildingDefinition): number {
  return 1 + (def.upgrades?.length ?? 0);
}

/** Current tier of a placed building, normalizing the undefined-means-1 convention. */
export function tierOf(building: { tier?: number }): number {
  return building.tier ?? 1;
}

/** What this building yields per round at `tier`. Tier 1 uses the base produceAmount; higher
 *  tiers read the matching upgrades entry. Clamped, so an out-of-range tier can't return
 *  undefined and silently poison production arithmetic with NaN. */
export function produceAmountForTier(def: BuildingDefinition, tier: number): number {
  const base = def.produceAmount ?? 0;
  if (tier <= 1 || !def.upgrades?.length) return base;
  const capped = Math.min(tier, maxTierFor(def));
  return def.upgrades[capped - 2]?.produceAmount ?? base;
}

/** The upgrade entry that would take a building from `currentTier` to the next one, or null if
 *  it's already maxed (or was never upgradable). */
export function nextUpgradeFor(def: BuildingDefinition, currentTier: number): { cost: ResourceCost; produceAmount: number } | null {
  if (!def.upgrades?.length || currentTier >= maxTierFor(def)) return null;
  return def.upgrades[currentTier - 1] ?? null;
}

export function hasExtraCombatDie(player: Player): boolean {
  const bonus = classDefFor(player).startingBonus;
  return bonus.kind === 'Warrior';
}

/** Volcano narrates as Ashland once tamed (§6.1) — every resource/building/terrain lookup
 *  should go through this instead of reading `tile.type` directly. */
export function effectiveTileType(tile: Tile): TileType {
  if (tile.type === 'Volcano' && tile.isTamed) return 'Ashland';
  return tile.type;
}

export function gearBonus(hero: HeroState): number {
  return hero.inventory
    .filter((loot) => hero.equippedLootIds.includes(loot.id))
    .reduce((sum, loot) => sum + loot.combatBonus, 0);
}

export function equippedMovementBonus(hero: HeroState): number {
  return hero.inventory
    .filter((loot) => hero.equippedLootIds.includes(loot.id))
    .reduce((sum, loot) => sum + (loot.movementBonus ?? 0), 0);
}

/** §4.1 movementPoints formula. */
export function movementRangeFor(hero: HeroState): number {
  const levelBonus = hero.level >= MOVEMENT_LEVEL5_THRESHOLD ? MOVEMENT_LEVEL5_BONUS : 0;
  return MOVEMENT_BASE + levelBonus + equippedMovementBonus(hero);
}

/** Total carry capacity — CARRY_CAPACITY_BASE + hero level (see constants.ts). */
export function carryCapacityFor(hero: HeroState): number {
  return CARRY_CAPACITY_BASE + hero.level;
}

export function totalCarried(hero: HeroState): number {
  return RESOURCE_TYPES.reduce((sum, r) => sum + hero.carriedResources[r], 0);
}

export function remainingCarryCapacity(hero: HeroState): number {
  return Math.max(0, carryCapacityFor(hero) - totalCarried(hero));
}

export function canAffordFrom(bundle: ResourceBundle, cost: ResourceCost): boolean {
  return RESOURCE_TYPES.every((r) => bundle[r] >= (cost[r] ?? 0));
}

/** §4.2 terrain cost to enter `to` from wherever the hero currently is, for `actor`.
 *  Returns null if the hex is impassable for this hero right now. */
export function terrainCostToEnter(state: GameState, actor: Player, to: HexCoord): number | null {
  const tile = tileAt(state, to);
  if (!tile) return null; // unplaced hex — nothing to walk onto yet

  const type = effectiveTileType(tile);

  if (type === 'River') {
    return actor.hero.canBoat ? TERRAIN_COST_DEFAULT : null;
  }

  if (tile.ownerId && tile.ownerId !== actor.id) {
    // Rival-owned: impassable to STOP on, except a Rogue may pass through, or anyone may
    // step onto a tile hosting a rival hero specifically to initiate a duel (§6.2) —
    // callers distinguish "pass through" vs "stop here" themselves using this cost plus
    // their own step-index bookkeeping; this function only says whether entry is possible.
    const isRogue = classDefFor(actor).startingBonus.kind === 'Rogue';
    const rivalHeroHere = state.players.some(
      (p) => p.id === tile.ownerId && p.hero.position.q === to.q && p.hero.position.r === to.r
    );
    if (!isRogue && !rivalHeroHere) return null;
    return TERRAIN_COST_DEFAULT;
  }

  return TERRAIN_COST_DEFAULT;
}

export interface PathCheckResult {
  legal: boolean;
  totalCost: number;
  reason?: string;
}

/** Validates a full MoveHeroAction path per §4.1/§4.2: each step must be adjacent to the
 *  previous, each step must be enterable, non-Rogue actors can only STOP on a rival tile if
 *  it hosts a rival hero (and only as the final step), and total cost must fit movementRange. */
export function checkMovePath(state: GameState, actor: Player, hero: HeroState, path: HexCoord[]): PathCheckResult {
  if (path.length === 0) return { legal: false, totalCost: 0, reason: 'Empty path' };

  let cost = 0;
  let from = hero.position;
  const isRogue = classDefFor(actor).startingBonus.kind === 'Rogue';

  for (let i = 0; i < path.length; i++) {
    const step = path[i];
    const dq = Math.abs(step.q - from.q);
    const dr = Math.abs(step.r - from.r);
    const dqr = Math.abs(step.q - from.q + (step.r - from.r));
    const distance = (dq + dr + dqr) / 2;
    if (distance !== 1) return { legal: false, totalCost: cost, reason: `Step ${i} is not adjacent` };

    const stepCost = terrainCostToEnter(state, actor, step);
    if (stepCost === null) return { legal: false, totalCost: cost, reason: `Step ${i} is impassable` };

    const isFinalStep = i === path.length - 1;
    const tile = tileAt(state, step);
    const isRivalOwned = !!tile?.ownerId && tile.ownerId !== actor.id;
    if (isRivalOwned && !isFinalStep && !isRogue) {
      return { legal: false, totalCost: cost, reason: 'Cannot stop on/pass through a rival tile without Rogue' };
    }

    cost += stepCost;
    from = step;
  }

  const range = movementRangeFor(hero);
  if (cost > range) return { legal: false, totalCost: cost, reason: `Path costs ${cost}, exceeds movement range ${range}` };

  return { legal: true, totalCost: cost };
}

export function ownedTileKeys(player: Player): Set<string> {
  return new Set(player.ownedTiles.map(hexKey));
}

// ── Roads [DEFAULT — balance rework pass 3] ─────────────────────────────────────────────────

export function hasRoadBetween(state: GameState, playerId: PlayerId, a: HexCoord, b: HexCoord): boolean {
  return state.roads[edgeKey(a, b)] === playerId;
}

/** Every tile the player has joined to their Capital by an unbroken chain of their OWN roads,
 *  travelling only over tiles they own.
 *
 *  The Capital is the ANCHOR of the network, not a member of it — the returned set deliberately
 *  excludes it. The rule is "a tile with a road connecting it to your town", so the town itself
 *  isn't something a road connects to anything; including it would hand every player free
 *  automatic income from their starting tile before they'd laid a single road, quietly repealing
 *  the collect-and-deposit economy for the one tile everyone is guaranteed to own.
 *
 *  Traversal refuses to cross a tile the player doesn't own: a supply line running through rival
 *  or neutral territory would collect resources across a border nobody controls. Losing a
 *  mid-chain tile to an ArmyVsTerritory capture therefore severs everything beyond it — which is
 *  the point, and makes a road network a thing worth attacking. */
export function roadConnectedTiles(state: GameState, player: Player): Set<HexKey> {
  const connected = new Set<HexKey>();
  const owned = ownedTileKeys(player);
  const capitalKey = hexKey(player.capitalTile);
  if (!owned.has(capitalKey)) return connected; // Capital captured — the whole network is dead

  const visited = new Set<HexKey>([capitalKey]);
  const queue: HexCoord[] = [player.capitalTile];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const neighbor of hexNeighbors(current)) {
      const key = hexKey(neighbor);
      if (visited.has(key) || !owned.has(key)) continue;
      if (!hasRoadBetween(state, player.id, current, neighbor)) continue;
      visited.add(key);
      connected.add(key); // anchor excluded: `visited` seeds with the Capital, `connected` doesn't
      queue.push(neighbor);
    }
  }
  return connected;
}

export function isAdjacentToOwned(state: GameState, player: Player, coord: HexCoord): boolean {
  return hexNeighbors(coord).some((n) => {
    const t = tileAt(state, n);
    return t?.ownerId === player.id;
  });
}

/** §10 Victory Point Scoring Table, excluding the per-building row (that needs a map lookup —
 *  see computeAllVictoryPoints below, which is the one reducers/UI should actually call). */
export function computeVictoryPoints(player: Player): number {
  let vp = player.ownedTiles.length * VP_PER_OWNED_TILE;

  // [DEFAULT — territory rework] Generalized from a hardcoded 2-tier check to loop the whole
  // VP_CAPITAL_TIER table, since the Town now runs 5 tiers deep (constants.ts's CAPITAL_TIERS).
  for (const [tierStr, bonus] of Object.entries(VP_CAPITAL_TIER)) {
    if (player.capitalTier >= Number(tierStr)) vp += bonus;
  }

  for (const [levelStr, bonus] of Object.entries(VP_HERO_LEVEL_MILESTONES)) {
    const level = Number(levelStr);
    if (player.hero.level >= level) vp += bonus;
  }

  const legendaryCount = player.hero.inventory.filter((l) => l.rarity === 'Legendary').length;
  vp += legendaryCount * VP_PER_LEGENDARY_LOOT;

  return vp;
}

/** Full VP calc including per-building VP, which needs the map. Use this one; the plain
 *  computeVictoryPoints above is exported for isolated unit tests of the non-map-dependent
 *  portions of the formula. */
export function computeAllVictoryPoints(state: GameState, player: Player): number {
  let vp = computeVictoryPoints(player);
  for (const coord of player.ownedTiles) {
    const tile = tileAt(state, coord);
    if (tile?.building && tile.building.type !== 'Capital') vp += VP_PER_BUILDING;
  }
  return vp;
}

export function totalPlacedTiles(state: GameState): number {
  return Object.keys(state.map).length;
}

/** §11 win-condition trigger check, run at round end. Returns the winner if any condition
 *  was triggered this round, else null. Ties broken by VP, then by earlier turn-order
 *  position (§11 step 4). */
export function checkWinConditions(state: GameState): { winnerId: PlayerId; winCondition: WinCondition } | null {
  const activePlayers = state.players.filter((p) => !p.isEliminated);
  const totalTiles = totalPlacedTiles(state);
  // The 60% share is meaningless on a barely-developed board — see constants.ts's doc comment
  // on WIN_DOMINATION_MIN_TILES_PER_PLAYER for why this gate exists.
  const boardDevelopedEnoughForShareCheck = totalTiles >= state.players.length * WIN_DOMINATION_MIN_TILES_PER_PLAYER;
  // [DEFAULT — balance rework] Threshold wins can't land before the mid-game exists at all —
  // see constants.ts's WIN_MIN_ROUND. Conquest is exempt on purpose (handled below).
  const pastMinRound = state.roundNumber >= WIN_MIN_ROUND;

  const remainingOpponentsEliminated = (p: Player) => activePlayers.length === 1 && activePlayers[0].id === p.id && state.players.length > 1;

  const triggered: { playerId: PlayerId; condition: WinCondition; vp: number }[] = [];

  for (const player of activePlayers) {
    const vp = computeAllVictoryPoints(state, player);
    const ownedShare = totalTiles > 0 ? player.ownedTiles.length / totalTiles : 0;

    if (pastMinRound && vp >= WIN_VP_THRESHOLD) triggered.push({ playerId: player.id, condition: 'VictoryPoints', vp });
    const shareWin = pastMinRound && boardDevelopedEnoughForShareCheck && ownedShare >= WIN_DOMINATION_TILE_SHARE;
    // Wiping out every rival ends the game whenever it happens — there is nobody left to keep
    // playing against, so WIN_MIN_ROUND deliberately does not apply to this path.
    if (shareWin || remainingOpponentsEliminated(player)) {
      triggered.push({ playerId: player.id, condition: 'Domination', vp });
    }
    if (pastMinRound && player.hero.level >= WIN_HERO_LEVEL_THRESHOLD) {
      triggered.push({ playerId: player.id, condition: 'HeroLevelRace', vp });
    }
  }

  if (triggered.length === 0) return null;
  if (triggered.length === 1) return { winnerId: triggered[0].playerId, winCondition: triggered[0].condition };

  const byVpDesc = [...triggered].sort((a, b) => {
    if (b.vp !== a.vp) return b.vp - a.vp;
    return state.turnOrder.indexOf(a.playerId) - state.turnOrder.indexOf(b.playerId);
  });
  const top = byVpDesc[0];
  return { winnerId: top.playerId, winCondition: top.condition };
}
