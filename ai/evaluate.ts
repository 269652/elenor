/**
 * Heuristic position evaluation — turns a GameState into a single number "how good is this
 * for playerId," from that player's own perspective. Every other AI module (the phase-by-phase
 * decision logic in decideAction.ts, and the minimax search in territoryMinimax.ts) is built
 * on comparing this score across candidate futures; get this wrong and everything downstream
 * inherits the mistake, so every term is commented with why it's weighted the way it is.
 */

import {
  MEAT_UPKEEP_VALUE,
  SOLDIER_UPKEEP_FOOD_PER_GROUP,
  SOLDIER_UPKEEP_GROUP_SIZE,
  computeAllVictoryPoints,
  gearBonus,
  hexKey,
  roadConnectedTiles,
  soldierUpkeepUnits,
  totalCarried,
  type GameState,
  type Player,
} from '@/engine';
import { garrisonOwnerOf } from '@/engine/reducers';

const WEIGHTS = {
  victoryPoint: 10, // the actual win condition — dominant term by design
  ownedTile: 1.5, // territory is both economy and Domination-win progress
  /** [DEFAULT — roads] A road-connected tile banks its whole stockpile automatically every round
   *  (reducers.ts's collectRoadConnectedTiles) — no hero visit, no carry cap, no trip home. The
   *  same tile unconnected only pays out when the hero happens to walk there, which at movement 2
   *  is a few times a game. Scoring them identically told the AI its supply network was worth
   *  nothing, so it never built one. */
  roadConnectedTile: 1.2,
  /** [DEFAULT — territory rework] A tile of ours with a RIVAL garrison standing on it is not a
   *  tile we own for much longer: reducers.ts's claimHeldTerritory hands it over at the start of
   *  their next turn unless we march back and contest it first. Scoring it as still-ours would
   *  make the AI blind to exactly the moment when counter-attacking is decisive, so it's marked
   *  down to roughly what losing it will cost (1 VP + the tile itself), discounted a little for
   *  the chance the occupier gets dislodged by someone else. */
  occupiedByRival: 7,
  /** The mirror image: OUR troops standing on ground that isn't ours yet. Same discount, same
   *  reasoning — it becomes a real tile at the start of a later turn if it survives. */
  pendingOccupation: 5,
  /** ...and if that ground is a rival's Capital, claiming it eliminates them outright. */
  capitalAssault: 12,
  heroLevel: 3, // levels compound (combat power + eventual VP milestones + Hero-Level win)
  heroHpFraction: 4, // a hero at 10% HP is one bad roll from a costly respawn — weight the risk
  gearBonus: 1, // equipped combat power, smaller than level since it's more easily lost
  militia: 0.75, // standing army — real but cheaper than territory/VP to build up
  /** [DEFAULT — upkeep fix] Soldiers past what the wallet can actually feed this round are worth
   *  almost nothing: reducers.ts's resolveSoldierUpkeep deserts them at the start of the next turn
   *  and empties the Food AND Meat wallet trying to keep them first. A flat per-soldier value made
   *  an unfeedable army look like an asset, which is precisely the position a measured sweep
   *  caught every AI in — 116 desertion events against 87 successful upkeep payments. Non-zero,
   *  not negative, because they still fight if a battle happens before the bill does. */
  unfeedableMilitia: 0.1,
  resourceWealth: 0.15, // wallet + carried, summed across all 6 types; liquidity, not power
  eliminatedRivalBonus: 6, // an eliminated rival can never contest this player again
} as const;

export function evaluatePosition(state: GameState, playerId: string): number {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return -Infinity; // shouldn't happen; treat as a lost position rather than throw
  if (player.isEliminated) return -1000;

  let score = 0;
  score += computeAllVictoryPoints(state, player) * WEIGHTS.victoryPoint;
  score += player.ownedTiles.length * WEIGHTS.ownedTile;
  score += roadConnectedTiles(state, player).size * WEIGHTS.roadConnectedTile;
  score += scoreHero(player);
  score += scoreArmyAndOccupation(state, player);
  score += totalResourceWealth(player) * WEIGHTS.resourceWealth;

  for (const rival of state.players) {
    if (rival.id !== playerId && rival.isEliminated) score += WEIGHTS.eliminatedRivalBonus;
  }

  return score;
}

function scoreHero(player: Player): number {
  const hero = player.hero;
  let s = hero.level * WEIGHTS.heroLevel;
  s += (hero.hp / hero.maxHp) * WEIGHTS.heroHpFraction;
  s += gearBonus(hero) * WEIGHTS.gearBonus;
  if (player.secondHero) {
    s += player.secondHero.level * WEIGHTS.heroLevel;
    s += (player.secondHero.hp / player.secondHero.maxHp) * WEIGHTS.heroHpFraction;
    s += gearBonus(player.secondHero) * WEIGHTS.gearBonus;
  }
  return s;
}

/**
 * [DEFAULT — territory rework] Soldiers and contested ground, scored together because they're the
 * same fact seen twice: a garrison is only ever standing somewhere, and WHERE it stands is now
 * what decides who ends up owning that hex.
 *
 * Counts troops by garrisonOwnerOf across the WHOLE map rather than by walking ownedTiles —
 * an army parked on ground it hasn't claimed yet is still ours (and still eats), and a rival
 * army parked on our ground is emphatically not.
 */
function scoreArmyAndOccupation(state: GameState, player: Player): number {
  let soldiers = 0;
  let score = 0;

  for (const tile of Object.values(state.map)) {
    const garrison = garrisonOwnerOf(tile);
    if (garrison === player.id) {
      soldiers += tile.militiaCount ?? 0;
      if (tile.ownerId !== player.id) {
        score += WEIGHTS.pendingOccupation;
        const victim = state.players.find((p) => p.id === tile.ownerId);
        if (victim && hexKey(victim.capitalTile) === hexKey(tile.coord)) score += WEIGHTS.capitalAssault;
      }
    } else if (garrison !== null && tile.ownerId === player.id) {
      score -= WEIGHTS.occupiedByRival;
    }
  }

  // Split the army into the part this round's wallet can actually feed and the part that is
  // already deserting — see WEIGHTS.unfeedableMilitia.
  const feedable = feedableSoldierCount(player);
  score += Math.min(soldiers, feedable) * WEIGHTS.militia;
  score += Math.max(0, soldiers - feedable) * WEIGHTS.unfeedableMilitia;
  return score;
}

/** How many Soldiers this player's CURRENT wallet could pay upkeep on — the exact inverse of
 *  constants.ts's soldierUpkeepUnits, so the AI and the engine can never disagree about what an
 *  army costs. Exported because decideAction.ts gates deployments and offensives on it. */
export function feedableSoldierCount(player: Player): number {
  const foodEquivalent = player.resources.Food + player.resources.Meat * MEAT_UPKEEP_VALUE;
  return Math.floor(foodEquivalent / SOLDIER_UPKEEP_FOOD_PER_GROUP) * SOLDIER_UPKEEP_GROUP_SIZE;
}

/** Every Soldier this player owns, wherever it is standing — including an invasion force parked
 *  on foreign ground, which reducers.ts's resolveSoldierUpkeep bills them for all the same. */
export function ownedSoldierCount(state: GameState, playerId: string): number {
  let total = 0;
  for (const tile of Object.values(state.map)) {
    if (garrisonOwnerOf(tile) === playerId) total += tile.militiaCount ?? 0;
  }
  return total;
}

/** Can this player pay the bill its standing army will present at the start of its next turn?
 *  False means every extra Soldier is a desertion waiting to happen. */
export function canFeedArmy(state: GameState, player: Player): boolean {
  const soldiers = ownedSoldierCount(state, player.id);
  if (soldiers === 0) return true;
  const foodEquivalent = player.resources.Food + player.resources.Meat * MEAT_UPKEEP_VALUE;
  return foodEquivalent >= soldierUpkeepUnits(soldiers);
}

/** Soldiers this player is over-extended by, in whole upkeep groups — 0 when solvent. Used to
 *  decide how loudly the build logic should shout for a Cow Stable. */
export function upkeepShortfallGroups(state: GameState, player: Player): number {
  const soldiers = ownedSoldierCount(state, player.id);
  if (soldiers === 0) return 0;
  const missing = soldiers - feedableSoldierCount(player);
  if (missing <= 0) return 0;
  return Math.ceil(missing / SOLDIER_UPKEEP_GROUP_SIZE);
}

function totalResourceWealth(player: Player): number {
  const wallet = Object.values(player.resources).reduce((a, b) => a + b, 0);
  const carried = totalCarried(player.hero);
  return wallet + carried;
}

/** Zero-sum framing for a specific rivalry — "how much better off is `playerId` than
 *  `rivalId`," used by territoryMinimax.ts where the adversarial reasoning is scoped to one
 *  attacker/defender pair rather than the whole table. */
export function relativeEvaluation(state: GameState, playerId: string, rivalId: string): number {
  return evaluatePosition(state, playerId) - evaluatePosition(state, rivalId);
}
