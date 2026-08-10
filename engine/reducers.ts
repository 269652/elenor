/**
 * Per-phase reducer logic. Every `apply*` function validates its action, then uses Immer's
 * `produce` to compute the next state immutably. `reducer.ts` is the thin dispatcher that
 * routes an `Action` to the right function here; keep validation errors as `IllegalActionError`
 * so callers (server/UI) can distinguish "illegal move" from "the engine is broken."
 *
 * A few small, explicitly-documented gaps in docs/rules-reference.md are resolved here with a
 * concrete v1 choice rather than left ambiguous — each is called out inline where it happens:
 * hero-defeat/respawn (never specified), PvP-steal target choice (the action shape has no
 * field for it), and Barracks march-then-attack logistics (simplified to "attack directly
 * from the Barracks tile").
 *
 * RESOURCE ECONOMY (post-launch redesign, supersedes rules-reference.md §2's original
 * "auto-bank in Phase 0" model — see docs/rules-reference.md's changelog note at the top):
 *   1. At the start of the active player's Phase 3, every owned tile accumulates its base
 *      resource (+ a matching production building's bonus) into `Tile.stockpile`, capped per
 *      resource type (TILE_STOCKPILE_CAP). Phase 0 is now a pure pass-through — no player
 *      action, and no resource effect either.
 *   2. A hero standing on an owned tile with a non-empty stockpile can spend a Gather action
 *      to collect from it into their own `carriedResources`, bounded by carryCapacityFor(hero).
 *   3. Carried resources pay for a Build/BuyMilitia/Capital-upgrade action targeting the
 *      hero's CURRENT tile directly. Spending anywhere else — or LevelUpHero, which has no
 *      tile at all — draws only from the player's banked `resources` ("wallet"). A hero
 *      standing at their Capital can move carried resources into the wallet via
 *      DepositResourcesAction (a free action, like Equip/Unequip).
 *   4. Forage/Hunt/RogueSteal (§5) and the Hero-vs-Hero resource steal (§6.2) now add to /
 *      take from carried inventories rather than the wallet directly, for consistency.
 *
 * BALANCE REWORK (post-launch, on top of the above): no more starting resource stockpile;
 * Farm/Quarry are round-4+-gated and each carry one upgrade tier; Barracks is Plains-only,
 * costs far more, and no longer sells Militia — it produces Soldiers passively (see
 * accumulateTileProduction), which DeploySoldiers reassigns and which cost per-round upkeep
 * (resolveSoldierUpkeep) payable in Food or the new Meat resource (Cow Stable). See each
 * touched function below for specifics, all tagged [DEFAULT — balance rework].
 */

import { produce } from 'immer';
import { getMonsterById } from './catalogs';
import {
  resolveArmyVsTerritory,
  resolveHeroVsHero,
  resolveHeroVsMonster,
  resolveTameVolcano,
  rollHeroAttack,
  type HeroBattleDie,
} from './combat';
import {
  applyMageDiscount,
  ASHLAND_QUARRY_PRODUCES_ON_EVEN_ROUNDS_ONLY,
  BARRACKS_RESERVE_CAP,
  BARRACKS_TIERS,
  BUILDING_DEFINITIONS,
  CAPITAL_TIERS,
  CLASS_DEFINITIONS,
  GEAR_SLOT_COUNT,
  HERO_BATTLE_XP_ON_WIN,
  LEVEL_UP_COST,
  LEVEL_UP_MAX_HP_BONUS,
  MEAT_UPKEEP_VALUE,
  LOOT_SELL_TROOPS,
  MIN_SOLDIERS_LEFT_BEHIND,
  ROAD_COST,
  SMITHY_CRAFT_COSTS,
  SOLDIER_UPKEEP_FOOD_PER_GROUP,
  SOLDIER_UPKEEP_GROUP_SIZE,
  soldiersPerRoundFor,
  TERRITORY_CLAIM_ROUNDS,
  troopCapFor,
  TILE_STOCKPILE_CAP,
  lootRarityForMonsterLevel,
  soldierUpkeepUnits,
  xpToReachNextLevel,
} from './constants';
import { discardMonster, drawBadStuff, drawDoor, drawLoot, drawMonster, drawTile } from './decks';
import { hexKey, isAdjacent } from './hex';
import { RngStream } from './rng';
import {
  buildingDefFor,
  carryCapacityFor,
  checkMovePath,
  checkWinConditions,
  classDefFor,
  effectiveTileType,
  findPlayer,
  freshHeroState,
  isAdjacentToOwned,
  movementRangeFor,
  nextUpgradeFor,
  playerHasDock,
  roadConnectedTiles,
  produceAmountForTier,
  resolveHero,
  tierOf,
  tileAt,
  totalCarried,
} from './selectors';
import {
  edgeKey,
  emptyResourceBundle,
  IllegalActionError,
  Phase,
  PHASE_LABEL,
  RESOURCE_TYPES,
  TILE_RESOURCE,
  type BuildBuildingAction,
  type BuildRoadAction,
  type CraftGearAction,
  type SellLootAction,
  type DeploySoldiersAction,
  type MoveSoldiersAction,
  type DepositResourcesAction,
  type DrawTileAction,
  type EndTurnAction,
  type EquipLootAction,
  type FightAction,
  type GameEvent,
  type GameState,
  type GatherAction,
  type HeroState,
  type HexCoord,
  type LevelUpHeroAction,
  type MoveHeroAction,
  type Player,
  type PlayerId,
  type PlaceTileAction,
  type ResourceCost,
  type ResourceType,
  type Tile,
  type TradeWithBankAction,
  type UnequipLootAction,
  type UpgradeBuildingAction,
  type UtilityCard,
} from './types';

// ── Shared helpers ───────────────────────────────────────────────────────────────────────

function requireCurrentPlayer(state: GameState, actorId: PlayerId) {
  if (state.currentPlayerId !== actorId) throw new IllegalActionError(`It is not ${actorId}'s turn`);
  if (state.winnerId) throw new IllegalActionError('The game has already ended');
}

function requirePhase(state: GameState, phase: Phase) {
  if (state.currentPhase !== phase) {
    throw new IllegalActionError(`Action requires ${PHASE_LABEL[phase]}, current phase is ${PHASE_LABEL[state.currentPhase]}`);
  }
}

function pushEvent(draft: GameState, actorId: PlayerId | 'system', type: string, payload: Record<string, unknown>) {
  const event: GameEvent = {
    id: `evt-${draft.eventLog.length}`,
    round: draft.roundNumber,
    phase: draft.currentPhase,
    actorId,
    type,
    payload,
    seq: draft.eventLog.length,
  };
  draft.eventLog.push(event);
}

function sameCoord(a: HexCoord, b: HexCoord): boolean {
  return a.q === b.q && a.r === b.r;
}

/** True if paying for something at `coord` can draw on the hero's carried resources — i.e.
 *  the hero is physically standing there right now. Null coord (e.g. LevelUpHero, which has
 *  no location) always means wallet-only. */
function isLocalToHero(hero: HeroState, coord: HexCoord | null): boolean {
  return coord !== null && sameCoord(hero.position, coord);
}

/** Combined affordability check: wallet always counts; carried resources only count when
 *  paying for something at the hero's current tile (see file header, point 3). */
function combinedAfford(player: Player, hero: HeroState, coord: HexCoord | null, cost: ResourceCost): boolean {
  const local = isLocalToHero(hero, coord);
  return RESOURCE_TYPES.every((r) => player.resources[r] + (local ? hero.carriedResources[r] : 0) >= (cost[r] ?? 0));
}

/** Pays a cost preferring what the hero is physically CARRYING first (if paying for
 *  something at the hero's current tile — spend what's in hand before reaching into the
 *  bank), falling back to the wallet for any remainder. Away from the hero, or for actions
 *  with no tile at all (coord: null, e.g. LevelUpHero), it's wallet-only. Caller must have
 *  already checked combinedAfford. */
function combinedPay(player: Player, hero: HeroState, coord: HexCoord | null, cost: ResourceCost) {
  const local = isLocalToHero(hero, coord);
  for (const r of RESOURCE_TYPES) {
    const need = cost[r] ?? 0;
    if (need === 0) continue;
    const fromCarried = local ? Math.min(hero.carriedResources[r], need) : 0;
    hero.carriedResources[r] -= fromCarried;
    const remainder = need - fromCarried;
    if (remainder > 0) {
      if (player.resources[r] < remainder) throw new IllegalActionError('Insufficient resources'); // combinedAfford should have caught this
      player.resources[r] -= remainder;
    }
  }
}

/** Adds to a hero's carried inventory, clamped by remaining carry capacity. Returns how much
 *  actually fit (may be less than `amount` if near-full). */
function addToCarried(hero: HeroState, resource: ResourceType, amount: number): number {
  const room = Math.max(0, carryCapacityFor(hero) - totalCarried(hero));
  const added = Math.min(amount, room);
  hero.carriedResources[resource] += added;
  return added;
}

function requireCarryRoom(hero: HeroState) {
  if (totalCarried(hero) >= carryCapacityFor(hero)) {
    throw new IllegalActionError('Hero is at full carrying capacity — deposit resources at your Capital first');
  }
}

function addToStockpile(tile: Tile, resource: ResourceType, amount: number) {
  tile.stockpile[resource] = Math.min(TILE_STOCKPILE_CAP, tile.stockpile[resource] + amount);
}

/** Applies XP gain and flags a level-up as earned once the threshold is crossed (the level
 *  itself isn't applied until a Phase 5 LevelUpHeroAction spends the resources, §7.4). Caps
 *  at Level 10 (§8.1's table stops there) — XP earned past the cap is simply not banked. */
function grantXp(hero: HeroState, amount: number) {
  if (hero.level >= 10) return;
  hero.xp += amount;
  if (hero.xp >= xpToReachNextLevel(hero.level)) {
    hero.pendingLevelUp = true;
  }
}

/** Hero HP falling to 0 is never addressed in docs/rules-reference.md — v1 DEFAULT: the hero
 *  is "downed," retreats to its owner's Capital, and heals fully rather than the game having
 *  no defined behavior at 0 HP. */
function applyHeroDamage(hero: HeroState, capitalTile: Player['capitalTile'], damage: number) {
  hero.hp -= damage;
  if (hero.hp <= 0) {
    hero.hp = hero.maxHp;
    hero.position = capitalTile;
  }
}

/** [DEFAULT — hero battle participation, direct request: "if the hero dies a new one is spawned
 *  without any of the items or skills of the last one"] Permadeath specific to HP reaching 0 while
 *  the hero was fighting IN Army vs Territory combat (applyMoveSoldiers) — a deliberately harsher,
 *  entirely separate consequence from applyHeroDamage's "downed" rule above, which still governs
 *  every ordinary monster-fight loss unchanged. Level, XP, gear, loot, and curses are all gone;
 *  the structural bonuses the PLAYER already paid for (class bonus, Town-tier HP, Dock) carry
 *  over onto the replacement via freshHeroState, same as any other fresh hero. */
function respawnHeroFromDeath(draft: GameState, player: Player, hero: HeroState) {
  const fresh = freshHeroState({
    id: hero.id,
    ownerId: player.id,
    classId: player.classId,
    capitalTier: player.capitalTier,
    capitalTile: player.capitalTile,
    canBoat: playerHasDock(draft, player.id),
  });
  player.hero = fresh;
  pushEvent(draft, player.id, 'HeroDied', { heroId: hero.id, respawnedAsId: fresh.id, cause: 'ArmyVsTerritory' });
}

function findTileMut(draft: GameState, coord: { q: number; r: number }): Tile {
  const tile = draft.map[hexKey(coord)];
  if (!tile) throw new IllegalActionError('No tile at that coordinate');
  return tile;
}

function findPlayerMut(draft: GameState, playerId: PlayerId): Player {
  const p = draft.players.find((pl) => pl.id === playerId);
  if (!p) throw new IllegalActionError(`No such player: ${playerId}`);
  return p;
}

// See selectors.ts's resolveHero for why heroId stays as an accepted-but-ignored param.
function heroMut(player: Player, _heroId?: string): HeroState {
  return player.hero;
}

/** Runs round-end win-condition checks (§11) — call this exactly when turnOrder wraps back
 *  to its first player, i.e. every seated player has completed a turn this round. */
function maybeEndRound(draft: GameState) {
  const result = checkWinConditions(draft);
  if (result) {
    draft.winnerId = result.winnerId;
    draft.winCondition = result.winCondition;
    draft.status = 'finished';
    pushEvent(draft, 'system', 'GameEnded', result);
  }
}

// ── Phase 0 — Production (now a pure pass-through — see file header) ───────────────────────

/** Starts `playerId`'s turn: resets per-turn/per-round bookkeeping and settles on Phase 1 for
 *  them to act on. Phase 0 has no player action AND (as of the resource-economy redesign) no
 *  automatic effect either — tile production now happens at Phase 3 entry, see
 *  accumulateTileProduction below. Used by createGame for the very first turn and by
 *  EndTurn/AdvancePhase whenever play passes to the next player. */
export function resolveProductionForNewTurn(state: GameState, playerId: PlayerId): GameState {
  return produce(state, (draft) => {
    draft.currentPlayerId = playerId;
    draft.currentPhase = Phase.Production;
    draft.hasFoughtThisTurn = false;
    draft.hasBuiltThisTurn = false;
    draft.hasMovedThisTurn = false;
    draft.pendingTileDraw = null;
    draft.hasPlacedTileThisTurn = false;

    const player = findPlayerMut(draft, playerId);
    // "Once per round" trackers reset once per round; since a player takes exactly one turn
    // per round, resetting at the start of their own turn is equivalent.
    player.hero.hasHuntedThisRound = false;
    player.hasStolenThisRound = false;
    player.foragedTilesThisRound = [];

    // [DEFAULT — territory rework] Occupations that survived a full round convert to ownership
    // BEFORE upkeep and production, so a tile taken last turn pays its new owner this turn.
    claimHeldTerritory(draft, playerId);

    // [DEFAULT — balance rework] Soldier upkeep is charged once per player-turn, same cadence
    // as the "once per round" resets just above — see resolveSoldierUpkeep for the bill and
    // desertion-on-shortfall rule.
    resolveSoldierUpkeep(draft, playerId);

    // Phase 0 has no player action and no automatic effect — settle on Phase 1 immediately.
    draft.currentPhase = Phase.DrawAndPlaceTile;
    pushEvent(draft, playerId, 'PhaseAdvanced', { to: Phase.DrawAndPlaceTile });
  });
}

/** [DEFAULT — balance rework] Charges upkeep for every Soldier the player controls anywhere
 *  on their territory (deployed garrisons AND any still-undeployed Barracks reserve — an army
 *  eats whether or not you've gotten around to assigning it). Cost is
 *  ceil(totalSoldiers / SOLDIER_UPKEEP_GROUP_SIZE) * SOLDIER_UPKEEP_FOOD_PER_GROUP
 *  food-equivalent units (a partial trailing group still costs a full group), payable in Food
 *  (1 unit each) and/or Meat (MEAT_UPKEEP_VALUE units each) in any combination — drawn from the
 *  WALLET only, same as any other away-from-hero cost, so stockpiled-but-uncollected Food/Meat
 *  sitting on a tile does NOT cover this; it must be deposited first (§ resource economy note
 *  at the top of this file). If the wallet can't cover the full bill, every Food and Meat the
 *  player has is spent trying, and enough Soldiers desert to fit what was actually affordable
 *  — trimmed from the LARGEST garrisons first (a starving army thins its biggest camps before
 *  its smallest outposts), deterministic so replay stays reproducible without needing RNG. */
function resolveSoldierUpkeep(draft: GameState, playerId: PlayerId) {
  const player = findPlayerMut(draft, playerId);
  // [DEFAULT — territory rework] Charged on the troops you OWN, wherever they are standing —
  // including an invasion force parked on someone else's ground. Scanning ownedTiles instead
  // would let an army live rent-free the moment it crossed a border, which is precisely when
  // it should be most expensive to sustain.
  const garrisonedCoords = Object.values(draft.map)
    .filter((t) => garrisonOwnerOf(t) === playerId)
    .map((t) => t.coord);
  const totalSoldiers = garrisonedCoords.reduce((sum, c) => sum + (draft.map[hexKey(c)]!.militiaCount ?? 0), 0);
  if (totalSoldiers === 0) return;

  const needed = soldierUpkeepUnits(totalSoldiers); // food-equivalent units

  // [DEFAULT — balance rework pass 2] MEAT IS SPENT FIRST, Food only for the remainder. Meat
  // has exactly one use in the whole game — feeding soldiers — while Food also buys buildings,
  // Capital tiers, and hero level-ups. Charging Food first (as this did originally) meant a
  // standing army quietly drained the wallet to zero every single turn, and a measured all-AI
  // sweep showed the downstream effect plainly: heroes banked XP and earned level-ups they could
  // then never pay the 1-Food half of, so nobody leveled past 1 all game and the whole Munchkin
  // progression stalled behind the army economy. Spending the single-purpose resource first is
  // both strictly better play and what a player would naturally expect.
  let remaining = needed;
  let meatUse = Math.min(player.resources.Meat, Math.floor(remaining / MEAT_UPKEEP_VALUE));
  remaining -= meatUse * MEAT_UPKEEP_VALUE;
  const foodUse = Math.min(player.resources.Food, remaining);
  remaining -= foodUse;
  // A single leftover unit (the bill is even, but Food ran out mid-way) can still be covered by
  // one more Meat, overpaying by one unit — better than deserting soldiers over a rounding edge.
  if (remaining > 0 && player.resources.Meat > meatUse) {
    meatUse += 1;
    remaining -= MEAT_UPKEEP_VALUE;
  }
  const shortfall = remaining;

  if (shortfall <= 0) {
    player.resources.Food -= foodUse;
    player.resources.Meat -= meatUse;
    pushEvent(draft, playerId, 'SoldierUpkeepPaid', { totalSoldiers, foodSpent: foodUse, meatSpent: meatUse });
    return;
  }

  // Can't fully afford it — spend everything trying, then desert down to what that actually pays for.
  const paidEquivalent = player.resources.Food + player.resources.Meat * MEAT_UPKEEP_VALUE;
  player.resources.Food = 0;
  player.resources.Meat = 0;
  const sustainableSoldiers = Math.floor(paidEquivalent / SOLDIER_UPKEEP_FOOD_PER_GROUP) * SOLDIER_UPKEEP_GROUP_SIZE;
  let desertions = Math.max(0, totalSoldiers - sustainableSoldiers);
  const totalDesertions = desertions;

  const byGarrisonDesc = [...garrisonedCoords].sort(
    (a, b) => (draft.map[hexKey(b)]!.militiaCount ?? 0) - (draft.map[hexKey(a)]!.militiaCount ?? 0)
  );
  for (const coord of byGarrisonDesc) {
    if (desertions <= 0) break;
    const t = findTileMut(draft, coord);
    const cut = Math.min(t.militiaCount ?? 0, desertions);
    t.militiaCount = (t.militiaCount ?? 0) - cut;
    desertions -= cut;
  }

  pushEvent(draft, playerId, 'SoldiersDeserted', { totalSoldiersBefore: totalSoldiers, desertions: totalDesertions });
}

/** Fires once, automatically, the moment the active player's Phase 3 begins (see
 *  applyAdvancePhase). Every owned tile's base resource (Forest->Wood, etc., via
 *  TILE_RESOURCE) plus any matching production building's bonus accumulates into that tile's
 *  stockpile, capped at TILE_STOCKPILE_CAP per resource. This REPLACES the old Phase-0
 *  auto-bank-to-wallet model — nothing is given to the player directly; a hero must visit and
 *  collect (applyGather's 'CollectResources' kind). */
function accumulateTileProduction(draft: GameState, playerId: PlayerId) {
  const player = findPlayerMut(draft, playerId);
  const classBonus = CLASS_DEFINITIONS[player.classId].startingBonus;

  for (const coord of player.ownedTiles) {
    const tile = draft.map[hexKey(coord)];
    if (!tile) continue;
    const effType = effectiveTileType(tile);

    const baseResource = TILE_RESOURCE[effType];
    if (baseResource) addToStockpile(tile, baseResource, 1);

    const building = tile.building;
    if (building) {
      const def = BUILDING_DEFINITIONS[building.type];
      if (def.producesResource && def.produceAmount) {
        // [DEFAULT — balance rework] Tiers above 1 (via UpgradeBuildingAction) read their rate
        // from def.upgrades — see selectors.ts's produceAmountForTier.
        const amount = produceAmountForTier(def, tierOf(building));
        const weakAshlandQuarry =
          building.type === 'Quarry' && effType === 'Ashland' && ASHLAND_QUARRY_PRODUCES_ON_EVEN_ROUNDS_ONLY && draft.roundNumber % 2 !== 0;
        if (!weakAshlandQuarry) addToStockpile(tile, def.producesResource, amount);
      }
      if (building.type === 'Windmill' && tile.stockpile.Food >= 2) {
        tile.stockpile.Food -= 2;
        addToStockpile(tile, 'Gold', 1);
      }
      // [DEFAULT — balance rework] Barracks produces Soldiers, not a ResourceType, so it can't
      // go through the producesResource/produceAmount path above — same shape as Windmill's
      // special-case just above, but writes to militiaCount instead of stockpile.
      //
      // [pass 2] Recruitment is THROTTLED by the ability to feed the army you already have.
      // Production is automatic and can't be declined, so without this a Barracks kept churning
      // out soldiers straight into a famine: a measured sweep showed desertion events routinely
      // OUTNUMBERING successful upkeep payments 2:1, with the recruit-starve-desert cycle
      // draining every player's Food to zero every round and starving the rest of the game
      // (buildings, Capital tiers, hero level-ups) along with it. Gating on the CURRENT army's
      // bill — not the post-recruitment one — means a solvent player always keeps growing, and
      // a starving one stops digging. Self-regulating, and it reads the way a player would
      // expect: your barracks stops taking recruits when you can't feed the troops you have.
      // [BUG FIX — territory rework] A Barracks under enemy occupation must not recruit for its
      // owner OR for the occupier: not for the owner because they don't hold the ground right
      // now, and — this was the actual exploit — not for the occupier either, since the
      // unconditional write below added to militiaCount regardless of garrisonOwnerId, so an
      // invader who parked troops on your Barracks got THEIR reserve refilled by YOUR building
      // every single round. Recruitment simply pauses while the tile is contested; whoever wins
      // it back starts from wherever the standoff left the garrison.
      //
      // garrisonOwnerOf returns null for an EMPTY tile (militiaCount 0), not just an enemy-held
      // one — a brand-new Barracks starts empty, so checking `!== player.id` alone would read
      // "nobody's here yet" as "an enemy is here" and permanently block its very first recruit.
      // The actual condition is narrower: contested means SOMEONE is here and it isn't you.
      const barracksGarrison = garrisonOwnerOf(tile);
      const barracksContested = barracksGarrison !== null && barracksGarrison !== player.id;
      if (building.type === 'Barracks' && barracksContested) {
        // fall through — no recruitment this round
      } else if (building.type === 'Barracks') {
        // [BUG FIX — territory rework] Matches resolveSoldierUpkeep's definition of "your army"
        // exactly: every tile you GARRISON, not every tile you own. The two were computing
        // different totals (this used to sum ownedTiles only, missing expeditionary forces
        // abroad and counting an enemy's occupying garrison on your own soil as yours), so the
        // recruitment throttle and the upkeep bill it's meant to track could silently disagree.
        const currentArmy = Object.values(draft.map)
          .filter((t) => garrisonOwnerOf(t) === player.id)
          .reduce((sum, t) => sum + (t.militiaCount ?? 0), 0);
        const foodEquivalentOnHand = player.resources.Food + player.resources.Meat * MEAT_UPKEEP_VALUE;
        if (foodEquivalentOnHand >= soldierUpkeepUnits(currentArmy)) {
          // [DEFAULT — balance rework pass 4] A Barracks's own tier (BARRACKS_TIERS,
          // constants.ts) — not just territory — now sets its recruiting rate and reserve cap.
          // Tier 1 reads BARRACKS_RESERVE_CAP/soldiersPerRoundFor's default divisor exactly as
          // before an upgrade; the fallback (?? BARRACKS_TIERS[0]) only matters for an
          // out-of-range tier and can never actually be hit in practice.
          const barracksTier = BARRACKS_TIERS[Math.min(tierOf(building), BARRACKS_TIERS.length) - 1] ?? BARRACKS_TIERS[0];
          // Risk-style: reinforcements scale with how much ground you hold — see
          // constants.ts's soldiersPerRoundFor.
          const rawRecruits = soldiersPerRoundFor(player.ownedTiles.length, barracksTier.tilesPerSoldier);
          // [DEFAULT — troop cap] The TOTAL army (currentArmy, same garrisonOwnerOf basis as the
          // upkeep bill above) can never exceed troopCapFor(waterTiles owned) — this is the one
          // place new Soldiers are ever created, so it's the only place that needs the clamp;
          // every other militiaCount writer only moves or removes troops that already existed.
          const waterTiles = player.ownedTiles.filter((c) => {
            const t = draft.map[hexKey(c)];
            return !!t && effectiveTileType(t) === 'River';
          }).length;
          const roomUnderTroopCap = Math.max(0, troopCapFor(waterTiles) - currentArmy);
          const recruits = Math.min(rawRecruits, roomUnderTroopCap);
          tile.militiaCount = Math.min(barracksTier.reserveCap, (tile.militiaCount ?? 0) + recruits);
          tile.garrisonOwnerId = player.id;
        }
      }
    }

    // Woodcutter's persistent per-Forest-tile bonus (see engine/setup.ts header for why this
    // replaces a literal pre-built Sawmill).
    if (classBonus.kind === 'Woodcutter' && tile.type === 'Forest') {
      addToStockpile(tile, 'Wood', classBonus.forestWoodBonusPerTile);
    }
  }

  // Farmer's flat baseline isn't tied to any one tile in the original design — it lands on
  // the Capital's stockpile (the player's one guaranteed tile) each round.
  if (classBonus.kind === 'Farmer') {
    const capitalTile = draft.map[hexKey(player.capitalTile)];
    if (capitalTile) addToStockpile(capitalTile, 'Food', classBonus.foodPerTurnBonus);
  }

  collectRoadConnectedTiles(draft, playerId);

  pushEvent(draft, playerId, 'TileProductionAccumulated', {});
}

/** [DEFAULT — roads] Sweeps the stockpile of every owned tile joined to the Capital by the
 *  player's own road network straight into their wallet — no hero visit, no carry-capacity
 *  limit, no deposit trip.
 *
 *  This is the release valve for a structural problem in the design: one hero, at movement 2, was
 *  simultaneously the empire's entire logistics corps AND its adventurer, so hauling crowded out
 *  everything else and the Munchkin layer never got played. Roads let a player buy their way out
 *  of the hauling loop — and because the network only reaches where they've paid to extend it,
 *  and severs when a mid-chain tile is captured, it stays a real decision rather than a blanket
 *  upgrade. Runs immediately after production accumulates, so a connected tile never sits on a
 *  pile for even one round. */
function collectRoadConnectedTiles(draft: GameState, playerId: PlayerId) {
  const player = findPlayerMut(draft, playerId);
  const connected = roadConnectedTiles(draft, player);
  const collected: Partial<Record<ResourceType, number>> = {};
  let anything = false;

  for (const key of connected) {
    const tile = draft.map[key as keyof typeof draft.map];
    if (!tile) continue;
    for (const r of RESOURCE_TYPES) {
      const amount = tile.stockpile[r];
      if (amount <= 0) continue;
      player.resources[r] += amount;
      tile.stockpile[r] = 0;
      collected[r] = (collected[r] ?? 0) + amount;
      anything = true;
    }
  }

  if (anything) {
    pushEvent(draft, playerId, 'RoadSupplyCollected', { tiles: connected.size, collected });
  }
}

// ── Phase 1 — Draw & Place Tile ─────────────────────────────────────────────────────────────

export function applyDrawTile(state: GameState, action: DrawTileAction): GameState {
  requireCurrentPlayer(state, action.actorId);
  requirePhase(state, Phase.DrawAndPlaceTile);
  if (state.hasPlacedTileThisTurn) throw new IllegalActionError('Already placed a tile this turn (§3: one tile per turn)');
  if (state.pendingTileDraw !== null) throw new IllegalActionError('A tile has already been drawn this turn');

  return produce(state, (draft) => {
    const rng = new RngStream(draft.rngSeed, draft.rngCursor);
    const { tile, deck } = drawTile(draft.tileDeck, rng);
    draft.tileDeck = deck;
    draft.pendingTileDraw = tile;
    draft.rngCursor = rng.cursor;
    pushEvent(draft, action.actorId, 'TileDrawn', { tileType: tile });
  });
}

export function applyPlaceTile(state: GameState, action: PlaceTileAction): GameState {
  requireCurrentPlayer(state, action.actorId);
  requirePhase(state, Phase.DrawAndPlaceTile);
  if (state.pendingTileDraw === null) throw new IllegalActionError('No tile has been drawn yet this turn');
  if (state.pendingTileDraw !== action.tileType) throw new IllegalActionError('tileType does not match the tile drawn this turn');
  if (tileAt(state, action.coord)) throw new IllegalActionError('Target hex is already occupied');
  const player = findPlayer(state, action.actorId);
  if (!isAdjacentToOwned(state, player, action.coord)) throw new IllegalActionError('Placement must be adjacent to a tile you own');

  return produce(state, (draft) => {
    const rng = new RngStream(draft.rngSeed, draft.rngCursor);
    const newTile: Tile = {
      coord: action.coord,
      type: action.tileType,
      ownerId: action.actorId,
      building: null,
      monsterDenCardId: null,
      stockpile: emptyResourceBundle(),
    };
    if (action.tileType === 'Ruins') {
      // Assign this Ruins tile's Monster Den now rather than at Fight time — reconciles
      // data-model.md's persistent Tile.monsterDenCardId ("if undefeated") with rules
      // reference §6.1's "Setup: draw 1 Monster card" by moving WHEN the one-time draw
      // happens without changing its distribution or outcome.
      const { card, deck } = drawMonster(draft.monsterDeck, rng);
      draft.monsterDeck = deck;
      newTile.monsterDenCardId = card.id;
    }
    draft.map[hexKey(action.coord)] = newTile;
    const p = findPlayerMut(draft, action.actorId);
    p.ownedTiles.push(action.coord);
    draft.pendingTileDraw = null;
    draft.hasPlacedTileThisTurn = true;
    draft.rngCursor = rng.cursor;
    pushEvent(draft, action.actorId, 'TilePlaced', { coord: action.coord, tileType: action.tileType });
  });
}

// ── Phase 2 — Move Hero ─────────────────────────────────────────────────────────────────────

export function applyMoveHero(state: GameState, action: MoveHeroAction): GameState {
  requireCurrentPlayer(state, action.actorId);
  requirePhase(state, Phase.MoveHero);
  if (state.hasMovedThisTurn) throw new IllegalActionError('Already moved this turn — submit one path covering the whole move (§4)');
  const player = findPlayer(state, action.actorId);
  const hero = resolveHero(player, action.heroId);
  const check = checkMovePath(state, player, hero, action.path);
  if (!check.legal) throw new IllegalActionError(check.reason ?? 'Illegal move path');

  return produce(state, (draft) => {
    const p = findPlayerMut(draft, action.actorId);
    const h = heroMut(p, action.heroId);
    const destination = action.path[action.path.length - 1];
    h.position = destination;
    draft.hasMovedThisTurn = true;
    pushEvent(draft, action.actorId, 'HeroMoved', { path: action.path, cost: check.totalCost, heroId: h.id });

    // [DEFAULT — Munchkin exploration layer] Only the FINAL destination can trigger a Door draw
    // — tiles merely passed through along the way were never actually "entered." See
    // resolveDoorCardIfNewTile's doc comment for the full draw/resolve flow.
    resolveDoorCardIfNewTile(draft, p.id, h, destination);
  });
}

/** [DEFAULT — Munchkin exploration layer] The core trigger: if `destination` isn't already in
 *  this hero's visitedTiles, mark it visited and draw the next Door card. A Monster card sets
 *  pendingDoorMonster (mandatory, resolved later via a Fight action — see applyFightMonster and
 *  applyAdvancePhase's Phase-4 exit guard); a Utility card resolves immediately, right here,
 *  since it's never something the player chooses whether/when to engage with. */
function resolveDoorCardIfNewTile(draft: GameState, playerId: PlayerId, hero: HeroState, destination: HexCoord) {
  const key = hexKey(destination);
  if (hero.visitedTiles.includes(key)) return;
  hero.visitedTiles.push(key);

  const rng = new RngStream(draft.rngSeed, draft.rngCursor);
  const { card, deck } = drawDoor(draft.doorDeck, rng);
  draft.doorDeck = deck;
  draft.rngCursor = rng.cursor;
  if (!card) return; // deck genuinely exhausted mid-reshuffle — no encounter, nothing to resolve

  if (card.kind === 'Monster') {
    draft.pendingDoorMonster = { heroId: hero.id, coord: destination, monsterCardId: card.monster.id };
    pushEvent(draft, playerId, 'DoorCardDrawn', { heroId: hero.id, coord: destination, kind: 'Monster', monsterId: card.monster.id, monsterName: card.monster.name });
  } else {
    const player = findPlayerMut(draft, playerId);
    applyUtilityEffect(draft, player, hero, rng, card.utility);
    draft.doorDeck.discardPile = [...draft.doorDeck.discardPile, card];
    pushEvent(draft, playerId, 'DoorCardDrawn', { heroId: hero.id, coord: destination, kind: 'Utility', utilityId: card.utility.id, utilityName: card.utility.name, effectKind: card.utility.effectKind });
  }
}

/** The small, closed set of Utility effects — see UtilityEffectKind's doc comment in types.ts
 *  for why this stays a switch over a handful of kinds rather than open-ended per-card logic. */
function applyUtilityEffect(draft: GameState, player: Player, hero: HeroState, rng: RngStream, utility: UtilityCard) {
  const amount = utility.amount ?? 1;
  switch (utility.effectKind) {
    case 'GainWood':
      addToCarried(hero, 'Wood', amount);
      break;
    case 'GainStone':
      addToCarried(hero, 'Stone', amount);
      break;
    case 'GainFood':
      addToCarried(hero, 'Food', amount);
      break;
    case 'GainOre':
      addToCarried(hero, 'Ore', amount);
      break;
    case 'GainMeat':
      addToCarried(hero, 'Meat', amount);
      break;
    case 'GainGold':
      addToCarried(hero, 'Gold', amount);
      break;
    case 'HealHp':
      hero.hp = Math.min(hero.maxHp, hero.hp + amount);
      break;
    case 'DamageHp':
      applyHeroDamage(hero, player.capitalTile, amount);
      break;
    case 'GainXp':
      grantXp(hero, amount);
      break;
    case 'FreeTreasure': {
      // A no-fight treasure find is modest by design — Common only, never the escalating
      // Uncommon/Rare/Legendary rarities a monster kill pays out.
      const { card, deck } = drawLoot(draft.lootDeck, 'Common', rng);
      draft.lootDeck = deck;
      if (card) hero.inventory.push(card);
      break;
    }
    case 'Nothing':
      break; // pure flavor — "the door was stuck" — not every draw needs to be mechanically loaded
  }
}

// ── Phase 3 — Gather ─────────────────────────────────────────────────────────────────────────

const FORAGEABLE_TYPES = new Set(['Forest', 'Plains', 'Hills', 'Mountain', 'Desert']);

export function applyGather(state: GameState, action: GatherAction): GameState {
  requireCurrentPlayer(state, action.actorId);
  requirePhase(state, Phase.Gather);
  const player = findPlayer(state, action.actorId);
  const hero = resolveHero(player, action.heroId);
  if (hero.position.q !== action.coord.q || hero.position.r !== action.coord.r) {
    throw new IllegalActionError('Gather coord must equal the acting hero\'s current position');
  }
  const tile = tileAt(state, action.coord);
  if (!tile) throw new IllegalActionError('No tile there');

  return produce(state, (draft) => {
    const p = findPlayerMut(draft, action.actorId);
    const h = heroMut(p, action.heroId);
    const rng = new RngStream(draft.rngSeed, draft.rngCursor);
    const draftTile = findTileMut(draft, action.coord);

    switch (action.gatherKind) {
      case 'CollectResources': {
        if (draftTile.ownerId !== action.actorId) throw new IllegalActionError('You can only collect from your own tile');
        const hasAnything = RESOURCE_TYPES.some((r) => draftTile.stockpile[r] > 0);
        if (!hasAnything) throw new IllegalActionError('Nothing has accumulated on this tile yet');
        requireCarryRoom(h);
        const collected: Partial<Record<ResourceType, number>> = {};
        for (const r of RESOURCE_TYPES) {
          const available = draftTile.stockpile[r];
          if (available <= 0) continue;
          const added = addToCarried(h, r, available);
          draftTile.stockpile[r] -= added;
          if (added > 0) collected[r] = added;
        }
        pushEvent(draft, action.actorId, 'ResourcesCollected', { coord: action.coord, collected });
        break;
      }
      case 'Forage': {
        const key = hexKey(action.coord);
        if (!FORAGEABLE_TYPES.has(draftTile.type)) throw new IllegalActionError('Cannot forage this tile type');
        if (draftTile.ownerId === action.actorId) throw new IllegalActionError('Cannot forage your own tile');
        if (p.foragedTilesThisRound.includes(key)) throw new IllegalActionError('Already foraged this tile this round');
        requireCarryRoom(h);
        const resource = require_tileResource(draftTile.type);
        addToCarried(h, resource, 1);
        p.foragedTilesThisRound.push(key);
        pushEvent(draft, action.actorId, 'Foraged', { coord: action.coord, resource });
        break;
      }
      case 'LootRuins': {
        if (draftTile.type !== 'Ruins') throw new IllegalActionError('LootRuins requires a Ruins tile');
        if (draftTile.monsterDenCardId !== null) throw new IllegalActionError('This Ruins tile still has an active Monster Den');
        // One hoard per dungeon — see Tile.hasBeenLooted for why this guard exists.
        if (draftTile.hasBeenLooted) throw new IllegalActionError('These Ruins have already been looted');
        draftTile.hasBeenLooted = true;
        const rarity = rng.next() < 0.5 ? 'Common' : 'Uncommon';
        const { card, deck } = drawLoot(draft.lootDeck, rarity, rng);
        draft.lootDeck = deck;
        // Exhausted rarity — the ruins are picked clean. Still a legal, resolved action (it
        // consumed the Gather), just an empty-handed one; see drawLoot's doc comment.
        if (card) h.inventory.push(card);
        pushEvent(draft, action.actorId, 'RuinsLooted', { coord: action.coord, lootCardId: card?.id ?? null });
        break;
      }
      case 'Hunt': {
        if (draftTile.ownerId !== action.actorId || draftTile.building?.type !== 'HuntingLodge') {
          throw new IllegalActionError('Hunt requires your own tile with a built Hunting Lodge');
        }
        requireCarryRoom(h);
        addToCarried(h, 'Food', 1);
        if (!h.hasHuntedThisRound) {
          h.hasHuntedThisRound = true;
          grantXp(h, 1);
        }
        pushEvent(draft, action.actorId, 'Hunted', { coord: action.coord });
        break;
      }
      case 'RogueSteal': {
        if (classDefFor(p).startingBonus.kind !== 'Rogue') throw new IllegalActionError('Only Rogue can steal');
        if (p.hasStolenThisRound) throw new IllegalActionError('Already stolen this round');
        requireCarryRoom(h);
        // Action shape has no target-tile field (see file header) — v1 picks the first
        // adjacent rival-owned tile found, deterministic by neighbor order, and steals from
        // ITS STOCKPILE (resources sitting unclaimed on their territory), not their wallet.
        const neighborKeys = [
          { q: action.coord.q + 1, r: action.coord.r },
          { q: action.coord.q + 1, r: action.coord.r - 1 },
          { q: action.coord.q, r: action.coord.r - 1 },
          { q: action.coord.q - 1, r: action.coord.r },
          { q: action.coord.q - 1, r: action.coord.r + 1 },
          { q: action.coord.q, r: action.coord.r + 1 },
        ];
        const targetTile = neighborKeys.map((c) => draft.map[hexKey(c)]).find((t) => t?.ownerId && t.ownerId !== action.actorId);
        if (!targetTile) throw new IllegalActionError('No adjacent rival tile to steal from');
        const resource = RESOURCE_TYPES.filter((r) => targetTile.stockpile[r] > 0).sort((a, b) => targetTile.stockpile[b] - targetTile.stockpile[a])[0];
        if (resource) {
          targetTile.stockpile[resource] -= 1;
          addToCarried(h, resource, 1);
        }
        p.hasStolenThisRound = true;
        pushEvent(draft, action.actorId, 'RogueSteal', { fromTile: targetTile.coord, resource: resource ?? null });
        break;
      }
    }
  });
}

function require_tileResource(type: Tile['type']): ResourceType {
  const map: Record<string, ResourceType> = { Forest: 'Wood', Hills: 'Stone', Plains: 'Food', Mountain: 'Ore', Desert: 'Gold' };
  const r = map[type];
  if (!r) throw new IllegalActionError(`Tile type ${type} has no forageable resource`);
  return r;
}

// ── Phase 4 — Fight ──────────────────────────────────────────────────────────────────────────

export function applyFight(state: GameState, action: FightAction): GameState {
  requireCurrentPlayer(state, action.actorId);
  requirePhase(state, Phase.Fight);

  // [DEFAULT — Munchkin exploration layer] A mandatory Door-monster fight is a free action, like
  // DeploySoldiers/BuildRoad elsewhere — it was forced on the hero by exploration, not chosen, so
  // it doesn't compete with the turn's one discretionary combat resolution. Without this
  // exemption, a hero who'd already spent their Fight-phase action on something else (a Ruins
  // Den, a duel) could never resolve a pending Door monster, and applyAdvancePhase's Phase-4 exit
  // guard would then deadlock their turn — unable to fight (already fought) and unable to leave
  // (still pending) at the same time.
  const isPendingDoorMonster =
    action.combatType === 'HeroVsMonster' &&
    !!state.pendingDoorMonster &&
    state.pendingDoorMonster.monsterCardId === action.monsterCardId &&
    hexKey(state.pendingDoorMonster.coord) === hexKey(action.coord);
  if (!isPendingDoorMonster && state.hasFoughtThisTurn) {
    throw new IllegalActionError('Already fought this Fight phase (§6: at most one combat resolution)');
  }

  switch (action.combatType) {
    case 'HeroVsMonster':
      return applyFightMonster(state, action);
    case 'HeroVsHero':
      return applyFightHero(state, action);
    case 'TameVolcano':
      return applyTameVolcano(state, action);
  }
}

/** [DEFAULT — Munchkin exploration layer] A Hero vs Monster fight now has TWO possible sources
 *  for the same action shape: the original Ruins/Dungeon Monster Den (tile.monsterDenCardId,
 *  permanent until beaten), or a freshly-drawn Door card that's still pending
 *  (state.pendingDoorMonster, set by applyMoveHero and mandatory before the turn can leave
 *  Phase 4 — see applyAdvancePhase). Both resolve through the exact same dice math and
 *  XP/Treasure/Bad-Stuff rewards; only where the monster reference lives, and what gets cleared
 *  on resolution, differs. */
function applyFightMonster(state: GameState, action: Extract<FightAction, { combatType: 'HeroVsMonster' }>): GameState {
  const player = findPlayer(state, action.actorId);
  const hero = resolveHero(player, action.heroId);
  const tile = tileAt(state, action.coord);

  const ruinsSource = !!tile && tile.type === 'Ruins' && tile.monsterDenCardId === action.monsterCardId ? tile.monsterDenCardId : null;
  const doorPending = state.pendingDoorMonster;
  const doorSource =
    doorPending &&
    doorPending.heroId === hero.id &&
    doorPending.monsterCardId === action.monsterCardId &&
    hexKey(doorPending.coord) === hexKey(action.coord)
      ? doorPending.monsterCardId
      : null;
  if (!ruinsSource && !doorSource) {
    throw new IllegalActionError('monsterCardId does not match a Monster Den here, nor a pending Door monster for this hero');
  }

  const isMage = classDefFor(player).startingBonus.kind === 'Mage';
  const atRange = hero.position.q === action.coord.q && hero.position.r === action.coord.r;
  // The Mage's ranged pre-emptive strike only makes sense against a fixed Den you can see from
  // next door — a Door monster was drawn ON ARRIVAL, so the hero is always already standing on it.
  const adjacentRange = isMage && !!ruinsSource && isAdjacent(hero.position, action.coord);
  if (!atRange && !adjacentRange) throw new IllegalActionError('Hero must be on (or, for a Ruins Den and Mage, adjacent to) the monster');

  const monster = getMonsterById(action.monsterCardId);

  return produce(state, (draft) => {
    const rng = new RngStream(draft.rngSeed, draft.rngCursor);
    const p = findPlayerMut(draft, action.actorId);
    const h = heroMut(p, action.heroId);
    const outcome = resolveHeroVsMonster(h, p, monster, rng);
    const draftTile = findTileMut(draft, action.coord);

    if (outcome.win) {
      grantXp(h, outcome.xpGained);
      const rarity = lootRarityForMonsterLevel(monster.level);
      const { card, deck } = drawLoot(draft.lootDeck, rarity, rng);
      draft.lootDeck = deck;
      if (card) h.inventory.push(card); // rarity exhausted — the win still stands, see drawLoot
    } else {
      applyHeroDamage(h, p.capitalTile, outcome.hpDamage);
      const { card, deck } = drawBadStuff(draft.badStuffDeck, rng);
      draft.badStuffDeck = deck;
      h.activeCurses.push(card);
      if (card.hpDamage) applyHeroDamage(h, p.capitalTile, card.hpDamage);
    }

    // Resolve the SOURCE regardless of win/lose — a Ruins Den only clears on a WIN (it keeps
    // guarding otherwise, unchanged from before); a Door monster resolves either way (win or
    // lose, it's a passing encounter, not a permanent guard — see this function's doc comment).
    if (ruinsSource) {
      if (outcome.win) {
        draftTile.monsterDenCardId = null;
        draft.monsterDeck = discardMonster(draft.monsterDeck, monster);
      }
    } else if (doorSource) {
      draft.pendingDoorMonster = null;
      draft.doorDeck.discardPile = [...draft.doorDeck.discardPile, { kind: 'Monster', monster }];
    }

    draft.rngCursor = rng.cursor;
    draft.hasFoughtThisTurn = true;
    pushEvent(draft, action.actorId, 'CombatResolved', {
      combatType: 'HeroVsMonster',
      monsterId: monster.id,
      win: outcome.win,
      roll: outcome.roll,
      source: ruinsSource ? 'RuinsDen' : 'Door',
    });
  });
}

function applyFightHero(state: GameState, action: Extract<FightAction, { combatType: 'HeroVsHero' }>): GameState {
  const attackerPlayer = findPlayer(state, action.actorId);
  const attackerHero = resolveHero(attackerPlayer, action.heroId);
  const defenderPlayer = findPlayer(state, action.targetPlayerId);
  const defenderHero = resolveHero(defenderPlayer, action.targetHeroId);
  if (attackerHero.position.q !== defenderHero.position.q || attackerHero.position.r !== defenderHero.position.r) {
    throw new IllegalActionError('Heroes must share a tile to duel');
  }

  return produce(state, (draft) => {
    const rng = new RngStream(draft.rngSeed, draft.rngCursor);
    const ap = findPlayerMut(draft, action.actorId);
    const ah = heroMut(ap, action.heroId);
    const dp = findPlayerMut(draft, action.targetPlayerId);
    const dh = heroMut(dp, action.targetHeroId);

    const outcome = resolveHeroVsHero(ah, ap, dh, dp, rng);
    const winner = outcome.attackerWins ? { h: ah } : { h: dh };
    const loser = outcome.attackerWins ? { h: dh } : { h: ah };

    // Action shape carries no "which resource/which loot" choice (see file header) — v1
    // steals from whatever the loser is CARRYING (largest stack), falling back to a random
    // Loot card. Bounded by the winner's own remaining carry capacity.
    const bestResource = RESOURCE_TYPES.filter((r) => loser.h.carriedResources[r] > 0).sort(
      (a, b) => loser.h.carriedResources[b] - loser.h.carriedResources[a]
    )[0];
    if (bestResource) {
      loser.h.carriedResources[bestResource] -= 1;
      addToCarried(winner.h, bestResource, 1);
    } else if (loser.h.inventory.length > 0) {
      const idx = rng.nextInt(loser.h.inventory.length);
      const [stolen] = loser.h.inventory.splice(idx, 1);
      loser.h.equippedLootIds = loser.h.equippedLootIds.filter((id) => id !== stolen.id);
      winner.h.inventory.push(stolen);
    }

    draft.rngCursor = rng.cursor;
    draft.hasFoughtThisTurn = true;
    pushEvent(draft, action.actorId, 'CombatResolved', {
      combatType: 'HeroVsHero',
      isBackstab: action.isBackstab,
      winnerId: outcome.attackerWins ? ap.id : dp.id,
      attackerRoll: outcome.attackerRoll,
      defenderRoll: outcome.defenderRoll,
    });
  });
}

function applyTameVolcano(state: GameState, action: Extract<FightAction, { combatType: 'TameVolcano' }>): GameState {
  const player = findPlayer(state, action.actorId);
  const hero = resolveHero(player, action.heroId);
  const tile = tileAt(state, action.coord);
  if (!tile || tile.type !== 'Volcano') throw new IllegalActionError('TameVolcano requires a Volcano tile');
  if (tile.isTamed) throw new IllegalActionError('This Volcano has already been tamed');
  if (hero.position.q !== action.coord.q || hero.position.r !== action.coord.r) throw new IllegalActionError('Hero must be on the Volcano tile');

  return produce(state, (draft) => {
    const rng = new RngStream(draft.rngSeed, draft.rngCursor);
    const p = findPlayerMut(draft, action.actorId);
    const h = heroMut(p, action.heroId);
    const outcome = resolveTameVolcano(h, p, rng);
    const draftTile = findTileMut(draft, action.coord);

    if (outcome.win) {
      draftTile.isTamed = true;
      addToCarried(h, 'Gold', 5); // one-time cache — carried, same as any other pickup
      const { card, deck } = drawLoot(draft.lootDeck, 'Legendary', rng);
      draft.lootDeck = deck;
      if (card) h.inventory.push(card); // rarity exhausted — the tame still stands, see drawLoot
    } else {
      applyHeroDamage(h, p.capitalTile, outcome.hpDamage);
      const { card, deck } = drawBadStuff(draft.badStuffDeck, rng);
      draft.badStuffDeck = deck;
      h.activeCurses.push(card);
    }

    draft.rngCursor = rng.cursor;
    draft.hasFoughtThisTurn = true;
    pushEvent(draft, action.actorId, 'CombatResolved', { combatType: 'TameVolcano', win: outcome.win, roll: outcome.roll });
  });
}

// ── Phase 5 — Build ──────────────────────────────────────────────────────────────────────────

export function applyBuild(state: GameState, action: BuildBuildingAction): GameState {
  requireCurrentPlayer(state, action.actorId);
  requirePhase(state, Phase.Build);
  if (state.hasBuiltThisTurn) throw new IllegalActionError('Already used this turn\'s Build action (§7: one building OR one level-up)');

  const player = findPlayer(state, action.actorId);
  const hero = resolveHero(player, action.heroId);
  const isMage = classDefFor(player).startingBonus.kind === 'Mage';

  if (action.buildingType === 'Capital') {
    if (hexKey(action.coord) !== hexKey(player.capitalTile)) throw new IllegalActionError('Capital upgrade must target your Capital tile');
    const nextTier = CAPITAL_TIERS[player.capitalTier];
    if (!nextTier) throw new IllegalActionError(`Town is already at max tier (${CAPITAL_TIERS.length})`);
    const cost = isMage ? applyMageDiscount(nextTier.cost) : nextTier.cost;
    if (!combinedAfford(player, hero, action.coord, cost)) throw new IllegalActionError('Cannot afford this Town tier');
    return produce(state, (draft) => {
      const p = findPlayerMut(draft, action.actorId);
      const h = heroMut(p, action.heroId);
      combinedPay(p, h, action.coord, cost);
      p.capitalTier += 1;
      // Keep the tile's own Building.tier in sync — see setup.ts's map[] init for why this
      // exists at all (the Capital carries a real Building object from turn 1, not just the
      // bespoke Player.capitalTier counter).
      const draftCapitalTile = findTileMut(draft, action.coord);
      if (draftCapitalTile.building) draftCapitalTile.building.tier = p.capitalTier;
      if ('heroMaxHpBonus' in nextTier) {
        p.hero.maxHp += nextTier.heroMaxHpBonus;
        p.hero.hp += nextTier.heroMaxHpBonus;
      }
      draft.hasBuiltThisTurn = true;
      pushEvent(draft, action.actorId, 'CapitalUpgraded', { tier: p.capitalTier });
    });
  }

  const tile = tileAt(state, action.coord);
  if (!tile || tile.ownerId !== action.actorId) throw new IllegalActionError('You must own the target tile');
  if (tile.building) throw new IllegalActionError('This tile already has a building');

  const def = buildingDefFor(action.buildingType);
  const effType = effectiveTileType(tile);
  const allowed = def.allowedTileTypes === 'any' || (Array.isArray(def.allowedTileTypes) && def.allowedTileTypes.includes(effType));
  if (!allowed) throw new IllegalActionError(`${action.buildingType} cannot be built on a ${effType} tile`);

  // [DEFAULT — balance rework] see BuildingDefinition.minRound doc comment.
  if (def.minRound !== undefined && state.roundNumber < def.minRound) {
    throw new IllegalActionError(`${action.buildingType} cannot be built before round ${def.minRound} (currently round ${state.roundNumber})`);
  }

  if (def.requiresBuilding) {
    const hasPrereq = player.ownedTiles.some((c) => tileAt(state, c)?.building?.type === def.requiresBuilding);
    if (!hasPrereq) throw new IllegalActionError(`${action.buildingType} requires an owned ${def.requiresBuilding} first`);
  }

  const cost = isMage ? applyMageDiscount(def.cost) : def.cost;
  if (!combinedAfford(player, hero, action.coord, cost)) throw new IllegalActionError('Cannot afford this building');

  return produce(state, (draft) => {
    const p = findPlayerMut(draft, action.actorId);
    const h = heroMut(p, action.heroId);
    combinedPay(p, h, action.coord, cost);
    const draftTile = findTileMut(draft, action.coord);
    draftTile.building = { id: `bldg-${hexKey(action.coord)}`, type: action.buildingType, coord: action.coord, ownerId: action.actorId };
    // [BUG FIX — territory rework] Zero the reserve UNLESS an enemy garrison is already
    // standing here. Overwriting militiaCount unconditionally let a Barracks built on your own
    // soil, while a rival's garrison was standing on it, delete that army for free — a
    // 3 Wood / 2 Ore / 5 Food building doubling as an army-erase button. If someone else's
    // Soldiers are here, this Build is legal (§7 has no "tile must be empty of enemies" rule)
    // but it must NOT touch their garrison. The ordinary case — no garrison at all yet — still
    // gets an explicit 0 (not left undefined): garrisonOwnerOf returns null for an empty tile,
    // same as it would for an enemy-held one, so the check is "is someone ELSE here", not
    // "is this mine".
    const existingGarrison = garrisonOwnerOf(draftTile);
    if (action.buildingType === 'Barracks' && (existingGarrison === null || existingGarrison === action.actorId)) {
      draftTile.militiaCount = 0;
    }
    if (action.buildingType === 'Dock') p.hero.canBoat = true;
    draft.hasBuiltThisTurn = true;
    pushEvent(draft, action.actorId, 'BuildingConstructed', { coord: action.coord, buildingType: action.buildingType });
  });
}

/** [DEFAULT — balance rework, supersedes the old applyBuyMilitia] Reassigns count Soldiers
 *  from a Barracks tile's passively-accumulated reserve onto any owned tile — see
 *  DeploySoldiersAction's doc comment in types.ts. */
export function applyDeploySoldiers(state: GameState, action: DeploySoldiersAction): GameState {
  requireCurrentPlayer(state, action.actorId);
  requirePhase(state, Phase.Build);
  const fromTile = tileAt(state, action.fromCoord);
  if (!fromTile || fromTile.ownerId !== action.actorId || fromTile.building?.type !== 'Barracks') {
    throw new IllegalActionError('DeploySoldiers requires your own Barracks tile as the source');
  }
  // [BUG FIX — territory rework] The reserve belongs to whoever GARRISONS the Barracks, not
  // whoever owns the ground under it — an occupied Barracks still recruits (see
  // accumulateTileProduction), and those recruits are the occupier's. Checking ownerId here let
  // the rightful owner "deploy" an invader's own reserve as if it were theirs — walking off with
  // an enemy army for free, without so much as a MoveSoldiers march to win it.
  if (garrisonOwnerOf(fromTile) !== action.actorId) {
    throw new IllegalActionError('That Barracks reserve belongs to someone else — take the tile back first');
  }
  const toTile = tileAt(state, action.toCoord);
  if (!toTile || toTile.ownerId !== action.actorId) throw new IllegalActionError('Target tile must be one you own');
  // [BUG FIX — territory rework] Same asymmetry the other direction: deploying reinforcements
  // onto an owned tile currently held by a rival's occupying garrison silently donated fresh
  // Soldiers to that garrison (recruit joins whatever militiaCount is already there) instead of
  // fighting for the ground. Recapture it with MoveSoldiers first.
  const existingOccupant = garrisonOwnerOf(toTile);
  if (existingOccupant !== null && existingOccupant !== action.actorId) {
    throw new IllegalActionError('That tile is occupied by a rival garrison — march on it with MoveSoldiers instead of deploying into it');
  }
  const sameTile = hexKey(action.fromCoord) === hexKey(action.toCoord);
  // [BUG FIX — direct report] Soldiers do not teleport. Deploying was originally "any owned
  // tile" — fresh recruits assigned to a posting, no physical march implied — but that let a
  // Barracks reinforce a tile clear across the map in one free action, same complaint as a
  // MoveSoldiers teleport would draw. Now it's the Barracks tile itself (sameTile — the recruits
  // just stay where they trained) or one hex out, the same physical reach MoveSoldiers has.
  if (!sameTile && !isAdjacent(action.fromCoord, action.toCoord)) {
    throw new IllegalActionError('Soldiers can only deploy to the Barracks tile itself or an adjacent tile');
  }
  if (action.count <= 0) throw new IllegalActionError('count must be positive');
  if ((fromTile.militiaCount ?? 0) < action.count) throw new IllegalActionError('Not enough Soldiers in the Barracks reserve');
  // [BUG FIX — direct report, Risk's rule, "same for reinforcements"] Only meaningful when
  // actually leaving the tile — deploying to sameTile nets to the same militiaCount (see below),
  // so there's nothing to "leave behind" from in that case.
  if (!sameTile && (fromTile.militiaCount ?? 0) - action.count < MIN_SOLDIERS_LEFT_BEHIND) {
    throw new IllegalActionError(`Must leave at least ${MIN_SOLDIERS_LEFT_BEHIND} Soldier(s) behind at the Barracks`);
  }

  return produce(state, (draft) => {
    const draftFrom = findTileMut(draft, action.fromCoord);
    const draftTo = findTileMut(draft, action.toCoord);
    draftFrom.militiaCount = (draftFrom.militiaCount ?? 0) - action.count;
    if ((draftFrom.militiaCount ?? 0) <= 0) draftFrom.garrisonOwnerId = null;
    draftTo.militiaCount = (draftTo.militiaCount ?? 0) + action.count; // fromCoord === toCoord nets to the same value
    draftTo.garrisonOwnerId = action.actorId;
    pushEvent(draft, action.actorId, 'SoldiersDeployed', { fromCoord: action.fromCoord, toCoord: action.toCoord, count: action.count });
  });
}

/** [DEFAULT — balance rework pass 4, new mechanic] Spends SMITHY_CRAFT_COSTS[rarity]
 *  (constants.ts) to draw ONE guaranteed-rarity LootCard from the shared lootDeck — see
 *  CraftGearAction's doc comment in types.ts for the full design rationale. Phase 5, free — like
 *  DeploySoldiers/MoveSoldiers, does NOT consume the turn's one Build slot (§7), so it can
 *  repeat every turn resources allow rather than competing with actually constructing things. */
export function applyCraftGear(state: GameState, action: CraftGearAction): GameState {
  requireCurrentPlayer(state, action.actorId);
  requirePhase(state, Phase.Build);
  const player = findPlayer(state, action.actorId);
  const hero = resolveHero(player, action.heroId);
  const tile = tileAt(state, action.coord);
  if (!tile || tile.ownerId !== action.actorId || tile.building?.type !== 'Smithy') {
    throw new IllegalActionError('CraftGear requires your own Smithy tile');
  }
  if (!sameCoord(hero.position, action.coord)) throw new IllegalActionError('Hero must be standing at the Smithy to craft');

  const isMage = classDefFor(player).startingBonus.kind === 'Mage';
  const cost = isMage ? applyMageDiscount(SMITHY_CRAFT_COSTS[action.rarity]) : SMITHY_CRAFT_COSTS[action.rarity];
  if (!combinedAfford(player, hero, action.coord, cost)) throw new IllegalActionError('Cannot afford to craft that rarity');

  return produce(state, (draft) => {
    const rng = new RngStream(draft.rngSeed, draft.rngCursor);
    const p = findPlayerMut(draft, action.actorId);
    const h = heroMut(p, action.heroId);
    combinedPay(p, h, action.coord, cost);
    // Exhausted rarity — the craft still stands (resources are spent either way), just
    // empty-handed; see drawLoot's doc comment (decks.ts) and §5.3.
    const { card, deck } = drawLoot(draft.lootDeck, action.rarity, rng);
    draft.lootDeck = deck;
    if (card) h.inventory.push(card);
    draft.rngCursor = rng.cursor;
    pushEvent(draft, action.actorId, 'GearCrafted', { coord: action.coord, rarity: action.rarity, lootCardId: card?.id ?? null });
  });
}

/** [DEFAULT — balance rework pass 4, new mechanic, direct request] CraftGear's inverse: sells a
 *  Loot card for LOOT_SELL_TROOPS[rarity] Soldiers at a Barracks — see SellLootAction's doc
 *  comment in types.ts. Phase 5, free — like CraftGear/DeploySoldiers, does NOT consume the
 *  turn's one Build slot. */
export function applySellLoot(state: GameState, action: SellLootAction): GameState {
  requireCurrentPlayer(state, action.actorId);
  requirePhase(state, Phase.Build);
  const player = findPlayer(state, action.actorId);
  const hero = resolveHero(player, action.heroId);
  const tile = tileAt(state, action.coord);
  if (!tile || tile.ownerId !== action.actorId || tile.building?.type !== 'Barracks') {
    throw new IllegalActionError('SellLoot requires your own Barracks tile');
  }
  if (!sameCoord(hero.position, action.coord)) throw new IllegalActionError('Hero must be standing at the Barracks to sell gear there');
  const card = hero.inventory.find((c) => c.id === action.lootCardId);
  if (!card) throw new IllegalActionError('You do not have that Loot card');
  // [BUG FIX — matches the same class of fix applyBuild/applyDeploySoldiers already carry] The
  // reserve this sale would top up belongs to whoever GARRISONS the tile, not just whoever owns
  // the ground under it — selling into a Barracks a rival is currently squatting on would
  // silently donate fresh troops to THEIR garrison. Retake it with MoveSoldiers first.
  const existingGarrison = garrisonOwnerOf(tile);
  if (existingGarrison !== null && existingGarrison !== action.actorId) {
    throw new IllegalActionError('This Barracks is occupied by a rival garrison — retake it with MoveSoldiers first');
  }

  const barracksTier = BARRACKS_TIERS[Math.min(tierOf(tile.building), BARRACKS_TIERS.length) - 1] ?? BARRACKS_TIERS[0];
  const currentArmy = Object.values(state.map)
    .filter((t) => garrisonOwnerOf(t) === player.id)
    .reduce((sum, t) => sum + (t.militiaCount ?? 0), 0);
  const waterTiles = player.ownedTiles.filter((c) => {
    const t = state.map[hexKey(c)];
    return !!t && effectiveTileType(t) === 'River';
  }).length;
  const roomUnderTroopCap = Math.max(0, troopCapFor(waterTiles) - currentArmy);
  const roomUnderReserveCap = Math.max(0, barracksTier.reserveCap - (tile.militiaCount ?? 0));
  const granted = Math.min(LOOT_SELL_TROOPS[card.rarity], roomUnderTroopCap, roomUnderReserveCap);
  if (granted <= 0) throw new IllegalActionError('This Barracks has no room for more Soldiers right now (reserve or troop cap full)');

  return produce(state, (draft) => {
    const p = findPlayerMut(draft, action.actorId);
    const h = heroMut(p, action.heroId);
    h.inventory = h.inventory.filter((c) => c.id !== action.lootCardId);
    h.equippedLootIds = h.equippedLootIds.filter((id) => id !== action.lootCardId);
    const draftTile = findTileMut(draft, action.coord);
    draftTile.militiaCount = (draftTile.militiaCount ?? 0) + granted;
    draftTile.garrisonOwnerId = action.actorId;
    pushEvent(draft, action.actorId, 'LootSold', { coord: action.coord, lootCardId: action.lootCardId, rarity: card.rarity, troopsGranted: granted });
  });
}

/** [DEFAULT — roads] Lays one road segment along a tile edge — see BuildRoadAction in types.ts.
 *  Free action: not phase-gated and doesn't consume the Build slot. */
export function applyBuildRoad(state: GameState, action: BuildRoadAction): GameState {
  requireCurrentPlayer(state, action.actorId);
  if (!isAdjacent(action.from, action.to)) throw new IllegalActionError('A road connects two ADJACENT hexes');
  const fromTile = tileAt(state, action.from);
  const toTile = tileAt(state, action.to);
  if (!fromTile || !toTile) throw new IllegalActionError('Both ends of a road must be placed tiles');
  // At least one end must be yours — you can extend your network up to a neutral frontier tile
  // you intend to claim, but you can't lay track between two hexes you have no stake in.
  if (fromTile.ownerId !== action.actorId && toTile.ownerId !== action.actorId) {
    throw new IllegalActionError('At least one end of a road must be a tile you own');
  }
  const key = edgeKey(action.from, action.to);
  if (state.roads[key]) throw new IllegalActionError('That edge already has a road');

  const player = findPlayer(state, action.actorId);
  const hero = resolveHero(player, action.heroId);
  const isMage = classDefFor(player).startingBonus.kind === 'Mage';
  const cost = isMage ? applyMageDiscount(ROAD_COST) : ROAD_COST;
  // Payable from the hero's sack when they're standing at either end, else from the wallet.
  const localCoord = sameCoord(hero.position, action.from) ? action.from : sameCoord(hero.position, action.to) ? action.to : null;
  if (!combinedAfford(player, hero, localCoord, cost)) throw new IllegalActionError('Cannot afford a road');

  return produce(state, (draft) => {
    const p = findPlayerMut(draft, action.actorId);
    const h = heroMut(p, action.heroId);
    combinedPay(p, h, localCoord, cost);
    draft.roads[key] = action.actorId;
    pushEvent(draft, action.actorId, 'RoadBuilt', { from: action.from, to: action.to });
  });
}

/** Whose Soldiers are standing on a tile — null when there are none. A garrison with no explicit
 *  garrisonOwnerId belongs to whoever owns the tile, which is the ordinary case. */
export function garrisonOwnerOf(tile: Tile): PlayerId | null {
  if ((tile.militiaCount ?? 0) <= 0) return null;
  return tile.garrisonOwnerId ?? tile.ownerId ?? null;
}

/** [DEFAULT — territory rework] The one action that moves Soldiers, and therefore the one action
 *  that takes ground. Reinforce / occupy / attack are all the same march — see
 *  MoveSoldiersAction in types.ts for the three outcomes. */
export function applyMoveSoldiers(state: GameState, action: MoveSoldiersAction): GameState {
  requireCurrentPlayer(state, action.actorId);
  requirePhase(state, Phase.Build);
  if (action.count <= 0) throw new IllegalActionError('count must be positive');
  if (!isAdjacent(action.fromCoord, action.toCoord)) throw new IllegalActionError('Soldiers march one hex at a time, to an adjacent tile');
  const fromTile = tileAt(state, action.fromCoord);
  const toTile = tileAt(state, action.toCoord);
  if (!fromTile) throw new IllegalActionError('No tile to march from');
  if (!toTile) throw new IllegalActionError('Soldiers cannot march off the edge of the map');
  // What matters is whose troops they are, NOT who owns the ground they're standing on — an
  // invading force parked on captured ground can keep advancing from there.
  if (garrisonOwnerOf(fromTile) !== action.actorId) throw new IllegalActionError('Those are not your Soldiers');
  if ((fromTile.militiaCount ?? 0) < action.count) throw new IllegalActionError('Not enough Soldiers on that tile');
  // [DEFAULT — territory rework, Risk's classic rule] see MIN_SOLDIERS_LEFT_BEHIND.
  if ((fromTile.militiaCount ?? 0) - action.count < MIN_SOLDIERS_LEFT_BEHIND) {
    throw new IllegalActionError(`Must leave at least ${MIN_SOLDIERS_LEFT_BEHIND} Soldier(s) behind on the tile you're marching from`);
  }

  const defenderId = garrisonOwnerOf(toTile);
  const contested = defenderId !== null && defenderId !== action.actorId;

  // [DEFAULT — hero battle participation] see MoveSoldiersAction.heroJoins's doc comment.
  if (action.heroJoins) {
    const player = findPlayer(state, action.actorId);
    const joiningHero = resolveHero(player, action.heroId);
    if (hexKey(joiningHero.position) !== hexKey(action.fromCoord)) {
      throw new IllegalActionError('Hero must be standing on the tile Soldiers are marching from to join the attack');
    }
  }

  return produce(state, (draft) => {
    const rng = new RngStream(draft.rngSeed, draft.rngCursor);
    const draftFrom = findTileMut(draft, action.fromCoord);
    const draftTo = findTileMut(draft, action.toCoord);
    draftFrom.militiaCount = (draftFrom.militiaCount ?? 0) - action.count;
    if ((draftFrom.militiaCount ?? 0) <= 0) draftFrom.garrisonOwnerId = null;

    if (!contested) {
      // Empty ground: walk on. Friendly tile is a plain reinforcement; hostile or neutral ground
      // starts an occupation clock that claimHeldTerritory settles at the start of a later turn.
      draftTo.militiaCount = (draftTo.militiaCount ?? 0) + action.count;
      draftTo.garrisonOwnerId = action.actorId;
      if (draftTo.ownerId !== action.actorId) {
        draftTo.occupationSinceRound = draft.roundNumber;
        pushEvent(draft, action.actorId, 'TerritoryOccupied', { coord: action.toCoord, count: action.count });
      } else {
        draftTo.occupationSinceRound = undefined;
        pushEvent(draft, action.actorId, 'SoldiersMarched', { fromCoord: action.fromCoord, toCoord: action.toCoord, count: action.count });
      }
      draft.rngCursor = rng.cursor;
      return;
    }

    // Defended: the §6.3 dice resolve on contact. Same math as before, new trigger.
    const defendingUnits = draftTo.militiaCount ?? 0;
    // [DEFAULT — balance rework pass 4] Tier-aware — 0 means no Watchtower here at all.
    const watchtowerTier = draftTo.building?.type === 'Watchtower' ? tierOf(draftTo.building) : 0;

    const attackerPlayer = findPlayerMut(draft, action.actorId);
    let attackerHeroDie: HeroBattleDie | null = null;
    if (action.heroJoins) {
      const h = heroMut(attackerPlayer, action.heroId);
      attackerHeroDie = { heroId: h.id, roll: rollHeroAttack(h, attackerPlayer, rng) };
    }
    // A defending hero needs no flag — they fight automatically just by physically standing on
    // the tile under attack, symmetric with how ArmyVsTerritory itself triggers on contact.
    const defenderPlayer = defenderId ? findPlayerMut(draft, defenderId) : null;
    let defenderHeroRef: HeroState | null = null;
    let defenderHeroDie: HeroBattleDie | null = null;
    if (defenderPlayer && hexKey(defenderPlayer.hero.position) === hexKey(action.toCoord)) {
      defenderHeroRef = defenderPlayer.hero;
      defenderHeroDie = { heroId: defenderPlayer.hero.id, roll: rollHeroAttack(defenderPlayer.hero, defenderPlayer, rng) };
    }

    const outcome = resolveArmyVsTerritory(action.count, defendingUnits, watchtowerTier, rng, attackerHeroDie, defenderHeroDie);

    if (outcome.tileCaptured) {
      draftTo.militiaCount = outcome.attackerRemaining;
      draftTo.garrisonOwnerId = action.actorId;
      // Winning the fight buys the ground, not the deed — the occupier still has to survive
      // into a later round before the tile actually changes hands.
      draftTo.occupationSinceRound = draft.roundNumber;
    } else {
      // Repulsed: survivors fall back to where they came from rather than evaporating.
      draftTo.militiaCount = outcome.defenderRemaining;
      draftFrom.militiaCount = (draftFrom.militiaCount ?? 0) + outcome.attackerRemaining;
      if ((draftFrom.militiaCount ?? 0) > 0) draftFrom.garrisonOwnerId = action.actorId;
    }

    draft.rngCursor = rng.cursor;
    pushEvent(draft, action.actorId, 'CombatResolved', {
      combatType: 'ArmyVsTerritory',
      coord: action.toCoord,
      defenderId,
      ...outcome,
    });

    // [DEFAULT — hero battle participation] Apply each joined hero's own pairing result — a win
    // grants a flat XP nudge, a loss costs HP and, at 0, triggers permadeath respawn instead of
    // the softer downed-and-retreat rule (that rule is for monster fights, not this).
    if (attackerHeroDie && outcome.attackerHeroOutcome) {
      const h = heroMut(attackerPlayer, action.heroId);
      if (outcome.attackerHeroOutcome === 'won') {
        grantXp(h, HERO_BATTLE_XP_ON_WIN);
      } else {
        h.hp -= outcome.attackerHeroDamage;
        pushEvent(draft, action.actorId, 'HeroDamaged', { heroId: h.id, damage: outcome.attackerHeroDamage, source: 'ArmyVsTerritory' });
        if (h.hp <= 0) respawnHeroFromDeath(draft, attackerPlayer, h);
      }
    }
    if (defenderHeroDie && defenderHeroRef && defenderPlayer && outcome.defenderHeroOutcome) {
      if (outcome.defenderHeroOutcome === 'won') {
        grantXp(defenderHeroRef, HERO_BATTLE_XP_ON_WIN);
      } else {
        defenderHeroRef.hp -= outcome.defenderHeroDamage;
        pushEvent(draft, defenderPlayer.id, 'HeroDamaged', { heroId: defenderHeroRef.id, damage: outcome.defenderHeroDamage, source: 'ArmyVsTerritory' });
        if (defenderHeroRef.hp <= 0) respawnHeroFromDeath(draft, defenderPlayer, defenderHeroRef);
      }
    }
  });
}

/** [DEFAULT — territory rework, hold time tuned per designer feedback] Settles occupations that
 *  have survived TERRITORY_CLAIM_ROUNDS full rounds: any tile this player's Soldiers are
 *  standing on, that they don't own, which they've held since occupationSinceRound, now becomes
 *  theirs once enough rounds have passed. Runs at the start of their turn so a rival gets
 *  multiple turns in between to march back and contest it — not just one, per the tuned value.
 *
 *  [DEFAULT — balance rework pass 4] Capturing a Capital still eliminates its owner, same as
 *  before — but now ALSO ends the whole game immediately in the claimant's favor (§11's new
 *  Capital Conquest win condition), superseding the old "eliminate every rival" Domination path
 *  outright (checkWinConditions, selectors.ts, no longer has that clause at all — a single
 *  Capital is enough, regardless of how many other players remain seated). This is checked and
 *  set HERE, the instant the claim settles, not at round end like the other three conditions —
 *  see maybeEndRound below, which never gets the chance to run for this player's turn again
 *  once winnerId is set, since requireCurrentPlayer rejects every further action. The `!
 *  draft.winnerId` guard is a defensive no-op in the normal single-capital case; it only matters
 *  if this same Phase 0 sweep somehow settles two rival Capitals in one pass, so the first one
 *  standing is the one that wins rather than a later iteration silently overwriting it. */
function claimHeldTerritory(draft: GameState, playerId: PlayerId) {
  for (const tile of Object.values(draft.map)) {
    if (tile.ownerId === playerId) continue;
    if (garrisonOwnerOf(tile) !== playerId) continue;
    if (tile.occupationSinceRound === undefined || draft.roundNumber < tile.occupationSinceRound + TERRITORY_CLAIM_ROUNDS) continue;

    const previousOwnerId = tile.ownerId;
    tile.ownerId = playerId;
    tile.occupationSinceRound = undefined;

    const claimant = findPlayerMut(draft, playerId);
    if (!claimant.ownedTiles.some((c) => hexKey(c) === hexKey(tile.coord))) claimant.ownedTiles.push(tile.coord);

    if (previousOwnerId) {
      const loser = findPlayerMut(draft, previousOwnerId);
      loser.ownedTiles = loser.ownedTiles.filter((c) => hexKey(c) !== hexKey(tile.coord));
      if (hexKey(tile.coord) === hexKey(loser.capitalTile)) {
        loser.isEliminated = true;
        pushEvent(draft, 'system', 'PlayerEliminated', { playerId: previousOwnerId });
        if (!draft.winnerId) {
          draft.winnerId = playerId;
          draft.winCondition = 'CapitalConquest';
          draft.status = 'finished';
          pushEvent(draft, 'system', 'GameEnded', { winnerId: playerId, winCondition: 'CapitalConquest' });
        }
      }
    }
    pushEvent(draft, playerId, 'TerritoryClaimed', { coord: tile.coord, from: previousOwnerId ?? null });
  }
}

/** [DEFAULT — balance rework] Advances a Farm/Quarry/CowStable one tier up its `upgrades` list
 *  (CowStable runs to tier 5). See UpgradeBuildingAction's doc comment in types.ts — unlike
 *  DeploySoldiers, this DOES consume the turn's one Build slot. */
export function applyUpgradeBuilding(state: GameState, action: UpgradeBuildingAction): GameState {
  requireCurrentPlayer(state, action.actorId);
  requirePhase(state, Phase.Build);
  if (state.hasBuiltThisTurn) throw new IllegalActionError('Already used this turn\'s Build action (§7: one building OR one level-up)');
  const player = findPlayer(state, action.actorId);
  const hero = resolveHero(player, action.heroId);
  const tile = tileAt(state, action.coord);
  if (!tile || tile.ownerId !== action.actorId || !tile.building) throw new IllegalActionError('You must own a tile with a building to upgrade');
  const def = buildingDefFor(tile.building.type);
  if (!def.upgrades?.length) throw new IllegalActionError(`${tile.building.type} has no further upgrade`);
  const currentTier = tierOf(tile.building);
  const next = nextUpgradeFor(def, currentTier);
  if (!next) throw new IllegalActionError('This building is already at its max tier');
  const isMage = classDefFor(player).startingBonus.kind === 'Mage';
  const cost = isMage ? applyMageDiscount(next.cost) : next.cost;
  if (!combinedAfford(player, hero, action.coord, cost)) throw new IllegalActionError('Cannot afford this upgrade');

  return produce(state, (draft) => {
    const p = findPlayerMut(draft, action.actorId);
    const h = heroMut(p, action.heroId);
    combinedPay(p, h, action.coord, cost);
    const draftTile = findTileMut(draft, action.coord);
    draftTile.building!.tier = currentTier + 1;
    draft.hasBuiltThisTurn = true;
    pushEvent(draft, action.actorId, 'BuildingUpgraded', {
      coord: action.coord,
      buildingType: tile.building!.type,
      tier: currentTier + 1,
      produceAmount: next.produceAmount,
    });
  });
}

export function applyLevelUpHero(state: GameState, action: LevelUpHeroAction): GameState {
  requireCurrentPlayer(state, action.actorId);
  requirePhase(state, Phase.Build);
  if (state.hasBuiltThisTurn) throw new IllegalActionError('Already used this turn\'s Build action (§7: one building OR one level-up)');
  const player = findPlayer(state, action.actorId);
  const hero = resolveHero(player, action.heroId);
  if (!hero.pendingLevelUp) throw new IllegalActionError('No level-up available — hero has not earned enough XP yet');
  const isMage = classDefFor(player).startingBonus.kind === 'Mage';
  const cost = isMage ? applyMageDiscount(LEVEL_UP_COST) : LEVEL_UP_COST;
  // LevelUpHero has no tile of its own — always paid from the wallet (coord: null).
  if (!combinedAfford(player, hero, null, cost)) throw new IllegalActionError('Cannot afford to apply this level-up');

  return produce(state, (draft) => {
    const p = findPlayerMut(draft, action.actorId);
    const h = heroMut(p, action.heroId);
    combinedPay(p, h, null, cost);
    h.xp -= xpToReachNextLevel(h.level); // consume the XP that earned this level, §8.1
    h.level += 1;
    h.maxHp += LEVEL_UP_MAX_HP_BONUS;
    h.hp = h.maxHp;
    h.xpToNextLevel = h.level < 10 ? xpToReachNextLevel(h.level) : 0;
    // A big single XP grant (e.g. a high-level Monster kill) can cross more than one
    // threshold at once — re-flag immediately if there's already enough for the next level.
    h.pendingLevelUp = h.level < 10 && h.xp >= xpToReachNextLevel(h.level);
    h.movementRange = movementRangeFor(h); // §4.1 — Level 5+ grants +1; keep the cached field live
    draft.hasBuiltThisTurn = true;
    pushEvent(draft, action.actorId, 'HeroLeveledUp', { heroId: h.id, newLevel: h.level });
  });
}

// ── Free actions (not phase- or once-per-turn-gated) ────────────────────────────────────────

export function applyEquipLoot(state: GameState, action: EquipLootAction): GameState {
  requireCurrentPlayer(state, action.actorId);
  const player = findPlayer(state, action.actorId);
  const hero = resolveHero(player, action.heroId);
  const card = hero.inventory.find((c) => c.id === action.lootCardId);
  if (!card) throw new IllegalActionError('You do not have that Loot card');
  if (hero.equippedLootIds.includes(action.lootCardId)) throw new IllegalActionError('Already equipped');
  if (hero.equippedLootIds.length >= GEAR_SLOT_COUNT) throw new IllegalActionError(`Only ${GEAR_SLOT_COUNT} gear slots available`);

  return produce(state, (draft) => {
    const p = findPlayerMut(draft, action.actorId);
    const h = heroMut(p, action.heroId);
    h.equippedLootIds.push(action.lootCardId);
    h.movementRange = movementRangeFor(h); // some Loot grants movementBonus, §4.1
    pushEvent(draft, action.actorId, 'LootEquipped', { lootCardId: action.lootCardId, heroId: h.id });
  });
}

export function applyUnequipLoot(state: GameState, action: UnequipLootAction): GameState {
  requireCurrentPlayer(state, action.actorId);
  const player = findPlayer(state, action.actorId);
  const hero = resolveHero(player, action.heroId);
  if (!hero.equippedLootIds.includes(action.lootCardId)) throw new IllegalActionError('That Loot card is not equipped');

  return produce(state, (draft) => {
    const p = findPlayerMut(draft, action.actorId);
    const h = heroMut(p, action.heroId);
    h.equippedLootIds = h.equippedLootIds.filter((id) => id !== action.lootCardId);
    h.movementRange = movementRangeFor(h);
    pushEvent(draft, action.actorId, 'LootUnequipped', { lootCardId: action.lootCardId, heroId: h.id });
  });
}

export function applyTradeWithBank(state: GameState, action: TradeWithBankAction): GameState {
  requireCurrentPlayer(state, action.actorId);
  const player = findPlayer(state, action.actorId);
  const ratio = player.bankTradeRatio;
  if (action.giveAmount !== ratio[0]) throw new IllegalActionError(`Your bank trade ratio is ${ratio[0]}:${ratio[1]}`);
  if (player.resources[action.give] < action.giveAmount) throw new IllegalActionError('Not enough resources to trade');
  if (action.give === action.receive) throw new IllegalActionError('Cannot trade a resource for itself');

  return produce(state, (draft) => {
    const p = findPlayerMut(draft, action.actorId);
    p.resources[action.give] -= action.giveAmount;
    p.resources[action.receive] += ratio[1];
    pushEvent(draft, action.actorId, 'TradedWithBank', { give: action.give, giveAmount: action.giveAmount, receive: action.receive, receiveAmount: ratio[1] });
  });
}

/** Free action, like Equip/Unequip. Requires the hero to be standing at the player's
 *  Capital ("hometown") — see file header, point 3. */
export function applyDepositResources(state: GameState, action: DepositResourcesAction): GameState {
  requireCurrentPlayer(state, action.actorId);
  const player = findPlayer(state, action.actorId);
  const hero = resolveHero(player, action.heroId);
  if (!sameCoord(hero.position, player.capitalTile)) throw new IllegalActionError('Hero must be at your Capital to deposit resources');
  if (totalCarried(hero) === 0) throw new IllegalActionError('Nothing to deposit');

  return produce(state, (draft) => {
    const p = findPlayerMut(draft, action.actorId);
    const h = heroMut(p, action.heroId);
    const deposited: Partial<Record<ResourceType, number>> = {};
    for (const r of RESOURCE_TYPES) {
      if (h.carriedResources[r] <= 0) continue;
      deposited[r] = h.carriedResources[r];
      p.resources[r] += h.carriedResources[r];
      h.carriedResources[r] = 0;
    }
    pushEvent(draft, action.actorId, 'ResourcesDeposited', { deposited });
  });
}

// ── Cross-phase: AdvancePhase / EndTurn ─────────────────────────────────────────────────────

/** [DEFAULT — bugfix, found via a full-game AI balance simulation] Skips eliminated seats —
 *  previously this cycled turnOrder unconditionally, so a Capital capture set isEliminated but
 *  never actually stopped that player from taking turns: one simulated game saw an eliminated
 *  player keep playing for 39 more rounds (63% of the game), still gaining tiles and VP.
 *  isEliminated is otherwise only consulted for win-eligibility (selectors.ts) and by the AI to
 *  stop targeting a dead rival (ai/decideAction.ts) — ai/evaluate.ts's own
 *  "an eliminated rival can never contest this player again" comment assumed this was already
 *  true. Bounded to turnOrder.length steps so an edge case where literally everyone else is
 *  eliminated (Domination should have already ended the game before this can happen) can't spin
 *  forever — it falls back to leaving the current player on turn rather than crashing. */
function nextPlayerId(state: GameState): { playerId: PlayerId; newRound: boolean } {
  const order = state.turnOrder;
  let idx = order.indexOf(state.currentPlayerId);
  let newRound = false;
  for (let steps = 0; steps < order.length; steps++) {
    const prevIdx = idx;
    idx = (idx + 1) % order.length;
    if (idx <= prevIdx) newRound = true; // wrapped past the end of turnOrder
    const candidate = state.players.find((p) => p.id === order[idx]);
    if (candidate && !candidate.isEliminated) return { playerId: order[idx], newRound };
  }
  return { playerId: state.currentPlayerId, newRound: false };
}

/** Shared "close out this player's turn" logic used by both AdvancePhase (stepping past
 *  Phase 5) and EndTurn (an explicit early exit from any phase). */
/** [DEFAULT — Munchkin exploration layer] Shared exit gate for BOTH ways a turn can end
 *  (AdvancePhase stepping past Build, and the explicit EndTurn shortcut from any phase) — a
 *  hero can't just walk away from what's behind a door they opened this turn. */
function requireNoPendingDoorMonster(state: GameState, actorId: PlayerId) {
  const pending = state.pendingDoorMonster;
  if (!pending) return;
  const player = findPlayer(state, actorId);
  const belongsToActor = player.hero.id === pending.heroId;
  if (belongsToActor) {
    throw new IllegalActionError('A Door monster is still standing in your way — fight it (Phase 4) before ending your turn');
  }
}

function endTurn(state: GameState, actorId: PlayerId): GameState {
  requireNoPendingDoorMonster(state, actorId);
  const withRoundEnd = produce(state, (draft) => {
    pushEvent(draft, actorId, 'TurnEnded', {});
    const { newRound } = nextPlayerId(draft);
    if (newRound) {
      draft.roundNumber += 1;
      maybeEndRound(draft);
    }
  });
  if (withRoundEnd.winnerId) return withRoundEnd; // game just ended — don't start another turn
  const { playerId } = nextPlayerId(withRoundEnd);
  return resolveProductionForNewTurn(withRoundEnd, playerId);
}

export function applyAdvancePhase(state: GameState, action: { actorId: PlayerId }): GameState {
  requireCurrentPlayer(state, action.actorId);
  if (state.currentPhase === Phase.Build) {
    return endTurn(state, action.actorId);
  }
  // [DEFAULT — Munchkin exploration layer] Phases only ever move forward — there's no way back
  // to Phase 4 once Phase 5 begins — so this specific transition is the one place a pending Door
  // monster HAS to be blocked, not just at end-of-turn (requireNoPendingDoorMonster covers the
  // EndTurn shortcut from any earlier phase, but stepping phase-by-phase would otherwise sail
  // straight past Fight and leave the player permanently unable to reach it again).
  if (state.currentPhase === Phase.Fight) {
    requireNoPendingDoorMonster(state, action.actorId);
  }
  const nextPhase = (state.currentPhase + 1) as Phase;
  return produce(state, (draft) => {
    draft.currentPhase = nextPhase;
    pushEvent(draft, action.actorId, 'PhaseAdvanced', { to: nextPhase });
    // Tile production accumulates automatically the instant Phase 3 begins — see file header.
    if (nextPhase === Phase.Gather) {
      accumulateTileProduction(draft, action.actorId);
    }
  });
}

export function applyEndTurn(state: GameState, action: EndTurnAction): GameState {
  requireCurrentPlayer(state, action.actorId);
  return endTurn(state, action.actorId);
}
