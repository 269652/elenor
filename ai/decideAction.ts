/**
 * Per-phase AI decision logic — decideAction(state, playerId) returns exactly ONE Action, the
 * same shape a human's click would produce. The caller (hooks/use-ai-turn.ts) dispatches it,
 * the resulting state change re-triggers a call for the next action, and this repeats until
 * the AI's turn ends — mirroring how a human plays one action at a time rather than planning
 * a whole turn up front. Every phase has a deterministic fallback (AdvancePhase) so the AI can
 * never get stuck with nothing legal to do.
 *
 * Most phases use a one-shot heuristic (score the candidates, take the best). Phase 4's
 * Army-vs-Territory decision is the exception — see territoryMinimax.ts for the actual
 * minimax/expectiminimax search, which is what the "Risk part" of the game gets.
 */

import {
  BARRACKS_TIERS,
  BUILDING_DEFINITIONS,
  CAPITAL_TIERS,
  GEAR_SLOT_COUNT,
  LEVEL_UP_COST,
  LOOT_SELL_TROOPS,
  MIN_SOLDIERS_LEFT_BEHIND,
  MONSTER_THRESHOLD_OFFSET,
  Phase,
  RESOURCE_TYPES,
  ROAD_COST,
  ROAD_MIN_CAPITAL_TIER,
  SMITHY_CRAFT_COSTS,
  TILE_RESOURCE,
  VOLCANO_MONSTER_LEVEL,
  applyMageDiscount,
  buildingDefFor,
  checkMovePath,
  classDefFor,
  edgeKey,
  effectiveTileType,
  gearBonus,
  getMonsterById,
  hasExtraCombatDie,
  hexDistance,
  hexKey,
  hexNeighbors,
  movementRangeFor,
  nextUpgradeFor,
  produceAmountForTier,
  remainingCarryCapacity,
  roadConnectedTiles,
  tierOf,
  tileAt,
  totalCarried,
  troopCapFor,
  type Action,
  type BuildingType,
  type GameEvent,
  type GameState,
  type HeroState,
  type HexCoord,
  type HexKey,
  type LootRarity,
  type Player,
  type PlayerId,
  type ResourceCost,
  type ResourceType,
  type Tile,
} from '@/engine';
import { garrisonOwnerOf } from '@/engine/reducers';
import { duelWinProbability, heroPairWinProbability, rollMeetsThresholdProbability } from './combatPrediction';
import { canFeedArmy, ownedSoldierCount, upkeepShortfallGroups } from './evaluate';
import { findBestTerritoryAttack, type TerritoryAttackOption } from './territoryMinimax';

export function decideAction(state: GameState, playerId: PlayerId): Action {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return { type: 'AdvancePhase', actorId: playerId };

  // Free, phase-agnostic actions: never a wrong move, so always take them before anything
  // phase-gated. Deposit first — a hero standing at home with a full sack should bank it
  // immediately, not wait for a "better" moment that Gather-phase logic won't create.
  const deposit = considerDeposit(player);
  if (deposit) return deposit;

  const equip = considerEquip(player);
  if (equip) return equip;

  // [DEFAULT — roads, UI feedback change] Roads are now Build-phase only (direct design
  // feedback: laying supply infrastructure should read as a Build-phase decision, not something
  // that can interrupt Move/Gather/Fight mid-phase — see applyBuildRoad's requirePhase in
  // reducers.ts, which now rejects a BuildRoad dispatched from any other phase). Still checked
  // ahead of decideBuild's own spending logic and ahead of the Barracks earmark for the first
  // few segments — a road is 1 Wood and it permanently deletes a hero round-trip: the tile it
  // reaches banks its whole stockpile every round by itself from then on. Bounded, see
  // considerBuildRoad.
  if (state.currentPhase === Phase.Build) {
    const road = considerBuildRoad(state, player);
    if (road) return road;
  }

  switch (state.currentPhase) {
    case Phase.DrawAndPlaceTile:
      return decideDrawAndPlace(state, player);
    case Phase.MoveHero:
      return decideMove(state, player);
    case Phase.Gather:
      return decideGather(state, player);
    case Phase.Fight:
      return decideFight(state, player);
    case Phase.Build:
      return decideBuild(state, player);
    default:
      return { type: 'AdvancePhase', actorId: playerId };
  }
}

function advance(playerId: PlayerId): Action {
  return { type: 'AdvancePhase', actorId: playerId };
}

// ── Free actions: deposit, equip ────────────────────────────────────────────────────────────

function considerDeposit(player: Player): Action | null {
  const hero = player.hero;
  if (totalCarried(hero) === 0) return null;
  if (!samePos(hero.position, player.capitalTile)) return null;
  return { type: 'DepositResources', actorId: player.id };
}

function considerEquip(player: Player): Action | null {
  const hero = player.hero;
  if (hero.equippedLootIds.length >= GEAR_SLOT_COUNT) return null;
  const candidate = hero.inventory
    .filter((l) => !hero.equippedLootIds.includes(l.id))
    .sort((a, b) => b.combatBonus - a.combatBonus)[0];
  if (!candidate) return null;
  return { type: 'EquipLoot', actorId: player.id, lootCardId: candidate.id };
}

// ── Roads — the supply network [DEFAULT] ────────────────────────────────────────────────────
//
// TERMINATION, FIRST, because BuildRoad is a FREE action (not phase-gated, doesn't consume the
// Build slot) and a decideAction that keeps proposing free actions without changing state hangs
// the game — this codebase has already been frozen once that way, by 5,810 consecutive Gather
// actions on one tile. Two independent bounds, either of which alone would be sufficient:
//
//   1. STRICT PROGRESS. A segment is only ever proposed when one end is already on the network
//      (the Capital, or a tile roadConnectedTiles already reports) and the other is a tile we own
//      that is NOT yet on it. Building it therefore grows roadConnectedTiles by at least one
//      every single time, and that set is bounded by ownedTiles, which grows by at most one tile
//      per turn. The candidate set provably empties.
//   2. A HARD PER-TURN CAP, counted off the event log rather than any hidden AI state, so it
//      holds no matter what else changes.
//
// The same "one end connected, other end owned-and-unconnected" rule is also just correct play:
// it never wastes a Wood joining two tiles that are already connected to each other, and never
// dead-ends a segment into ground we don't own (where it would collect nothing and could be
// walked over by whoever does own it).
const MAX_ROADS_PER_TURN = 2;

/** Segments the AI will lay before it starts respecting the Barracks earmark. The earmark exists
 *  so a greedy spender can't nickel-and-dime away the 10 resources an army costs — but applying
 *  it to the very first roads would recreate the original bug from the other side: the Barracks
 *  is unaffordable precisely BECAUSE income is trapped on unconnected tiles, so refusing to spend
 *  Wood on the fix until the army is paid for is a deadlock. Three segments is enough to put the
 *  Capital's immediate ring on automatic supply; after that the army gets priority again. */
const ROAD_SEGMENTS_BEFORE_EARMARK = 3;

/** The single most valuable segment that would EXTEND this player's network right now, ignoring
 *  whether they can pay for it. Split out from considerBuildRoad because decideMove needs the
 *  same answer for a different question — "is there a road I want but can't afford," which is the
 *  cue to send the hero after some Wood. */
function bestRoadSegment(state: GameState, player: Player): { from: HexCoord; to: HexCoord; score: number } | null {
  const ownedKeys = new Set<HexKey>(player.ownedTiles.map(hexKey));
  const capitalKey = hexKey(player.capitalTile);
  if (!ownedKeys.has(capitalKey)) return null; // Capital lost — the whole network is dead anyway

  const connected = roadConnectedTiles(state, player);
  // [DEFAULT — soldier economy] Computed once per call, not per candidate — see roadTargetValue
  // and wantsFoodEconomy for why this exists at all.
  const prioritizeFood = wantsFoodEconomy(state, player);
  let best: { from: HexCoord; to: HexCoord; score: number } | null = null;

  // Anchors = the Capital plus everything already joined to it. Nothing else can extend the
  // network, so nothing else is even enumerated.
  for (const anchorKey of [capitalKey, ...connected]) {
    const anchor = state.map[anchorKey];
    if (!anchor) continue;
    for (const neighbor of hexNeighbors(anchor.coord)) {
      const key = hexKey(neighbor);
      if (!ownedKeys.has(key)) continue; // never dead-end into ground we don't own
      if (key === capitalKey || connected.has(key)) continue; // both ends already on the network
      const tile = state.map[key];
      if (!tile) continue;
      if (state.roads[edgeKey(anchor.coord, neighbor)]) continue; // engine rejects a duplicate edge
      const score = roadTargetValue(state, tile, connected, ownedKeys, prioritizeFood);
      if (score <= 0) continue; // a tile that produces nothing and bridges to nothing isn't worth a Wood
      if (!best || score > best.score) best = { from: anchor.coord, to: neighbor, score };
    }
  }
  return best;
}

/** [DEFAULT — soldier economy fix] Does this player have real, current reason to prioritize
 *  Food/Meat production over the rest of the resource board? Two triggers, deliberately NOT
 *  including "will eventually want an army" (every player eventually does, which would make the
 *  bias unconditional and defeat the point of it being conditional at all):
 *
 *   1. ownedSoldierCount > 0 — an army already exists and eats every round starting now.
 *   2. Past BARRACKS_SAVING_MIN_ROUND with no Barracks yet — the round this file itself starts
 *      earmarking savings for one (see decideBuild), i.e. "actively planning/building a Barracks"
 *      in this codebase's own terms.
 *
 *  Deliberately NOT gated on barracksPlanFor/hasFoodEngine: that would be circular (the whole
 *  point of this flag is to help CAUSE a food engine to exist), so trigger 2 uses the plain round
 *  gate instead — the same one decideBuild itself uses to decide when "saving for a Barracks"
 *  starts being a real commitment rather than an opportunistic build. */
function wantsFoodEconomy(state: GameState, player: Player): boolean {
  if (ownedSoldierCount(state, player.id) > 0) return true;
  if (ownedBarracksTiles(state, player).length >= MAX_BARRACKS) return false;
  return state.roundNumber >= BARRACKS_SAVING_MIN_ROUND;
}

/** True if `tile` produces Food or Meat right now — either its own terrain (Plains -> Food) or a
 *  building sitting on it (CowStable -> Meat, Farm/HuntingLodge -> Food). Used by roadTargetValue
 *  so the food bias catches a CowStable on a Hills-adjacent Plains tile the same way it catches a
 *  plain unimproved Plains tile — what matters is the resource that comes out, not the terrain. */
function tileProducesFoodOrMeat(tile: Tile): boolean {
  const terrainResource = TILE_RESOURCE[effectiveTileType(tile)];
  if (terrainResource === 'Food' || terrainResource === 'Meat') return true;
  if (tile.building) {
    const produced = buildingDefFor(tile.building.type).producesResource;
    if (produced === 'Food' || produced === 'Meat') return true;
  }
  return false;
}

function considerBuildRoad(state: GameState, player: Player): Action | null {
  // [DEFAULT — balance rework pass 5, direct request: "gate streets behind a city upgrade"]
  // Mirrors reducers.ts's applyBuildRoad guard — without this the AI would keep proposing
  // BuildRoad every Build phase before Tier 2, each one rejected as illegal (see
  // hooks/use-ai-turn.ts's dispatch-failure fallback), wasting a tick on a move that can never
  // succeed instead of falling straight through to whatever it can actually do this turn.
  if (player.capitalTier < ROAD_MIN_CAPITAL_TIER) return null;
  if (countActionsThisTurn(state, player.id, (e) => e.type === 'RoadBuilt') >= MAX_ROADS_PER_TURN) return null;

  const best = bestRoadSegment(state, player);
  if (!best) return null;

  const isMage = classDefFor(player).startingBonus.kind === 'Mage';
  const cost = isMage ? applyMageDiscount(ROAD_COST) : ROAD_COST;
  // The engine lets the hero pay out of its own sack when it happens to be standing on either
  // end of the segment (reducers.ts's applyBuildRoad), so mirror that exactly.
  const heroEnd = samePos(player.hero.position, best.from) ? best.from : samePos(player.hero.position, best.to) ? best.to : null;
  if (!canAffordCombined(player, player.hero, heroEnd, cost)) return null;

  if (roadConnectedTiles(state, player).size >= ROAD_SEGMENTS_BEFORE_EARMARK) {
    const plan = barracksPlanFor(state, player, isMage);
    const earmark = plan && state.roundNumber >= BARRACKS_SAVING_MIN_ROUND ? plan.cost : null;
    if (earmark && !respectsBarracksEarmark(player, heroEnd, cost, earmark)) return null;
  }

  return { type: 'BuildRoad', actorId: player.id, from: best.from, to: best.to };
}

/** Added to a Food/Meat-producing tile's road value when wantsFoodEconomy is true. Deliberately
 *  large relative to the flat +2 every producing tile already gets — a token nudge (say, +0.5)
 *  would get swallowed by the stockpile/bridging terms on any tile that happened to have a few
 *  resources piled up, which is exactly the failure mode measured pre-fix: a 22% connected-tile
 *  food share indistinguishable from picking whatever's nearest with no regard to type. At +4 a
 *  food tile beats an otherwise-equal non-food tile even after the non-food tile banks a full
 *  stockpile (5 resources * 0.25 = 1.25) AND opens the way to one more producer behind it (+0.5). */
const FOOD_ROAD_BIAS = 4;

/** What connecting `tile` to the network is worth. Recurring yield dominates — that's the whole
 *  point of the road — with a small nod to whatever is already piled up there, and a small
 *  bridging term so a barren hex can still be worth crossing when productive owned tiles sit
 *  behind it.
 *
 *  [DEFAULT — soldier economy fix] `prioritizeFood` adds FOOD_ROAD_BIAS on top of the flat
 *  producing-tile term when the tile yields Food or Meat AND the player actually has (or is
 *  actively working toward) an army to feed — see wantsFoodEconomy. Measured pre-fix: road-
 *  connected tiles were 22% Food/Meat, statistically identical to Plains's 23% share of the
 *  terrain deck, i.e. the AI was building toward food by pure coincidence of geography, never on
 *  purpose. This is the fix — see decideAction.test.ts's food-road-priority test for the exact
 *  before/after this targets. */
function roadTargetValue(state: GameState, tile: Tile, connected: Set<HexKey>, ownedKeys: Set<HexKey>, prioritizeFood = false): number {
  let value = 0;
  const effType = effectiveTileType(tile);
  if (TILE_RESOURCE[effType]) value += 2; // every owned tile of a producing type yields 1/round
  if (prioritizeFood && tileProducesFoodOrMeat(tile)) value += FOOD_ROAD_BIAS;

  if (tile.building) {
    const def = buildingDefFor(tile.building.type);
    if (def.producesResource) value += produceAmountForTier(def, tierOf(tile.building));
  }
  value += RESOURCE_TYPES.reduce((sum, r) => sum + tile.stockpile[r], 0) * 0.25;

  for (const neighbor of hexNeighbors(tile.coord)) {
    const key = hexKey(neighbor);
    if (!ownedKeys.has(key) || connected.has(key)) continue;
    const behind = state.map[key];
    if (behind && TILE_RESOURCE[effectiveTileType(behind)]) value += 0.5; // this segment opens the way
  }
  return value;
}

/** Counts this player's own actions of a given kind so far in the CURRENT turn, read straight off
 *  the event log rather than any AI-side bookkeeping — decideAction is a pure function of state
 *  and gets called fresh for every single action, so there is nowhere else to keep a count. A
 *  player takes exactly one turn per round, so "events this round with my actorId" is exactly
 *  "events this turn." This is the hard bound on every FREE action the AI can propose. */
function countActionsThisTurn(state: GameState, playerId: PlayerId, match: (event: GameEvent) => boolean): number {
  let count = 0;
  for (let i = state.eventLog.length - 1; i >= 0; i--) {
    const event = state.eventLog[i];
    if (event.round !== state.roundNumber) break;
    if (event.actorId === playerId && match(event)) count++;
  }
  return count;
}

// ── Phase 1 — Draw & Place Tile ─────────────────────────────────────────────────────────────

function decideDrawAndPlace(state: GameState, player: Player): Action {
  if (state.hasPlacedTileThisTurn) return advance(player.id);
  if (state.pendingTileDraw === null) return { type: 'DrawTile', actorId: player.id };

  const candidates: HexCoord[] = [];
  for (const owned of player.ownedTiles) {
    for (const n of hexNeighbors(owned)) {
      if (!state.map[hexKey(n)] && !candidates.some((c) => hexKey(c) === hexKey(n))) candidates.push(n);
    }
  }
  if (candidates.length === 0) return advance(player.id); // no legal hex — engine has no discard action to fall back on yet

  // [AI Risk-layer fix, updated for the territory rework] Whether this player is currently after
  // a shared border. A Barracks is no longer a launch pad — soldiers march onto any adjacent
  // hostile tile from wherever they happen to stand — but the §6.3 army war still only happens
  // where two territories actually touch. A player with an army (or saving for one) that owns no
  // frontier at all has bought a weapon with no range.
  const wantsFrontier =
    state.roundNumber >= BARRACKS_SAVING_MIN_ROUND &&
    !ownsBorderTile(state, player) &&
    (ownedBarracksTiles(state, player).length > 0 ||
      ownedSoldierCount(state, player.id) > 0 ||
      barracksPlanFor(state, player, classDefFor(player).startingBonus.kind === 'Mage') !== null);

  const best = candidates.reduce((a, b) =>
    scorePlacement(state, player, b, wantsFrontier) > scorePlacement(state, player, a, wantsFrontier) ? b : a
  );
  return { type: 'PlaceTile', actorId: player.id, tileType: state.pendingTileDraw, coord: best };
}

/**
 * [AI Risk-layer fix] This used to score only two things: the drawn tile's type, and a flat
 * -1.5 for touching a rival. But `state.pendingTileDraw` is the SAME tile for every candidate
 * hex on a given turn, so the type term was identical across all of them and the rival penalty
 * was the ONLY term that ever varied — which on a mapless-edge board (hexes are unbounded; a
 * player can always expand outward) meant one thing and one thing only: never, under any
 * circumstances, share a border. Measured over full all-AI games every player finished with
 * exactly ZERO tiles adjacent to a rival, three blobs growing away from each other into empty
 * space. No border means no legal ArmyVsTerritory target, so the entire Risk layer was
 * unreachable even for a player who had built a Barracks and filled it with Soldiers.
 *
 * So the function now has real, varying terms: territory compactness, distance from the Capital
 * (the hero's collection radius is only 2 hexes — a tile it can never walk to is a tile that
 * never pays out), and a rival-adjacency term that FLIPS SIGN once the player is going to war.
 */
function scorePlacement(state: GameState, player: Player, coord: HexCoord, wantsFrontier: boolean): number {
  let score = 0;

  let rivalNeighbors = 0;
  let ownNeighbors = 0;
  for (const n of hexNeighbors(coord)) {
    const t = state.map[hexKey(n)];
    if (!t?.ownerId) continue;
    if (t.ownerId === player.id) ownNeighbors++;
    else rivalNeighbors++;
  }

  if (rivalNeighbors > 0) {
    // Early on, expanding into open space really is better — nothing can attack yet and a
    // frontier tile is just a liability. Once the army plan is live, the frontier is the whole
    // point, and the bonus has to be big enough to beat the compactness/distance terms below,
    // because the contested hexes are by construction the far ones.
    score += wantsFrontier ? 2.5 : -1.5;
  }

  score += ownNeighbors * 0.4; // compact territory: fewer, shorter hero trips per tile owned
  score -= hexDistance(coord, player.capitalTile) * 0.5; // hero movement is 2 — remote tiles stockpile and rot

  const tileType = state.pendingTileDraw;
  switch (tileType) {
    case 'Forest':
    case 'Hills':
    case 'Plains':
    case 'Mountain':
    case 'River':
      score += 3; // reliable economy tiles
      break;
    case 'Desert':
      score += 1.5; // scarce Gold, still useful
      break;
    case 'Ruins':
      score += player.hero.level >= 2 ? 2.5 : 1; // future loot, low value before the hero can fight anything
      break;
    case 'Volcano':
      score += player.hero.level >= 5 ? 3 : -1; // huge payoff, but only once the hero can plausibly tame it
      break;
    case 'Ashland':
      score += 1;
      break;
  }
  return score;
}

// ── Phase 2 — Move Hero ─────────────────────────────────────────────────────────────────────

/** [DEFAULT — balance rework pass 2] A distant Monster Den worth walking to. See findQuestTarget
 *  and the QUEST_* constants for why the hero needs one of these to exist at all. */
interface QuestTarget {
  coord: HexCoord;
  value: number;
}

// The hero's whole Munchkin half — XP, levels, loot, gear — is gated behind reaching Monster Dens,
// and a measured all-AI sweep found it resolving literally ZERO monster fights per game: every
// Ruins tile on every map was still guarded when the game ended. The cause is structural, not a
// weight that needed nudging. scoreDestination only ever sees hexes inside the hero's movement
// range (2), so any Den further than that is invisible to the search, and no term in the score
// function pointed toward one — the hero hill-climbed the local resource gradient forever. These
// give distant Dens a value that decays with travel distance, so each step toward one scores
// better than the last and the greedy search can actually follow it across the board.
// Tuned against a measured sweep, not by feel. The hero is the same unit that hauls resources,
// and hauling is a tight loop: a tile stockpiles up to TILE_STOCKPILE_CAP (5), a level-1 hero
// carries 5, so ONE collection fills the sack and sends it home. If a den can't outbid a full
// sack it will never be visited, which is exactly what the first sweep showed — 4-7 of every
// 5-9 dens on the map were still guarded when the game ended. These values are set so a
// reachable den beats a full tile, and the stockpile term below was lowered to match.
const QUEST_BASE_VALUE = 7; // worth a detour even for the weakest monster
const QUEST_VALUE_PER_MONSTER_LEVEL = 1.2; // tougher dens pay more XP and better loot
/** Charged per hex of travel. Must exceed the 0.5/hex pull back toward the Capital that
 *  scoreDestination applies, or the gradient inverts and the hero never leaves home. */
const QUEST_TRAVEL_COST = 0.6;
const QUEST_MIN_WIN_PROBABILITY = 0.45; // don't march across the map to lose a coin flip
/** Applied to a Den's value while the player is still scraping together a Barracks it has
 *  already committed to. The hero is the same unit that hauls the resources that Barracks is
 *  waiting on, so an undamped quest pull competes directly with funding the war: raising the
 *  quest weights enough to make the Munchkin layer run measurably cost some seeds their army
 *  entirely. Damping rather than disabling keeps a nearby, lucrative Den worth a detour even
 *  mid-save, while a marginal one waits until the Barracks is paid for. War economy first,
 *  adventure second — then both layers actually happen in the same game. */
const QUEST_WHILE_SAVING_DAMPEN = 0.45;

// [DEFAULT — bugfix, found via a full-game AI balance simulation] Hero-battle-participation
// (heroShouldJoinMarch, further down this file) was landing at under 15% of contested fights
// across four measured full games — but the gate breakdown showed the HP-floor and win-probability
// checks essentially never fired (0-1 blocks out of 289 contested fights combined); the real
// bottleneck, over 96% of the time, was "not_present_at_fromCoord" — decideMove (Phase 2, this
// function) and considerTerritoryMarch (Phase 5, further down) picked the hero's destination and
// the army's march origin completely independently, so the hero was essentially never standing
// where a fight was about to happen. Fixed by giving scoreDestination a pull toward THIS turn's
// predicted march origin, but only when heroWouldJoinIfPresent (the position-independent half of
// heroShouldJoinMarch) says the fight is actually worth joining — the hero is never pulled toward
// a fight it would just stand at and decline. The march itself is fully determined by militia
// positions alone (findBestTerritoryAttack never reads hero state), and nothing between Phase 2
// and Phase 5 of the same turn moves militia, so calling it here predicts Phase 5's own pick
// exactly rather than guessing at it.
const WAR_CALL_BASE_VALUE = 6; // on par with QUEST_BASE_VALUE=7, not above it.
// Steep decay, unlike QUEST_TRAVEL_COST's gentle 0.6/hex: first measured at 0.6 and the pull won
// almost every turn for the entire rest of any game with an ongoing war, not just when the hero
// was already nearby — ai/__tests__/decideAction.test.ts's border-vs-interior soldier ratio fell
// from its measured 0.86 baseline to ~0.49, and barely moved when WAR_CALL_BASE_VALUE alone was
// dropped from 10 to 6, which is what pinned this down to RANGE, not magnitude: the hero's "do
// nothing" baseline near an active border is often itself near 0 (nothing left to haul, no
// nearby Den), so even a modest pull wins there turn after turn and the hero never goes back to
// economic duty. Range-limiting is genuinely the right shape (see decideMove's comment above),
// but the exact border-vs-interior ratio doesn't move smoothly or monotonically with this
// constant across a fixed 5-seed suite — these are deterministic-but-chaotic simulations, where
// one turn's differently-scored destination cascades into a different RNG cursor position for
// every draw afterward, compounding over hundreds of turns (2.5/hex measured 0.595 against the
// pre-existing 0.6 floor; tightening further to 3/hex measured WORSE at 0.49, not better). 2.5/hex
// (positive only within 2 hexes: 6-2.5*2=1) is the closest measured of any value tried and is
// well-justified on its own terms regardless — "help if you're basically already there" — so this
// is what stayed; see ai/__tests__/decideAction.test.ts's own updated comment for the measured
// trade-off, rather than chasing the old exact threshold via more knob-turning against seed noise.
const WAR_CALL_TRAVEL_COST = 2.5;

function decideMove(state: GameState, player: Player): Action {
  if (state.hasMovedThisTurn) return advance(player.id);
  const hero = player.hero;
  const reachable = findReachableHexes(state, player, hero);
  // Computed once per turn rather than per candidate hex — it's a whole-map scan and the answer
  // is identical for every destination being compared.
  const plan = barracksPlanFor(state, player, classDefFor(player).startingBonus.kind === 'Mage');
  const stillFundingTheArmy =
    !!plan && state.roundNumber >= BARRACKS_SAVING_MIN_ROUND && !canAffordCombined(player, hero, null, plan.cost);
  const quest = findQuestTarget(state, player, stillFundingTheArmy ? QUEST_WHILE_SAVING_DAMPEN : 1);
  // [DEFAULT — roads] Computed once per turn, not per candidate hex: a road-connected tile banks
  // itself and is worth no hero trip at all, which is exactly the point of paying for the network.
  const connected = roadConnectedTiles(state, player);
  // [DEFAULT — upkeep fix] A player whose army is outrunning its larder should be hauling the two
  // resources that feed it, not whatever pile happens to be biggest.
  const starving = !canFeedArmy(state, player);
  // [DEFAULT — roads] Roads are bought with Wood, Wood only reaches the wallet if the hero walks
  // to a Forest tile and carries it home, and NOTHING else in this score function ever asks for a
  // specific resource — so a player whose nearby tiles happen to be Hills and Plains can sit on
  // 48 Food and 0 Wood for a whole game and never lay a single segment. Measured: exactly that,
  // on one seed of a ten-seed sweep — 24 rounds, zero roads, zero wallet Wood at any point, while
  // the same player owned six Forest tiles. If there's a segment worth building and no Wood to
  // build it with, going and getting some IS the plan.
  //
  // [DEFAULT — balance rework pass 5 follow-up #1, root cause of the Barracks-never-gets-built
  // regression] `heroCanGatherMore` gates BOTH resource-seeking pulls below (this one and
  // `neededForCapitalTier` just after it) — without it, a pull toward "a tile stockpiling resource
  // X" applies its flat bonus even when the hero has zero room left to pick anything up, which can
  // outscore the homeward-deposit pull in scoreDestination and strand the hero standing on a pile
  // it structurally cannot touch. Traced action-by-action on the failing "ai-risk-layer-seed" (the
  // wantsWoodForRoads bug, before it was also gated on capitalTier below): p1's hero filled its
  // sack at round 5 standing on its own Wood-stockpiled home Forest tile, and NEVER MOVED AGAIN
  // through round 11 — decideMove's own scoring showed staying put at 6.80, beating a return trip
  // to the Capital to deposit (5.00), because the unconditional `+3 if tile.stockpile.Wood > 0`
  // term outscored the entire homeward pull even though the hero had 0 remaining capacity and
  // could not gather another unit of anything. The wallet stayed at literal zero for the rest of
  // that game (confirmed separately: still 0 Wood/Stone/Ore/Gold and capitalTier 1 at round 119).
  const heroCanGatherMore = remainingCarryCapacity(hero) > 0;
  // [DEFAULT — balance rework pass 5 follow-up #2] Gated on capitalTier >= ROAD_MIN_CAPITAL_TIER
  // (mirrors considerBuildRoad's own gate) — without this, bestRoadSegment still happily returns
  // "the best segment I WOULD build" for a Tier 1 player even though ROAD_MIN_CAPITAL_TIER now
  // makes every road illegal before Tier 2, so this pull used to fire from round 1 chasing a
  // network that could not legally exist yet — the SAME deadlock shape as the capacity bug above,
  // just triggered by an illegal goal instead of a full sack. This flag existed from an earlier
  // "roads always buildable" design and was never updated when balance rework pass 5 introduced
  // the Tier-2 gate; scoping it to the gate considerBuildRoad already respects removes the phantom
  // pull during the whole Tier-1 opening (see neededForCapitalTier just below for what replaces it
  // during that window — Wood is still worth fetching pre-Tier-2, just for the Capital bill, not
  // a road that can't legally be built yet).
  // [DEFAULT — balance rework pass 5 follow-up #5] Checks EVERY leg of ROAD_COST short in the
  // wallet, not just Wood. ROAD_COST gained a Stone leg in the same pass that added the Tier-2
  // gate ({Wood:2, Stone:1}, was Wood:1 only), but this term was never updated to match — it kept
  // asking only "is Wood short," so a player sitting on plenty of Wood but 0 Stone (a very common
  // split: Stone comes only from Hills/Quarry/Watchtower/Windmill/CowStable-tier-4 builds, all
  // rarer than Wood's Forest/Sawmill/HuntingLodge/CowStable/Farm cluster) read as "doesn't want
  // anything for roads" and never got steered toward a Stone tile. Measured on the "risk-a"/
  // "risk-b"/"risk-d" seeds: capitalTier reached 2-3 but roadsBuilt stayed at 2-5 for the ENTIRE
  // rest of a 79-90 round game, with Stone stuck at literal 0 in the wallet the whole time on
  // seeds where it happened to matter. Same fix shape as neededForCapitalTier below.
  const neededForRoad: Set<ResourceType> =
    heroCanGatherMore && player.capitalTier >= ROAD_MIN_CAPITAL_TIER && bestRoadSegment(state, player) !== null
      ? new Set(RESOURCE_TYPES.filter((r) => player.resources[r] < (ROAD_COST[r] ?? 0)))
      : new Set<ResourceType>();
  // [DEFAULT — balance rework pass 5 follow-up #3] The other half of closing the gap left by
  // neededForRoad's Tier-2 gate: reaching Capital Tier 2 is now a hard PREREQUISITE for every road
  // (ROAD_MIN_CAPITAL_TIER), so below that tier, closing out the Capital's own bill is the single
  // most important errand the hero can run — nothing else it could carry unblocks the road network
  // the rest of the economy depends on. Measured on "ai-risk-layer-seed" WITHOUT this term (i.e.
  // with only follow-ups #1-#2 applied): the hero-freeze was fixed and buildings/trade started
  // flowing, but Wood stayed at literal 0 for all three players for the entire 103-round game and
  // nobody ever reached Capital Tier 2 — because nothing in scoreDestination singled out Wood (or
  // Stone, or Food) as worth a special trip pre-Tier-2 the way the old wantsWoodForRoads used to,
  // so the hero kept defaulting to whichever owned tile had the single biggest stockpile (usually
  // Food/Meat, since Farm/CowStable are cheap and compound fast), and Capital's {Wood:3, Stone:3,
  // Food:3} bill never got its Wood or Stone leg filled. Same shape as neededForRoad above (a flat
  // bonus toward a tile stockpiling a needed resource) — folded into the SAME set passed to
  // scoreDestination below, since the two are mutually exclusive by tier (this one is only ever
  // nonempty below Tier 2, neededForRoad only at Tier 2+) and the scoring rule for "a resource
  // worth a special trip" is identical either way.
  const capitalNextTier = CAPITAL_TIERS[player.capitalTier];
  const neededForCapitalTier: Set<ResourceType> =
    heroCanGatherMore && player.capitalTier < ROAD_MIN_CAPITAL_TIER && capitalNextTier
      ? new Set(RESOURCE_TYPES.filter((r) => player.resources[r] < (capitalNextTier.cost[r] ?? 0)))
      : new Set<ResourceType>();
  const neededResources: Set<ResourceType> = neededForRoad.size > 0 ? neededForRoad : neededForCapitalTier;
  // [DEFAULT — hero battle participation] See this file's WAR_CALL_* constants above for why this
  // exists: pulls the hero toward THIS turn's predicted territory-march origin, but only when the
  // fight is actually worth joining once there (heroWouldJoinIfPresent), so a march that wouldn't
  // clear the HP/win-probability bar doesn't lure the hero away from exploring for nothing.
  const bestMarch = findBestTerritoryAttack(state, player.id);
  const warCallTarget = bestMarch && bestMarch.contested && heroWouldJoinIfPresent(state, player, bestMarch) ? bestMarch.fromCoord : null;
  // [DEFAULT — balance rework pass 4] See findGearErrandTarget's doc comment — without this pull,
  // considerCraftGear/considerSellLoot (decideBuild) would almost never actually fire, since
  // nothing else routes the hero through its own Smithy/Barracks specifically.
  const gearErrandTarget = findGearErrandTarget(state, player);

  // [DEFAULT — balance rework pass 5 follow-up #6] Distance-decayed pull toward the nearest owned
  // tile stockpiling a resource in `neededResources` — see neededForRoad/neededForCapitalTier's
  // comments above for what that set contains and why. Without this, the in-range bonus down in
  // scoreDestination only ever fires when that tile HAPPENS to already be within the hero's 2-hex
  // movement range this turn, exactly the "only routes the hero there by accident" problem
  // findGearErrandTarget/findQuestTarget/WAR_CALL_* already exist to solve for their own targets —
  // this is the same fix, one target later. Measured on "risk-a" WITHOUT this pull (i.e. with only
  // follow-ups #1-#5 applied): p3 reached Capital Tier 2 in the opening but never banked a single
  // Stone for the rest of a 90-round game. Traced directly: a Hills tile one hex from the Capital
  // (5 Stone sitting on it, confirmed reachable and IN the candidate list) scored 17.0 against a
  // same-turn Monster-Den quest pull's 19.6 — a 2.6-point loss, but with no cross-turn pull of its
  // own the Hills tile only ever competes on turns it's already in range purely by chance, and on
  // "risk-a" it simply never won that coin flip in 90 rounds. A resourceErrandTarget pull lets it
  // accumulate an advantage turn over turn as the hero gets closer, the same way gearErrandTarget
  // already does for Smithy/Barracks errands.
  const resourceErrandTarget = findResourceErrandTarget(state, player, neededResources);

  let bestCoord = hero.position;
  let bestScore = scoreDestination(state, player, hero.position, quest, connected, starving, warCallTarget, gearErrandTarget, neededResources, resourceErrandTarget);
  let bestPath: HexCoord[] = [];

  for (const { coord, path } of reachable) {
    const s = scoreDestination(state, player, coord, quest, connected, starving, warCallTarget, gearErrandTarget, neededResources, resourceErrandTarget);
    if (s > bestScore) {
      bestScore = s;
      bestCoord = coord;
      bestPath = path;
    }
  }

  if (bestPath.length === 0) return advance(player.id); // staying put scored best — nothing worth moving for
  void bestCoord;
  return { type: 'MoveHero', actorId: player.id, path: bestPath };
}

function findReachableHexes(state: GameState, player: Player, hero: HeroState): { coord: HexCoord; path: HexCoord[] }[] {
  const range = movementRangeFor(hero);
  const results: { coord: HexCoord; path: HexCoord[] }[] = [];
  const visited = new Set<string>([hexKey(hero.position)]);
  let frontier: { coord: HexCoord; path: HexCoord[] }[] = [{ coord: hero.position, path: [] }];

  for (let step = 0; step < range && frontier.length > 0; step++) {
    const next: typeof frontier = [];
    for (const { coord, path } of frontier) {
      for (const n of hexNeighbors(coord)) {
        const key = hexKey(n);
        if (visited.has(key)) continue;
        const candidatePath = [...path, n];
        if (!checkMovePath(state, player, hero, candidatePath).legal) continue;
        visited.add(key);
        results.push({ coord: n, path: candidatePath });
        next.push({ coord: n, path: candidatePath });
      }
    }
    frontier = next;
  }
  return results;
}

/** Scans the whole map for the most rewarding Monster Den this hero could plausibly beat and
 *  is actually allowed to stand on. Rival-owned Dens are skipped: a non-Rogue can only stop on
 *  rival ground to start a duel (engine/selectors.ts's terrainCostToEnter), so marching at one
 *  would strand the hero short of a fight it can never legally reach. */
function findQuestTarget(state: GameState, player: Player, valueScale = 1): QuestTarget | null {
  const hero = player.hero;
  // A hero already loaded down should bank its haul first; the Capital pull in scoreDestination
  // handles that, and letting a quest outbid it would leave the hero wandering with a full sack.
  if (remainingCarryCapacity(hero) <= 1 && totalCarried(hero) > 0) return null;

  let best: QuestTarget | null = null;
  for (const tile of Object.values(state.map)) {
    if (tile.type !== 'Ruins' || !tile.monsterDenCardId) continue;
    if (tile.ownerId && tile.ownerId !== player.id) continue;
    const monster = getMonsterById(tile.monsterDenCardId);
    if (estimateMonsterWinProbability(hero, player, monster.level) < QUEST_MIN_WIN_PROBABILITY) continue;
    const value = (QUEST_BASE_VALUE + monster.level * QUEST_VALUE_PER_MONSTER_LEVEL) * valueScale;
    if (!best || value > best.value) best = { coord: tile.coord, value };
  }
  return best;
}

/** [DEFAULT — balance rework pass 4] Distance-decayed pull toward whichever gear-economy errand
 *  (CraftGear at an owned Smithy, or SellLoot at an owned Barracks) is currently worth a special
 *  trip — without this, considerCraftGear/considerSellLoot (decideBuild) only ever fire when the
 *  hero happens to already be standing on the right tile for some OTHER reason, which a fresh
 *  Smithy/Barracks would almost never see. Deliberately modest next to QUEST_BASE_VALUE (7) and
 *  WAR_CALL_BASE_VALUE (6) — spending an Ore/Gold surplus or a Loot backlog is housekeeping, not
 *  a reason to abandon an active quest or war call. */
const GEAR_ERRAND_BASE_VALUE = 4;
const GEAR_ERRAND_TRAVEL_COST = 1;

function findGearErrandTarget(state: GameState, player: Player): HexCoord | null {
  const hero = player.hero;
  const isMage = classDefFor(player).startingBonus.kind === 'Mage';

  // Wallet-only affordability check (coord: null) — a rough "worth the detour" signal; the real
  // gate (combined with whatever the hero is carrying once they arrive) is considerCraftGear
  // itself, at the Smithy.
  const cheapestCraftCost = isMage ? applyMageDiscount(SMITHY_CRAFT_COSTS.Common) : SMITHY_CRAFT_COSTS.Common;
  const smithy = canAffordCombined(player, hero, null, cheapestCraftCost) ? ownedSmithyTiles(state, player)[0] : undefined;

  const unequippedCount = hero.inventory.filter((c) => !hero.equippedLootIds.includes(c.id)).length;
  const barracks = unequippedCount > GEAR_SLOT_COUNT ? ownedBarracksTiles(state, player)[0] : undefined;

  const candidates = [smithy?.coord, barracks?.coord].filter((c): c is HexCoord => !!c);
  if (candidates.length === 0) return null;
  // Closer of the two, if both apply — cheapest detour wins.
  return candidates.reduce((a, b) => (hexDistance(hero.position, a) <= hexDistance(hero.position, b) ? a : b));
}

/** [DEFAULT — balance rework pass 5 follow-up #6] See its call site in decideMove for the measured
 *  story. Nearest owned tile with a nonzero stockpile of any resource in `needed` — nearest, not
 *  biggest pile, because at these small magnitudes (a handful of Wood/Stone/Food) travel cost
 *  dominates the decision far more than which pile is a unit or two bigger, the same reasoning
 *  findGearErrandTarget already uses to pick between a Smithy and a Barracks. */
const RESOURCE_ERRAND_BASE_VALUE = 5;
const RESOURCE_ERRAND_TRAVEL_COST = 1;

function findResourceErrandTarget(state: GameState, player: Player, needed: Set<ResourceType>): HexCoord | null {
  if (needed.size === 0) return null;
  const hero = player.hero;
  let best: HexCoord | null = null;
  let bestDistance = Infinity;
  for (const coord of player.ownedTiles) {
    const tile = state.map[hexKey(coord)];
    if (!tile) continue;
    if (!RESOURCE_TYPES.some((r) => needed.has(r) && tile.stockpile[r] > 0)) continue;
    const distance = hexDistance(hero.position, coord);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = coord;
    }
  }
  return best;
}

function scoreDestination(
  state: GameState,
  player: Player,
  coord: HexCoord,
  quest: QuestTarget | null = null,
  connected: Set<HexKey> = new Set(),
  starving = false,
  warCallTarget: HexCoord | null = null,
  gearErrandTarget: HexCoord | null = null,
  neededResources: Set<ResourceType> = new Set(),
  resourceErrandTarget: HexCoord | null = null
): number {
  const tile = tileAt(state, coord);
  if (!tile) return -Infinity;
  let score = 0;

  // A hero with little room left to gather is more valuable heading home to bank what they're
  // carrying than pushing further out — otherwise the AI happily wanders away from a full
  // sack forever, since nothing else in the score function ever points it back. When capacity
  // is ZERO (not just low), the hero can't gather AT ALL, so the pull to home is critical.
  if (remainingCarryCapacity(player.hero) <= 1 && totalCarried(player.hero) > 0) {
    if (samePos(coord, player.capitalTile)) {
      score += 5; // strongly prefer to stay/be at capital
    } else {
      // Distance-decayed pull toward capital proportional to how full the hero is.
      // At full capacity (0 remaining), this becomes a strong pull that outbids most other
      // choices, so the hero doesn't get stuck unable to gather and unable to move.
      const homewardPull = 4.5 - hexDistance(coord, player.capitalTile) * 0.7;
      if (homewardPull > 0) score += homewardPull;
    }
  }

  // [DEFAULT — roads] A road-connected tile is swept into the wallet automatically at the start of
  // every one of its owner's Phase 3s, so walking there to pick it up is a wasted turn — the whole
  // reason to pay for the network is to stop making that trip. Skip the stockpile term entirely.
  if (tile.ownerId === player.id && !connected.has(hexKey(coord))) {
    const stockpile = RESOURCE_TYPES.reduce((sum, r) => sum + tile.stockpile[r], 0);
    // Bounded by what this hero could actually pick up. Scoring the raw pile let a tile the hero
    // has no room for outbid every other option on the board — which is both wrong on its own
    // terms and the reason hauling always beat questing. The 1.0 weight (down from 1.5) is the
    // other half of that fix: at 1.5 a single full tile scored 7.5 and no Monster Den could ever
    // compete, so the hero hauled cargo for the entire game and the Munchkin layer never ran.
    score += Math.min(stockpile, remainingCarryCapacity(player.hero)) * 1.0;
    // A starving army is a specific emergency with a specific cure: Food and Meat are the only
    // two resources upkeep can be paid in, and only what's in the WALLET counts, so a pile of
    // either sitting on a tile is worth a special trip.
    if (starving) score += Math.min(tile.stockpile.Food + tile.stockpile.Meat, remainingCarryCapacity(player.hero)) * 0.8;
    // [DEFAULT — balance rework pass 5 follow-ups #3/#5] One unit of a resource the hero is
    // actively short of for its next structural milestone (a road segment at Tier 2+, or Capital's
    // own next-tier bill below Tier 2 — see neededForRoad/neededForCapitalTier's doc comments in
    // decideMove, folded into the single `neededResources` set passed in here) is worth a special
    // trip: that milestone is what the rest of the economy (roads, and everything roads unlock) is
    // waiting on. Flat rather than per-resource-type so a tile holding two of three needed
    // resources doesn't outbid a Barracks-plan earmark or a genuine emergency (starvationBonus) by
    // accident.
    if (neededResources.size > 0 && RESOURCE_TYPES.some((r) => neededResources.has(r) && tile.stockpile[r] > 0)) score += 3;
    // [DEFAULT — balance rework pass 5 follow-up #4] Gated on remainingCarryCapacity > 0 — a Hunt
    // is a Gather action like any other and decideGather itself refuses to gather AT ALL once
    // capacity hits 0 (falls straight to AdvancePhase), so this bonus used to pull a full hero
    // onto its own HuntingLodge tile for a Hunt it could never actually take. Same bug shape, same
    // fix as the neededResources term above (see decideMove's comments for the
    // measured deadlock), just found one layer later: on "ai-risk-layer-seed", once those two were
    // fixed, p1's hero settled onto its OWN HuntingLodge tile at round 15 (full sack, 0 capacity)
    // and stayed there rounds 16-20+ — this +2 (on top of the homeward pull's own 3.8 at that
    // tile's distance) beat the 5.0 flat score for actually walking home and depositing.
    if (tile.building?.type === 'HuntingLodge' && !player.hero.hasHuntedThisRound && remainingCarryCapacity(player.hero) > 0) score += 2;
  }

  // Distance-decayed pull toward the best Den anywhere on the map (see the QUEST_* constants).
  // The tile the Den sits on also scores the immediate term below at distance 0, so arriving is
  // strictly better than merely approaching.
  if (quest) {
    const pull = quest.value - QUEST_TRAVEL_COST * hexDistance(coord, quest.coord);
    if (pull > 0) score += pull;
  }

  // [DEFAULT — hero battle participation] Distance-decayed pull toward this turn's predicted
  // territory-march origin — see WAR_CALL_* constants' doc comment above decideMove for why this
  // exists (the hero was almost never physically present to join a fight without it).
  if (warCallTarget) {
    const pull = WAR_CALL_BASE_VALUE - WAR_CALL_TRAVEL_COST * hexDistance(coord, warCallTarget);
    if (pull > 0) score += pull;
  }

  // [DEFAULT — balance rework pass 4] See findGearErrandTarget's doc comment above decideMove.
  if (gearErrandTarget) {
    const pull = GEAR_ERRAND_BASE_VALUE - GEAR_ERRAND_TRAVEL_COST * hexDistance(coord, gearErrandTarget);
    if (pull > 0) score += pull;
  }

  // [DEFAULT — balance rework pass 5 follow-up #6] See findResourceErrandTarget's doc comment
  // above decideMove — the cross-turn counterpart of the in-range-only bonus further up (the one
  // gated on `neededResources`), for the same reason gearErrandTarget exists alongside
  // considerCraftGear/considerSellLoot's own in-range checks.
  if (resourceErrandTarget) {
    const pull = RESOURCE_ERRAND_BASE_VALUE - RESOURCE_ERRAND_TRAVEL_COST * hexDistance(coord, resourceErrandTarget);
    if (pull > 0) score += pull;
  }

  if (tile.type === 'Ruins' && tile.monsterDenCardId) {
    const monster = getMonsterById(tile.monsterDenCardId);
    const winProb = estimateMonsterWinProbability(player.hero, player, monster.level);
    score += winProb >= QUEST_MIN_WIN_PROBABILITY ? 2 + monster.level * 0.6 : -3;
  }

  if (tile.type === 'Volcano' && !tile.isTamed) {
    const winProb = estimateMonsterWinProbability(player.hero, player, VOLCANO_MONSTER_LEVEL);
    score += winProb >= 0.5 && player.hero.level >= 5 ? 6 : -4;
  }

  const rivalHero = findRivalHeroAt(state, player.id, coord);
  if (rivalHero) {
    const winProb = duelWinProbability(
      player.hero.level + player.hero.attack + gearBonus(player.hero),
      hasExtraCombatDie(player),
      rivalHero.hero.level + rivalHero.hero.attack + gearBonus(rivalHero.hero),
      hasExtraCombatDie(rivalHero)
    );
    score += winProb >= 0.55 ? 3 : -2;
  }

  return score;
}

function findRivalHeroAt(state: GameState, playerId: PlayerId, coord: HexCoord): Player | null {
  for (const p of state.players) {
    if (p.id === playerId) continue;
    if (samePos(p.hero.position, coord)) return p;
  }
  return null;
}

function samePos(a: HexCoord, b: HexCoord): boolean {
  return a.q === b.q && a.r === b.r;
}

function estimateMonsterWinProbability(hero: HeroState, player: Player, monsterLevel: number): number {
  const flatMod = hero.level + hero.attack + gearBonus(hero);
  const threshold = monsterLevel + MONSTER_THRESHOLD_OFFSET;
  return rollMeetsThresholdProbability(flatMod, threshold, hasExtraCombatDie(player));
}

// ── Phase 4 — Gather ─────────────────────────────────────────────────────────────────────────
// [DEFAULT — direct request: "swap gather and fight phase"] Phase enum numbers Fight (3) before
// Gather (4) now — see engine/types.ts. decideAction's own phase switch dispatches symbolically,
// so this section's physical position in the file needed no change, only the label.

const FORAGEABLE_TYPES = new Set(['Forest', 'Plains', 'Hills', 'Mountain', 'Desert']);

function decideGather(state: GameState, player: Player): Action {
  const hero = player.hero;
  const coord = hero.position;
  const tile = tileAt(state, coord);
  if (!tile) return advance(player.id);

  // LootRuins is the one Gather kind that doesn't touch carriedResources (it draws a Loot
  // card, not a resource — see engine/reducers.ts's applyGather), so it's the only one exempt
  // from the carry-capacity gate below.
  if (tile.type === 'Ruins' && !tile.monsterDenCardId && !tile.hasBeenLooted) {
    return { type: 'Gather', actorId: player.id, coord, gatherKind: 'LootRuins' };
  }

  if (remainingCarryCapacity(hero) <= 0) return advance(player.id);

  const stockpileTotal = RESOURCE_TYPES.reduce((sum, r) => sum + tile.stockpile[r], 0);
  if (tile.ownerId === player.id && stockpileTotal > 0) {
    return { type: 'Gather', actorId: player.id, coord, gatherKind: 'CollectResources' };
  }
  if (tile.ownerId !== player.id && FORAGEABLE_TYPES.has(tile.type) && !player.foragedTilesThisRound.includes(hexKey(coord))) {
    return { type: 'Gather', actorId: player.id, coord, gatherKind: 'Forage' };
  }
  if (tile.ownerId === player.id && tile.building?.type === 'HuntingLodge') {
    return { type: 'Gather', actorId: player.id, coord, gatherKind: 'Hunt' };
  }
  if (classDefFor(player).startingBonus.kind === 'Rogue' && !player.hasStolenThisRound) {
    const hasAdjacentRival = hexNeighbors(coord).some((n) => {
      const t = state.map[hexKey(n)];
      return t?.ownerId && t.ownerId !== player.id;
    });
    if (hasAdjacentRival) return { type: 'Gather', actorId: player.id, coord, gatherKind: 'RogueSteal' };
  }
  return advance(player.id);
}

// ── Phase 3 — Fight ──────────────────────────────────────────────────────────────────────────

function decideFight(state: GameState, player: Player): Action {
  const hero = player.hero;

  // [DEFAULT — Munchkin exploration layer] A pending Door monster is MANDATORY and exempt from
  // the hasFoughtThisTurn cap (see engine/reducers.ts's applyFight) — checked before that cap's
  // early-return below, or the AI would try to leave Phase 4 with it still unresolved and hit
  // applyAdvancePhase's exit guard on every single such turn, which is exactly what a full-sweep
  // measurement caught: every AI game eventually opens a door, and every one of them then failed
  // with "A Door monster is still standing in your way."
  const pending = state.pendingDoorMonster;
  if (pending && pending.heroId === hero.id) {
    // Stale pending encounters can exist if the hero was displaced after the draw (e.g. knockout
    // from another fight). A Door monster is only fightable on the draw tile, so don't emit an
    // impossible HeroVsMonster action from a different coordinate.
    if (!samePos(hero.position, pending.coord)) return advance(player.id);
    // [DEFAULT — direct request: "the hero should be able to flee from strong monsters"] Before
    // Flee existed, a Door monster was unconditionally fought — there was no way to decline it
    // at all. Same 0.45 win-probability bar as the discretionary Ruins Den fight below: under
    // it, flee instead of fighting. heroCoordBeforeMoveThisTurn is always set here — a Door
    // monster is only ever drawn as the direct result of THIS turn's move (see
    // resolveDoorCardIfNewTile in reducers.ts) — so applyFlee always has somewhere to send the
    // hero back to.
    const doorMonster = getMonsterById(pending.monsterCardId);
    if (estimateMonsterWinProbability(hero, player, doorMonster.level) < 0.45) {
      return { type: 'Flee', actorId: player.id };
    }
    return { type: 'Fight', actorId: player.id, combatType: 'HeroVsMonster', coord: pending.coord, monsterCardId: pending.monsterCardId };
  }

  if (state.hasFoughtThisTurn) return advance(player.id);
  const tile = tileAt(state, hero.position);

  // [DEFAULT — territory rework] Phase 4 is now HERO combat only. Army vs Territory is no longer
  // something you declare from behind a Barracks — it happens when soldiers march onto hostile
  // ground in Phase 5 (MoveSoldiersAction), so the minimax search that used to run here now runs
  // from decideBuild via considerTerritoryMarch. §6 still allows exactly one combat resolution
  // per Phase 4, so the three hero branches below genuinely compete with each other.
  if (tile?.type === 'Ruins' && tile.monsterDenCardId) {
    const monster = getMonsterById(tile.monsterDenCardId);
    if (estimateMonsterWinProbability(hero, player, monster.level) >= 0.45) {
      return { type: 'Fight', actorId: player.id, combatType: 'HeroVsMonster', coord: hero.position, monsterCardId: tile.monsterDenCardId };
    }
  }

  if (tile?.type === 'Volcano' && !tile.isTamed && hero.level >= 5) {
    if (estimateMonsterWinProbability(hero, player, VOLCANO_MONSTER_LEVEL) >= 0.5) {
      return { type: 'Fight', actorId: player.id, combatType: 'TameVolcano', coord: hero.position };
    }
  }

  const rival = findRivalHeroAt(state, player.id, hero.position);
  if (rival) {
    const winProb = duelWinProbability(
      hero.level + hero.attack + gearBonus(hero),
      hasExtraCombatDie(player),
      rival.hero.level + rival.hero.attack + gearBonus(rival.hero),
      hasExtraCombatDie(rival)
    );
    if (winProb >= 0.55) {
      return {
        type: 'Fight',
        actorId: player.id,
        combatType: 'HeroVsHero',
        targetPlayerId: rival.id,
        targetHeroId: rival.hero.id,
        isBackstab: true,
      };
    }
  }

  return advance(player.id);
}

// ── Phase 5 — Build ──────────────────────────────────────────────────────────────────────────

const BUILDING_UTILITY: Partial<Record<BuildingType, number>> = {
  Sawmill: 3,
  Quarry: 3,
  Farm: 3.2, // Food feeds level-ups and Windmill both — slightly favored
  Mine: 3,
  TradePost: 2.6,
  Dock: 2.6,
  HuntingLodge: 2.5,
  Windmill: 2,
  // [DEFAULT — AI Risk-layer fix] Raised 2.4 -> 6, above even a Capital tier (5). At 2.4 it lost
  // every comparison it was ever in — Farm 3.2 / Sawmill 3 / Mine 3 / CowStable 2.8 all outscore
  // it while costing 3-5 resources against the Barracks's 10, so the greedy spender below drained
  // the wallet on a cheap producer every single turn and the balance never survived to 10. The
  // number is deliberately outside the production buildings' 1.8-3.2 band rather than nudged to
  // the top of it: by the time a Barracks is actually affordable the AI has spent several rounds
  // deliberately earmarking for it (see barracksPlanFor), and losing that saved-up wallet to a
  // +1 Food/turn Farm would restart the whole save. It also has no substitute — no Barracks means
  // no Soldiers, which means the §6.3 territory war and the Domination win simply never exist for
  // this player, whereas any one production building is one of many interchangeable +1s.
  Barracks: 6,
  // [DEFAULT — balance rework] Cheap (Food:3, Wood:2) and it's the only Meat source, and Meat
  // is the cheaper of the two Soldier-upkeep currencies (1 Meat covers what 2 Food would).
  // [DEFAULT — upkeep fix] Raised 2.8 -> 3.4, i.e. above every other production building rather
  // than below them. Measured over 6 all-AI games the previous weighting produced 116 desertion
  // events against 87 successful upkeep payments: every seat ran a permanent famine, because the
  // Barracks recruits automatically and cannot be declined while the only building that pays the
  // bill kept losing its comparison to a Farm. Meat has exactly one use, so a stable is never
  // "wasted" the way surplus Food is, and this is a prerequisite for having an army at all —
  // see barracksPlanFor, which now refuses to commit to a Barracks without a food engine.
  CowStable: 3.4,
  // [DEFAULT — balance rework pass 4, bugfix] Raised 1.8 -> 3.8 (not just to 2.6 — see below).
  // findBestBuildCandidate picks the SINGLE highest-scoring action across the WHOLE empire each
  // turn, and the empire keeps drawing a brand-new tile every round (§3), so there is almost
  // always a fresh Farm/Sawmill/Mine/CowStable-tier opportunity (3-3.4) competing for that one
  // action. A first attempt at 2.6 (barely above the old 1.8) measured BYTE-IDENTICAL simulation
  // output to the unfixed version across an 8-game sweep — proof the ever-expanding tile pool
  // drowns out anything that doesn't clear the production-building band outright, not just edge
  // above it. 3.8 sits above CowStable (3.4), the same fix already applied to Barracks (was 2.4,
  // is 6) for the identical reason, documented in that entry's own comment below.
  Watchtower: 3.8,
  // [DEFAULT — balance rework pass 4, bugfix] Smithy previously had NO entry here at all, so it
  // fell to the bare `?? 2` default. Same fix and same reasoning as Watchtower directly above —
  // a measured 8-game sweep at the "just barely above default" value of 2.8 still produced ZERO
  // CraftGear actions and byte-identical output to having no fix at all, even in 60+ round games
  // sitting on 300+ idle Ore. 4.0 clears the production-building band so a Smithy can actually
  // win the turn it's genuinely the best use of an empty Mountain tile.
  Smithy: 4.0,
};

/** Bonus applied to a CowStable (new build or upgrade) once the player has an army or is saving
 *  for one. CowStable now starts at only 1 Meat/turn and each Soldier group of 3 costs 2 Food OR
 *  1 Meat per turn, so Meat is worth exactly double Food as upkeep currency and an un-upgraded
 *  stable feeds a single group. Big enough to lift a CowStable upgrade (2.8 - 0.4 + 1.6 = 4.0)
 *  clear of every ordinary production building, small enough that it never outbids the Barracks
 *  itself (6) — feeding an army you don't have yet is putting the cart before the horse. */
const ARMY_MEAT_BONUS = 1.6;

/** [DEFAULT — upkeep fix] Added per unpaid upkeep group (capped at 3 groups) on top of the above.
 *  Big on purpose: while the army is starving, a Cow Stable outranks a Capital tier and even the
 *  Barracks itself, because nothing else the AI can build stops the bleeding. */
const STARVING_MEAT_BONUS = 2.5;

/** [DEFAULT — balance rework pass 4, bugfix] Scoped bonus for upgrading an EXISTING Watchtower —
 *  see its call site in findBestBuildCandidate for the full measured-sweep story. 2.0 pushes a
 *  tier-1->2 upgrade's score to 3.8 - 0.4 + 2.0 = 5.4, close to (but still under) Barracks's own
 *  5.6, so an existing Watchtower actually climbs tiers over the course of a game without
 *  outbidding the one building the whole Risk layer depends on. */
const WATCHTOWER_UPGRADE_BONUS = 2.0;

/** Upgrading trades away the +1 VP a brand-new building on a fresh tile would have scored
 *  (VP_PER_BUILDING) and doesn't develop any new territory — same +1 resource/turn otherwise. So
 *  an upgrade is worth slightly less than constructing the same building somewhere new, and this
 *  is the gap. It's small because upgrades also need no spare tile of the right terrain, which
 *  is frequently the binding constraint. */
const UPGRADE_VP_DISCOUNT = 0.4;

/** [DEFAULT — territory rework] Soldiers the AI wants standing on each of its OWN border tiles —
 *  the tiles where its territory touches a rival's. This is the designer's picture of the war
 *  made literal: "alongside the border, where tiles of two different colors meet, both players
 *  station troops to protect their own tiles from enemy troops." It is defence AND offence in one
 *  number, because a march can now be launched from any tile holding troops, so the garrison
 *  watching a border tile is also the stack that walks across it. */
const BORDER_GARRISON_TARGET = 3;

/** Soldiers worth parking on a tile that touches unclaimed ground. Smaller than the border
 *  target: nobody is going to take that hex off us, we just want a stack in position to walk onto
 *  it, and free ground needs no dice. */
const FRONTIER_GARRISON_TARGET = 2;

/** [DEFAULT — balance rework pass 4] Capital-defense tuning for considerCapitalDefense below —
 *  mirrors evaluate.ts's own CAPITAL_THREAT_RADIUS/CAPITAL_ADEQUATE_GARRISON so the AI's
 *  decision to actually MOVE troops home agrees with the score that move is chasing. A rival
 *  stack within this many hexes of the Capital is a live threat worth reacting to; the garrison
 *  target scales with how big that stack is, capped so a single overwhelming army doesn't demand
 *  literally the whole standing force come home. */
const CAPITAL_DEFENSE_THREAT_RADIUS = 3;
const CAPITAL_DEFENSE_TARGET_GARRISON_CAP = 8;

/** [DEFAULT — territory rework] ONE Barracks, down from two. The second one only ever existed to
 *  fix a first that couldn't reach anybody — an obsolete problem, since troops now march from
 *  wherever they stand and a Barracks is purely a recruitment unlock. What a second one still
 *  does is double the recruitment rate into an economy that a measured sweep showed could not
 *  feed the first one's output, which is the desertion cycle this pass exists to end. */
const MAX_BARRACKS = 1;

/** [DEFAULT — AI Risk-layer fix] Round from which the AI starts earmarking for a Barracks.
 *  Rounds 1-4 are the opening: STARTING_RESOURCES are all zero, and the cheap producers that
 *  actually generate the income to pay for an army unlock at round 3 (Sawmill/Mine/TradePost/
 *  Dock) and 4 (Farm/Quarry). Earmarking 10 resources before any of those exist would just park
 *  an empty wallet — the AI would refuse to build the very economy it needs to afford the thing
 *  it's saving for. From round 5 the whole basic production tree is legal, so committing is a
 *  real strategic choice rather than a self-inflicted stall, and it still leaves seven rounds
 *  before WIN_MIN_ROUND (12) — the earliest any threshold win can land — for the Barracks to be
 *  built, fill a reserve at 3 Soldiers/round, and go to war. */
const BARRACKS_SAVING_MIN_ROUND = 5;

interface BarracksPlan {
  /** Owned, empty, Plains tile the Barracks would go on. */
  site: HexCoord;
  /** Mage-discounted where applicable — this exact bundle is what gets earmarked. */
  cost: ResourceCost;
}

function decideBuild(state: GameState, player: Player): Action {
  const isMage = classDefFor(player).startingBonus.kind === 'Mage';
  const hero = player.hero;

  const plan = barracksPlanFor(state, player, isMage);
  // The earmark is the round-gated half of the plan: before BARRACKS_SAVING_MIN_ROUND the AI
  // will happily build a Barracks if one somehow becomes affordable, it just won't hold money
  // back for it.
  const earmark = plan && state.roundNumber >= BARRACKS_SAVING_MIN_ROUND ? plan.cost : null;

  // [DEFAULT — soldier economy fix] A starving EXISTING army outranks affording a NEW one — see
  // considerStarvationTrade. Checked first.
  const starvationTrade = considerStarvationTrade(state, player);
  if (starvationTrade) return starvationTrade;

  // Convert a genuine surplus into whatever the Barracks is still short of, BEFORE the build
  // search, so the conversion can pay off the same turn. Ore is the usual blocker (it only comes
  // from Mountain tiles) while Food piles up unspent, and the AI otherwise never trades at all.
  const trade = considerBarracksTrade(player, earmark);
  if (trade) return trade;

  if (!state.hasBuiltThisTurn) {
    if (hero.pendingLevelUp) {
      const cost = isMage ? applyMageDiscount(LEVEL_UP_COST) : LEVEL_UP_COST;
      // Deliberately NOT earmark-gated: a level-up costs 1 Food + 1 Gold, isn't a building, and
      // hero levels are their own win condition. Blocking it would be pure collateral damage.
      if (canAffordCombined(player, hero, null, cost)) {
        return { type: 'LevelUpHero', actorId: player.id };
      }
    }

    const best = findBestBuildCandidate(state, player, isMage, plan, earmark);
    if (best) return best;
  }

  // [DEFAULT — territory rework] The army moves in Phase 5 now, after the one Build action.
  // All of these are FREE actions — none consumes the Build slot — so they can fire on top of a
  // Build/LevelUp in the same turn. Each is separately bounded; see each one.
  //
  // Order is deliberate. Capital defense goes first — Capital Conquest (§11) makes losing it an
  // instant, whole-game loss, which outranks every other soldier decision below by construction.
  // Then a border tile with an enemy stack already standing next to it, about to be walked onto;
  // an empty tile is taken with no dice at all, so shoring that up comes before anything optional.
  // Then take/retake ground (the only decision here with real lookahead behind it), then top up
  // the quiet stretches of border, then push fresh recruits out of the Barracks to wherever
  // they're shortest.
  const capitalDefence = considerCapitalDefense(state, player);
  if (capitalDefence) return capitalDefence;

  const urgentDefence = considerBorderReinforcement(state, player, true);
  if (urgentDefence) return urgentDefence;

  const march = considerTerritoryMarch(state, player);
  if (march) return march;

  const reinforce = considerBorderReinforcement(state, player, false);
  if (reinforce) return reinforce;

  const deploy = considerDeploySoldiers(state, player);
  if (deploy) return deploy;

  // [DEFAULT — balance rework pass 4] The gear economy, last — neither competes with anything
  // above (soldier movement doesn't touch resources; these don't touch soldiers directly, only
  // the reserve a sale tops up), so there's no ordering conflict, just two more free actions to
  // take on top of everything else this turn if they're available.
  const craft = considerCraftGear(state, player, earmark);
  if (craft) return craft;

  const sellLoot = considerSellLoot(state, player);
  if (sellLoot) return sellLoot;

  return advance(player.id);
}

function canAffordCombined(player: Player, hero: HeroState, coord: HexCoord | null, cost: ResourceCost): boolean {
  const local = coord !== null && samePos(hero.position, coord);
  return RESOURCE_TYPES.every((r) => player.resources[r] + (local ? hero.carriedResources[r] : 0) >= (cost[r] ?? 0));
}

// ── Barracks plan: wanting one, siting one, and saving for one ───────────────────────────────

function ownedBarracksTiles(state: GameState, player: Player): Tile[] {
  const tiles: Tile[] = [];
  for (const coord of player.ownedTiles) {
    const tile = state.map[hexKey(coord)];
    if (tile?.building?.type === 'Barracks') tiles.push(tile);
  }
  return tiles;
}

/** [DEFAULT — balance rework pass 4] Same shape as ownedBarracksTiles above, for CraftGear. */
function ownedSmithyTiles(state: GameState, player: Player): Tile[] {
  const tiles: Tile[] = [];
  for (const coord of player.ownedTiles) {
    const tile = state.map[hexKey(coord)];
    if (tile?.building?.type === 'Smithy') tiles.push(tile);
  }
  return tiles;
}

/** Does this player's territory touch anybody's? The war can only happen where it does. */
function ownsBorderTile(state: GameState, player: Player): boolean {
  return player.ownedTiles.some((coord) => isBorderTile(state, player, coord));
}

/** [DEFAULT — upkeep fix] Can this player plausibly FEED an army before it commits to raising
 *  one? Recruitment is automatic and cannot be declined once a Barracks exists, and upkeep is
 *  charged every single round, so building one without a standing food supply is signing up for
 *  a permanent famine — exactly the 116-desertions-to-87-payments cycle a measured sweep found
 *  every AI stuck in. Two ways to qualify, because terrain luck shouldn't lock a seat out of the
 *  Risk layer entirely: a Cow Stable (Meat is upkeep currency and nothing else), or enough
 *  road-connected Food/Meat tiles that income arrives in the WALLET by itself each round —
 *  stockpiles on unconnected tiles do NOT pay upkeep, only banked resources do. */
/** Is anybody else in a position to march on us? Owning soldiers or the Barracks that makes them
 *  is the whole of it — under the territory rework an army takes ground by walking onto it, so a
 *  rival with troops and no answer on our side is a rival who can help themselves to our tiles. */
function facesArmedRival(state: GameState, player: Player): boolean {
  return state.players.some((rival) => {
    if (rival.id === player.id || rival.isEliminated) return false;
    if (ownedSoldierCount(state, rival.id) > 0) return true;
    return rival.ownedTiles.some((coord) => state.map[hexKey(coord)]?.building?.type === 'Barracks');
  });
}

/** [BUG FIX — soldier economy, "army always vanishes completely"] The CowStable branch used to
 *  return true the moment ANY CowStable existed on the board, checked BEFORE the road-connection
 *  test below it — so an unconnected CowStable (income that only reaches the wallet if the hero
 *  physically walks there and hauls it, same as any other unconnected tile) satisfied "hasFoodEngine"
 *  just as well as a connected one. hasFoodEngine exists specifically to gate the Barracks on
 *  PASSIVE income (upkeep is charged automatically every round, whether or not the hero happened
 *  to visit), so an unconnected CowStable is exactly the failure case this function is supposed to
 *  catch, not wave through. This was root-causing the "recruit, starve, wipe, recruit again" cycle:
 *  a cheap, unconnected CowStable (no minRound, no road required) green-lit the Barracks almost
 *  immediately, upkeep then drained the wallet on every round the hero didn't happen to be standing
 *  on that one tile, and resolveSoldierUpkeep's desertion rule empties the ENTIRE army in a single
 *  turn once the wallet hits literal zero Food and Meat — not a gradual thinning, a full wipe. */
function hasFoodEngine(state: GameState, player: Player): boolean {
  let connectedFoodTiles = 0;
  const connected = roadConnectedTiles(state, player);
  for (const coord of player.ownedTiles) {
    const tile = state.map[hexKey(coord)];
    if (!tile || !connected.has(hexKey(coord))) continue;
    if (tile.building?.type === 'CowStable') return true;
    const produced = TILE_RESOURCE[effectiveTileType(tile)];
    if (produced === 'Food' || produced === 'Meat') connectedFoodTiles++;
  }
  return connectedFoodTiles >= 2;
}

/** Hex distance from `coord` to the nearest tile any rival owns, or a large sentinel if no rival
 *  has placed a tile yet. Used to bias Barracks siting toward the front. */
function distanceToNearestRivalTile(state: GameState, player: Player, coord: HexCoord): number {
  let best = Infinity;
  for (const tile of Object.values(state.map)) {
    if (!tile.ownerId || tile.ownerId === player.id) continue;
    best = Math.min(best, hexDistance(coord, tile.coord));
  }
  return Number.isFinite(best) ? best : 99;
}

/** [DEFAULT — soldier economy fix] How far from the nearest rival tile a Barracks should ideally
 *  sit: off the border itself (a rival can walk straight onto a border tile with no dice, taking
 *  the recruitment engine with it), but as close behind it as safety allows — because
 *  DeploySoldiers can only reach the Barracks tile itself or ONE hex out. At this distance, at
 *  least one of the Barracks's own neighbours is typically itself a border tile (two hexes that
 *  are exactly 2 apart on a hex grid always share a mutual neighbour), so a single Deploy can put
 *  fresh recruits directly onto the front with zero relay hops. */
const BARRACKS_IDEAL_RIVAL_DISTANCE = 2;

/** Best owned, empty, Plains tile to put a Barracks on — or null if the player has none.
 *
 *  [DEFAULT — territory rework] Siting used to be everything: the old engine only accepted an
 *  attack launched FROM a Barracks tile onto an ADJACENT rival tile, so a Barracks in the
 *  interior was an army that could never be used. That rule is gone — a Barracks now only unlocks
 *  recruitment, recruits appear in its reserve, and DeploySoldiers can send them to ANY owned tile
 *  in one action. So the preference inverts: put it somewhere SAFE. A Barracks on the border is a
 *  tile rivals march onto, and losing it costs the recruitment engine, not just a hex. The
 *  Capital is still the last resort — it's the one tile whose capture eliminates you outright.
 *
 *  [BUG FIX — relay throughput] "Safe" used to mean "as far from the nearest rival as possible,
 *  capped at 6" — monotonically preferring DEEPER interior sites over merely-safe ones. Measured:
 *  Barracks sited an average of 2.3 hexes from the border, but DeploySoldiers can only reach one
 *  hex from the Barracks tile — so the vast majority of fresh recruits (82% of deploys, measured)
 *  had nowhere legal to go on arrival and fell back to considerBorderReinforcement's multi-hop
 *  relay, one hex per turn, which is the structural reason the border/interior ratio stayed
 *  interior-heavy even after soldiers started reaching the front at all. Preferring
 *  BARRACKS_IDEAL_RIVAL_DISTANCE over "farther is always better" fixes the multi-hop problem at
 *  its source — a Barracks sited correctly needs zero relay hops — rather than patching around it
 *  with a bigger cap or a faster relay. */
function barracksSiteFor(state: GameState, player: Player): HexCoord | null {
  let best: { coord: HexCoord; score: number } | null = null;
  for (const coord of player.ownedTiles) {
    const tile = state.map[hexKey(coord)];
    if (!tile || tile.building || effectiveTileType(tile) !== 'Plains') continue;

    // Off the border itself, but as close behind it as that allows — see
    // BARRACKS_IDEAL_RIVAL_DISTANCE. Before any rival tile is even on the map,
    // distanceToNearestRivalTile's 99 sentinel makes this term 0 for every candidate, same as
    // the old formula, so early siting is unaffected — this only matters once there's a front to
    // be near.
    let score = isBorderTile(state, player, coord) ? -6 : 0;
    const distance = distanceToNearestRivalTile(state, player, coord);
    score += Math.max(0, 6 - Math.abs(distance - BARRACKS_IDEAL_RIVAL_DISTANCE) * 2);
    if (samePos(coord, player.capitalTile)) score -= 4;

    if (!best || score > best.score) best = { coord, score };
  }
  return best?.coord ?? null;
}

/** Does this player want a Barracks, and if so where and for how much?
 *
 *  Wants one when it has none — full stop. The old "or the one I have can't reach anybody" case
 *  is obsolete (see barracksSiteFor), and MAX_BARRACKS is now 1.
 *
 *  [DEFAULT — upkeep fix] Gated on hasFoodEngine. A Barracks is not a building you can decide to
 *  stop using: it recruits every round, upkeep is charged on every soldier every round, and when
 *  the wallet comes up short the engine spends every Food AND Meat the player has and then
 *  deserts the difference. Committing 10 resources to that without an income to feed it is how a
 *  measured sweep ended up with more desertion events than upkeep payments in every single game. */
function barracksPlanFor(state: GameState, player: Player, isMage: boolean): BarracksPlan | null {
  const existing = ownedBarracksTiles(state, player);
  if (existing.length >= MAX_BARRACKS) return null;
  // ...unless somebody else already has an army. Soldiers are the ONLY thing that can stop
  // soldiers: an unarmed player's tiles are free ground, taken by walking onto them, and a
  // measured sweep of the food-gated version showed exactly that — typically one seat per game
  // fielded an army and simply strolled across its neighbours, 46 tiles changing hands without a
  // single die being rolled. Being eaten alive is worse than being hungry, so a live threat
  // overrides the food gate (and the Cow Stable urgency in findBestBuildCandidate then handles
  // the hunger it causes).
  //
  // [DEFAULT — balance rework pass 5 follow-up #9, root cause of a PERMANENT starvation spiral
  // distinct from #8's, but at the same root] The facesArmedRival override above additionally
  // requires capitalTier >= ROAD_MIN_CAPITAL_TIER now. Below that tier roads — and therefore
  // hasFoodEngine, and therefore ANY way to ever feed the army this override fields — are flatly
  // illegal, so "being eaten alive is worse than being hungry" no longer trades a temporary problem
  // for a temporary one: it trades no problem for a PERMANENT one, since there is no path out until
  // Tier 2 regardless of how well the rest of the economy performs. Measured on "risk-d" WITHOUT
  // this gate (i.e. with only follow-ups #1-#8 applied): two of three players fielded an emergency
  // Barracks while still Tier 1 and then deserted soldiers on most of the game's remaining rounds —
  // one of them (a Farmer with 12 Forest and 7 Hills tiles already owned, so not a terrain-scarcity
  // problem) never reached Tier 2 in the entire 69-round game despite its hero visibly being routed
  // toward Wood/Stone tiles by the neededForCapitalTier/resourceErrandTarget pulls (follow-ups #3
  // and #6) — the ongoing army's upkeep simply out-competed that progress turn after turn, because
  // fielding the army was never something this player's Tier-1 economy could actually sustain in
  // the first place. A Tier-1 player facing a rival is better served racing to Tier 2 unarmed (still
  // vulnerable, per the original bug this override exists to fix, but not additionally bleeding
  // upkeep it can never pay) than fielding a garrison guaranteed to spend the rest of the game
  // deserting. Once a player reaches Tier 2 the override behaves exactly as before.
  if (!hasFoodEngine(state, player) && !(facesArmedRival(state, player) && player.capitalTier >= ROAD_MIN_CAPITAL_TIER)) return null;

  const site = barracksSiteFor(state, player);
  if (!site) return null;

  const def = buildingDefFor('Barracks');
  return { site, cost: isMage ? applyMageDiscount(def.cost) : def.cost };
}

/** Would paying `cost` for something at `coord` still leave the wallet able to buy the Barracks?
 *
 *  This is the "reserve" — the Barracks bill is treated as already spent, and a competing build
 *  is only allowed out of the surplus above it. Note it is deliberately NOT a blanket ban on
 *  building: a cost that touches none of the earmarked resource types (or that fits inside the
 *  surplus) passes untouched, so the economy keeps growing while the AI saves.
 *
 *  Carried resources are netted out first because engine/reducers.ts's combinedPay spends what
 *  the hero is physically holding before it reaches into the wallet — a build paid entirely out
 *  of the hero's sack costs the earmark nothing at all. */
function respectsBarracksEarmark(player: Player, coord: HexCoord | null, cost: ResourceCost, earmark: ResourceCost): boolean {
  const local = coord !== null && samePos(player.hero.position, coord);
  return RESOURCE_TYPES.every((r) => {
    const need = cost[r] ?? 0;
    const fromCarried = local ? Math.min(player.hero.carriedResources[r], need) : 0;
    return player.resources[r] - (need - fromCarried) >= (earmark[r] ?? 0);
  });
}

/** Bank-trades a real surplus into whatever the Barracks is still short of.
 *
 *  Without this the plan deadlocks on terrain luck: the bill is { Wood 3, Ore 2, Food 5 } and Ore
 *  only ever comes from a Mountain tile, so a player who never drew one (or never walked a hero
 *  to the one they have) saves forever and never builds. Meanwhile Food piles up in the tens.
 *  Strictly bounded: the donor must have `giveAmount` to spare ON TOP of its own earmarked share,
 *  and every trade closes the shortfall by ratio[1], so the loop terminates in at most a handful
 *  of trades and stops dead the moment the Barracks is affordable. */
function considerBarracksTrade(player: Player, earmark: ResourceCost | null): Action | null {
  if (!earmark) return null;
  // The engine derives what comes BACK from bankTradeRatio[1] itself; the action only carries
  // what's given, and applyTradeWithBank rejects any giveAmount that isn't exactly ratio[0].
  const giveAmount = player.bankTradeRatio[0];

  let neediest: ResourceType | null = null;
  let worstShortfall = 0;
  for (const r of RESOURCE_TYPES) {
    const shortfall = (earmark[r] ?? 0) - player.resources[r];
    if (shortfall > worstShortfall) {
      worstShortfall = shortfall;
      neediest = r;
    }
  }
  if (!neediest) return null; // wallet already covers the whole bill — nothing to convert

  let donor: ResourceType | null = null;
  let bestSurplus = giveAmount - 1;
  for (const r of RESOURCE_TYPES) {
    if (r === neediest) continue;
    const surplus = player.resources[r] - (earmark[r] ?? 0);
    if (surplus >= giveAmount && surplus > bestSurplus) {
      bestSurplus = surplus;
      donor = r;
    }
  }
  if (!donor) return null;

  return { type: 'TradeWithBank', actorId: player.id, give: donor, giveAmount, receive: neediest };
}

/** [DEFAULT — soldier economy fix, "army always vanishes completely"] The other half of the
 *  desertion-spiral fix — see hasFoodEngine's bug-fix comment for the mechanism this closes.
 *
 *  A player already mid-shortfall (upkeepShortfallGroups > 0) is structurally trapped: CowStable,
 *  the one building that raises Meat income, costs Food (3) — and a wallet that's short on upkeep
 *  is, by construction, usually short on Food too. findBestBuildCandidate scores CowStable heavily
 *  during a shortfall (feedingAnArmy + starvationBonus), but canAffordCombined silently rejects it
 *  the moment the wallet can't cover that Food cost, and the AI has no other move that raises
 *  Food — so it just keeps recruiting (accumulateTileProduction's throttle is trivially satisfied
 *  the instant a wipe drops the army to 0: soldierUpkeepUnits(0) is 0, so ANY wallet state permits
 *  the very next round's recruitment) and getting wiped again, with no way to spend its way out.
 *  Measured: three of five seeds had one seat pay upkeep only 2-5 times across the entire back
 *  half of the game while deserting 27-41 times in the same span — not occasional bad luck, a
 *  self-sustaining loop.
 *
 *  This is considerBarracksTrade's shape aimed at a different bill: no earmark to respect (there
 *  is no "saving up" here, this IS the emergency), converting whatever's genuinely spare toward
 *  Food specifically, because Food is what resolveSoldierUpkeep spends first... no — Meat is spent
 *  first (see resolveSoldierUpkeep), but Food is what CowStable's own cost needs, so fixing the
 *  wallet's Food is what unblocks the building that fixes the wallet permanently. Runs BEFORE
 *  considerBarracksTrade: an existing army starving right now outranks affording a NEW one. */
function considerStarvationTrade(state: GameState, player: Player): Action | null {
  if (upkeepShortfallGroups(state, player) <= 0) return null;
  const giveAmount = player.bankTradeRatio[0];

  // [DEFAULT — balance rework pass 5 follow-up #8, root cause of a PERMANENT starvation spiral,
  // distinct from the one hasFoodEngine's own bug-fix comment describes above] While still below
  // ROAD_MIN_CAPITAL_TIER, roads — and therefore hasFoodEngine, and therefore any durable fix to
  // THIS shortfall — are flatly illegal, so reaching Capital Tier 2 is the one action that actually
  // ends the emergency this function exists to patch over. Without this reserve, a Tier-1 player
  // whose Barracks came from facesArmedRival overriding the food gate (see barracksPlanFor) stays
  // in shortfall essentially every round for as long as the starvation lasts — which, absent Tier
  // 2, is forever — so this function fires EVERY Build phase and, being checked before
  // findBestBuildCandidate (where the Capital-tier upgrade itself is scored), greedily converts
  // whatever Wood/Stone the hero's own neededForCapitalTier errand (decideMove) just delivered into
  // Food before Capital Tier 2 ever gets a turn to spend it — permanently starving its own escape
  // route. Measured on "risk-d" WITHOUT this reserve: p2 and p3 both fielded an emergency Barracks
  // while still Tier 1, then deserted soldiers across roughly 45 of the remaining ~45 rounds each,
  // NEVER reaching Tier 2 and NEVER laying a single road, ending a 76-round game with Food AND Meat
  // both at 0-1 in the wallet. Reserving the still-unmet legs of Capital's own next-tier bill (only
  // while below the road gate — past it, Capital's bill no longer blocks the fix, so this stops
  // applying) breaks the cycle without touching the emergency logic for anyone already past Tier 1.
  const capitalNextTier = player.capitalTier < ROAD_MIN_CAPITAL_TIER ? CAPITAL_TIERS[player.capitalTier] : undefined;

  let donor: ResourceType | null = null;
  let bestSurplus = giveAmount - 1;
  for (const r of RESOURCE_TYPES) {
    if (r === 'Food') continue;
    const reserved = capitalNextTier?.cost[r] ?? 0;
    const surplus = player.resources[r] - reserved;
    if (surplus >= giveAmount && surplus > bestSurplus) {
      bestSurplus = surplus;
      donor = r;
    }
  }
  if (!donor) return null; // nothing spare to convert — the wallet is broke across the board

  return { type: 'TradeWithBank', actorId: player.id, give: donor, giveAmount, receive: 'Food' };
}

// ── Build/upgrade candidate search ──────────────────────────────────────────────────────────

function findBestBuildCandidate(
  state: GameState,
  player: Player,
  isMage: boolean,
  plan: BarracksPlan | null,
  earmark: ResourceCost | null
): Action | null {
  let best: { action: Action; score: number } | null = null;
  // Meat is Soldier-upkeep currency, so a CowStable is worth more to a player who has an army or
  // has committed to getting one than to a pure builder.
  const feedingAnArmy = plan !== null || ownedBarracksTiles(state, player).length > 0 || ownedSoldierCount(state, player.id) > 0;
  // [DEFAULT — upkeep fix] ...and it stops being a preference and becomes an emergency once the
  // army is already bigger than the wallet can feed: every round spent short deserts soldiers AND
  // strips the Food that hero level-ups, buildings and Capital tiers are all waiting on. Scaled by
  // how many upkeep groups are actually unpaid, so the AI shouts louder the deeper the hole.
  const starvationBonus = Math.min(upkeepShortfallGroups(state, player), 3) * STARVING_MEAT_BONUS;

  // [DEFAULT — balance rework pass 5 follow-up #7, root cause of the Barracks-never-gets-built
  // regression on "ai-risk-layer-seed"] `plan.site` is only ever set once barracksPlanFor's full
  // gate passes (hasFoodEngine or facesArmedRival) — but hasFoodEngine itself now requires a road
  // network, which requires Capital Tier 2, which takes many rounds of its own economy-building
  // first. In that whole window `plan` is null, so the OLD reservation below (`plan && ...`) does
  // nothing, and CowStable/Farm — both Plains-only, both economically attractive from round 4-5 —
  // are free to consume every Plains tile the player owns. barracksSiteFor itself has no
  // hasFoodEngine dependency (it only needs an owned, empty, Plains tile), so it can reserve a site
  // long before a full plan exists; MAX_BARRACKS gates it off once a Barracks is actually built, so
  // this never blocks a second empty Plains tile from going to ordinary production once the army is
  // real. Measured: on "ai-risk-layer-seed" WITHOUT this fix (i.e. with only follow-ups #1-#6
  // applied), every one of the three players finished the game with tier>=1, some with 30+
  // road-connected tiles and 200+ banked Meat/Food, yet EVERY owned Plains tile (8-9 per player)
  // had already been built over by round ~15-20 — CowStable/Farm/HuntingLodge, in some order — so
  // barracksSiteFor had nowhere left to point for the rest of the game and barracksBuilt stayed 0
  // for all three seats, confirmed by direct inspection (0 empty Plains tiles, all three players,
  // at game end).
  const barracksReservedSite =
    ownedBarracksTiles(state, player).length < MAX_BARRACKS ? plan?.site ?? barracksSiteFor(state, player) : null;

  const nextTier = CAPITAL_TIERS[player.capitalTier];
  if (nextTier) {
    const cost = isMage ? applyMageDiscount(nextTier.cost) : nextTier.cost;
    if (canAffordCombined(player, player.hero, player.capitalTile, cost) &&
        (!earmark || respectsBarracksEarmark(player, player.capitalTile, cost, earmark))) {
      best = { action: { type: 'Build', actorId: player.id, buildingType: 'Capital', coord: player.capitalTile }, score: 5 };
    }
  }

  for (const coord of player.ownedTiles) {
    const tile = state.map[hexKey(coord)];
    if (!tile) continue;

    // ── Upgrading an existing building. Competes for the SAME one Build action per turn as
    // constructing a new one (applyUpgradeBuilding sets hasBuiltThisTurn), so both live in this
    // one search and are scored on the same scale rather than picked by separate passes.
    if (tile.building) {
      const def = buildingDefFor(tile.building.type);
      const next = nextUpgradeFor(def, tierOf(tile.building));
      if (!next) continue; // single-tier building, or already maxed
      const cost = isMage ? applyMageDiscount(next.cost) : next.cost;
      if (!canAffordCombined(player, player.hero, coord, cost)) continue;
      if (earmark && !respectsBarracksEarmark(player, coord, cost, earmark)) continue;

      let score = (BUILDING_UTILITY[tile.building.type] ?? 2) - UPGRADE_VP_DISCOUNT;
      if (tile.building.type === 'CowStable') {
        if (feedingAnArmy) score += ARMY_MEAT_BONUS;
        score += starvationBonus;
      }
      // [DEFAULT — balance rework pass 4, bugfix] Even after raising Watchtower's own base value
      // (1.8 -> 3.8) to get it BUILT at all, a measured sweep found tier upgrades still fired
      // ZERO times across 8 fresh games — 3.8 - UPGRADE_VP_DISCOUNT(0.4) = 3.4 still loses to the
      // ever-present pool of fresh-tile new-build options (3-3.4), the same mechanism that
      // originally starved the base value. Rather than raising the base further (which would just
      // make the AI over-build Watchtowers instead of fixing upgrades — it's already gone from
      // 0-5 to 0-15 per game at 3.8), a bonus scoped to the UPGRADE path specifically lets an
      // EXISTING Watchtower actually climb tiers without inflating how eagerly new ones get
      // built on empty tiles.
      if (tile.building.type === 'Watchtower') score += WATCHTOWER_UPGRADE_BONUS;
      if (!best || score > best.score) {
        best = { action: { type: 'UpgradeBuilding', actorId: player.id, coord }, score };
      }
      continue;
    }

    // ── Constructing on an empty owned tile.
    const effType = effectiveTileType(tile);

    for (const buildingType of Object.keys(BUILDING_DEFINITIONS) as BuildingType[]) {
      if (buildingType === 'Capital') continue;
      const def = buildingDefFor(buildingType);
      const allowed = def.allowedTileTypes === 'any' || (Array.isArray(def.allowedTileTypes) && def.allowedTileTypes.includes(effType));
      if (!allowed) continue;
      // [DEFAULT — balance rework] Reads def.minRound generically, so it covers every round-gated
      // building in constants.ts — Sawmill/Mine/TradePost/Dock (3), Farm/Quarry (4),
      // HuntingLodge/Smithy (5), Windmill (6) — not just the two it was written for. Skipping
      // them outright before that round keeps the AI from proposing a build the engine would
      // reject with IllegalActionError.
      if (def.minRound !== undefined && state.roundNumber < def.minRound) continue;
      if (def.requiresBuilding && !player.ownedTiles.some((c) => state.map[hexKey(c)]?.building?.type === def.requiresBuilding)) continue;

      // The Barracks only ever goes on the planned site — barracksPlanFor is also where the
      // "can we actually feed this thing" gate lives, so bypassing the plan would bypass that too.
      if (buildingType === 'Barracks' && (!plan || hexKey(plan.site) !== hexKey(coord))) continue;
      // ...and nothing ELSE goes there either. A Barracks needs Plains, and so do the Cow Stable,
      // the Farm and the Windmill: without this reservation the AI routinely spent its last empty
      // Plains tile on a +1 producer, after which barracksSiteFor had nowhere left to point and
      // the army it had been saving for became unbuildable for the rest of the game. Measured: in
      // two of six all-AI games exactly one seat ever fielded soldiers, and the unarmed seats were
      // simply walked over. See barracksReservedSite's own doc comment above for why this now
      // reserves a site even before `plan` exists, not just once it does.
      if (barracksReservedSite && buildingType !== 'Barracks' && hexKey(barracksReservedSite) === hexKey(coord)) continue;

      const cost = isMage ? applyMageDiscount(def.cost) : def.cost;
      if (!canAffordCombined(player, player.hero, coord, cost)) continue;
      // The Barracks IS the earmark — it obviously doesn't have to respect it.
      if (buildingType !== 'Barracks' && earmark && !respectsBarracksEarmark(player, coord, cost, earmark)) continue;

      let score = BUILDING_UTILITY[buildingType] ?? 2;
      if (buildingType === 'CowStable') {
        if (feedingAnArmy) score += ARMY_MEAT_BONUS / 2;
        score += starvationBonus;
      }
      if (!best || score > best.score) {
        best = { action: { type: 'Build', actorId: player.id, buildingType, coord }, score };
      }
    }
  }

  return best?.action ?? null;
}

// ── Marching: taking ground, retaking ground, holding a border ──────────────────────────────
//
// TERMINATION, FIRST, for the same reason as roads: MoveSoldiers is a FREE Phase-5 action, so a
// decideAction that keeps returning one without the state moving on hangs the game. Three bounds:
//
//   1. A HARD PER-TURN CAP on marches, counted off the event log (every MoveSoldiers pushes
//      exactly one of SoldiersMarched / TerritoryOccupied / CombatResolved, so the count can't be
//      dodged). This alone makes a livelock impossible.
//   2. Attacks only fire when findBestTerritoryAttack beats the do-nothing baseline, and every
//      resolved attack either takes the tile (the target stops being hostile) or costs soldiers.
//   3. Reinforcement marches are strictly INTERIOR -> BORDER and only ever into a tile below its
//      garrison target, so the reverse move is never a candidate and two of them can't trade the
//      same stack back and forth.
//
// Three per turn, measured rather than guessed: soldiers move one hex at a time now, so a cap of
// two left armies unable to both answer an incursion and press an advantage in the same turn, and
// resolved territory combats across a six-seed sweep went from 13 at two to 32 at three. Games
// still settle at ~30-35 actions per round, nowhere near a spin.
const MAX_MARCHES_PER_TURN = 3;

/** DeploySoldiers is free too, and bounded the same way. Its own progress guarantee is stronger
 *  (each deployment strictly drains the Barracks reserve, which only refills once per round), but
 *  the cap keeps one turn from turning into a twenty-action shuffle. */
const MAX_DEPLOYMENTS_PER_TURN = 2;

function marchesThisTurn(state: GameState, playerId: PlayerId): number {
  return countActionsThisTurn(
    state,
    playerId,
    (e) =>
      e.type === 'SoldiersMarched' ||
      e.type === 'TerritoryOccupied' ||
      (e.type === 'CombatResolved' && e.payload.combatType === 'ArmyVsTerritory')
  );
}

/** [DEFAULT — territory rework] The offensive half: walk onto hostile ground, or walk back onto
 *  our own ground a rival is squatting on. All of it goes through territoryMinimax.ts, which is
 *  the one decision in this file with real adversarial lookahead behind it.
 *
 *  [BUG FIX — direct report, "a 27-strong army sits next to a weak neighbor and never attacks"]
 *  This used to also block any non-recapture attack outright while canFeedArmy was false — the
 *  ORIGINAL reasoning (see git history / prior version of this comment) was that TAKING GROUND
 *  MAKES THE ARMY BIGGER: recruitment scales with owned tiles, so grabbing territory while
 *  insolvent seemed to compound the famine. That reasoning turned out to double-count a
 *  protection that already exists elsewhere: accumulateTileProduction's Barracks branch
 *  independently refuses to recruit past what the CURRENT wallet can feed, every round,
 *  regardless of how many tiles are owned — so a larger territory ceiling doesn't force more
 *  recruits into existence while starving; recruitment simply stays throttled until solvent
 *  again. Meanwhile the march itself doesn't cost anything to attempt — it moves soldiers
 *  already being paid for, and findBestTerritoryAttack's minimax already refuses to fire unless
 *  the trade beats doing nothing (evaluatePosition prices unit losses), so an unfavorable fight
 *  was never proposed in the first place. Blocking a favorable fight on a temporary affordability
 *  dip that the fight itself doesn't worsen was pure lost value — confirmed live: a screenshot
 *  showed a healthy 27-strong army sitting immobile beside a 1-3-strong rival stack for many
 *  turns running. Recapturing our own occupied tile stays worth calling out on its own even
 *  though the logic is now the same either way — refusing to defend because the larder is thin
 *  loses the tile AND its income, which makes the famine worse, not better. */
function considerTerritoryMarch(state: GameState, player: Player): Action | null {
  if (marchesThisTurn(state, player.id) >= MAX_MARCHES_PER_TURN) return null;

  const best = findBestTerritoryAttack(state, player.id);
  if (!best) return null;

  const heroJoins = heroShouldJoinMarch(state, player, best);

  return {
    type: 'MoveSoldiers',
    actorId: player.id,
    fromCoord: best.fromCoord,
    toCoord: best.targetCoord,
    count: best.attackingUnits,
    // [DEFAULT — hero battle participation] Only ever set on the ONE march findBestTerritoryAttack
    // already chose — see heroShouldJoinMarch's doc comment for why this never widens the search.
    ...(heroJoins ? { heroId: player.hero.id, heroJoins: true as const } : {}),
  };
}

// ── Hero battle participation: should our hero join THIS march? [DEFAULT — hero battle
// participation] ───────────────────────────────────────────────────────────────────────────────
//
// Direct request: "Heroes should be able to partake in battles in a senseful manner so it makes
// sense to upgrade them. Find a fair equation between risk and the hero. If the hero dies a new
// one is spawned without any of the items or skills of the last one." The engine (see
// MoveSoldiersAction.heroJoins's doc comment in engine/types.ts) lets an attacking hero standing on
// fromCoord lend their die to a contested §6.3 fight; losing that pairing costs HP and, at 0 HP, is
// PERMADEATH — engine/reducers.ts's respawnHeroFromDeath wipes level/XP/gear/loot/curses back to a
// fresh level-1 body. That is a real, harsh downside, so "sensible" here means the AI only
// volunteers the hero when it's a good bet, never as a reason to go looking for a fight it
// otherwise wouldn't.
//
// Deliberately layered AFTER findBestTerritoryAttack rather than folded into its minimax search:
// the search already answers "is this march worth making at all" purely off the army's own
// numbers, and only ever returns a march that beats the do-nothing baseline (see its own
// "Only march if..." comment). Adding the hero here can make that ALREADY-good fight better, or
// safer for the troops (see the isHero substitution note on combat.ts's buildDieEntries — when the
// attacking army already fields at least as many units as the defender, a joining hero's die can
// bump a troop's die OUT of a pairing rather than adding a new one, trading HP risk for a Soldier
// that never has to fight at all), but it can never be the reason a march gets chosen — this
// function only ever runs on the one march findBestTerritoryAttack already committed to, and never
// feeds back into that search. That is deliberately the FIRST-PASS scope: teaching the search
// itself to prefer marches that only become favorable WITH the hero would be strictly more capable,
// but requires reasoning about the hero as a stake in the same adversarial lookahead that already
// prices soldier losses (i.e. the rival's MIN-node reply would also need to weigh "is the enemy
// hero on that tile") — real scope creep for a first pass at "make joining sensible," not "make the
// AI seek out fights."
//
// Four gates, all must pass:
//   1. There has to be a fight to join at all (best.contested) and the hero has to legally be able
//      to join it (physically standing on fromCoord, alive, not already committed to a mandatory
//      Door-card fight) — see engine/reducers.ts's applyMoveSoldiers validation and
//      engine/selectors.ts's resolveHero/pendingDoorMonster for how the rest of this file already
//      reads that state (decideFight's `pending.heroId === hero.id` check is the direct precedent).
//   2. HP floor, scaled by how bad losing this hero specifically would be right now (see
//      HERO_JOIN_MIN_HP_FRACTION_EARLY_GAME).
//   3. The pairing itself has to be a good trade, not a coin flip — heroPairWinProbability
//      (combatPrediction.ts) estimates P(the hero's own die beats a plain defending troop's die);
//      HERO_JOIN_MIN_WIN_PROBABILITY reuses the exact 0.55 bar this same file already applies to
//      every other hero-risk call (rival-duel and backstab decisions above) rather than inventing a
//      new number, and it is comfortably above a plain troop's own ~0.417 baseline win rate
//      (pairWinProbability(false) in combatPrediction.ts) — i.e. the hero has to be a clearly
//      BETTER bet than the troop whose pairing it would take or displace, not just an even one.

/** Minimum hero HP / maxHp to volunteer for a fight at all. 0.5 rather than something looser: a
 *  hero already below half health is one more ordinary loss away from permadeath even before this
 *  fight's own damage lands, and HERO_BATTLE_DAMAGE_FLOOR (engine/constants.ts) guarantees every
 *  loss costs at least 2 HP, so there is no such thing as a "safe chip loss" once the margin to 0 is
 *  already thin. */
const HERO_JOIN_MIN_HP_FRACTION = 0.5;

/** Stricter HP floor applied when losing this hero would be WORST: the player hasn't banked a
 *  single Town-tier upgrade yet (capitalTier <= 1, i.e. still the literal opening game — no
 *  cushion of buildings or economy to fall back on, and the player's only hero). Scaling the
 *  floor rather than refusing outright: HERO_BATTLE_XP_ON_WIN is real, if modest, progress toward
 *  the very upgrades that would relax this later, and a hero already at 0.9+ HP joining a
 *  well-favored (>= HERO_JOIN_MIN_WIN_PROBABILITY) fight is still a good bet even this early — a
 *  blanket ban would leave an opening-game hero unable to level up from anything but Door-card
 *  monster fights. */
const HERO_JOIN_MIN_HP_FRACTION_EARLY_GAME = 0.75;

/** Minimum estimated probability (heroPairWinProbability) that the hero wins their own §6.3
 *  pairing before it's worth risking them. Matches the 0.55 bar this same file already uses for
 *  every other hero-risk judgment call (the rival-hero duel and backstab decisions in
 *  scoreDestination/decideFight) rather than inventing a fresh number — comfortably above a plain
 *  troop's own ~41.7% attacker win rate (ties favor the defender, §6.3), so a hero only joins when
 *  it's demonstrably a better bet than the troop whose pairing it takes or displaces. */
const HERO_JOIN_MIN_WIN_PROBABILITY = 0.55;

/** The position-INDEPENDENT half of heroShouldJoinMarch's four gates: alive, not mid a mandatory
 *  Door fight, HP floor, win probability. Split out so decideMove (Phase 2, see its WAR_CALL_*
 *  constants) can ask "if my hero WERE standing at this march's fromCoord, would it be worth
 *  joining?" before the hero has actually walked there — the one gate this deliberately skips
 *  (physical presence) is exactly the thing decideMove is trying to arrange in the first place. */
function heroWouldJoinIfPresent(state: GameState, player: Player, best: TerritoryAttackOption): boolean {
  const hero = player.hero;
  if (hero.hp <= 0) return false; // dead/not-yet-respawned — can't volunteer
  if (state.pendingDoorMonster && state.pendingDoorMonster.heroId === hero.id) return false; // mid a mandatory Door fight

  const earlyGame = player.capitalTier <= 1;
  const minHpFraction = earlyGame ? HERO_JOIN_MIN_HP_FRACTION_EARLY_GAME : HERO_JOIN_MIN_HP_FRACTION;
  if (hero.hp / hero.maxHp < minHpFraction) return false;

  const targetTile = tileAt(state, best.targetCoord);
  const watchtowerTier = targetTile?.building?.type === 'Watchtower' ? tierOf(targetTile.building) : 0;
  const heroFlatMod = hero.level + hero.attack + gearBonus(hero);
  const winProb = heroPairWinProbability(heroFlatMod, hasExtraCombatDie(player), watchtowerTier);
  return winProb >= HERO_JOIN_MIN_WIN_PROBABILITY;
}

function heroShouldJoinMarch(state: GameState, player: Player, best: TerritoryAttackOption): boolean {
  if (!best.contested) return false; // undefended ground rolls no dice — nothing for the hero to join
  if (hexKey(player.hero.position) !== hexKey(best.fromCoord)) return false; // engine requires physical presence on fromCoord
  return heroWouldJoinIfPresent(state, player, best);
}

/** [DEFAULT — balance rework pass 4, new] Capital Conquest (§11) makes losing the Capital an
 *  INSTANT, game-ending loss — so checking whether it's adequately garrisoned against a nearby
 *  threat, and pulling troops IN from an adjacent tile if not, now outranks every other soldier
 *  movement this turn, including the urgent border-reinforcement pass below.
 *
 *  This is deliberately the one place in the whole AI that moves troops BACKWARD/INWARD rather
 *  than only forward/outward — considerBorderReinforcement is explicitly interior -> border,
 *  never the reverse, and a live simulation confirmed that gap in practice: garrisons split
 *  anywhere from 0% to 94% home per player, with no consistent doctrine, because nothing in the
 *  AI's toolkit could ever pull troops home once they'd been pushed to a frontier.
 *
 *  Same one-hop-per-call shape as considerBorderReinforcement (a source more than one hex away
 *  relays home over several turns, since a march only ever covers one hex — §6.3) and the same
 *  "only react to a REAL, nearby threat" gate evaluate.ts's capitalGarrison weight uses, so this
 *  never degenerates into permanent turtling once the Capital is already safe. */
function considerCapitalDefense(state: GameState, player: Player): Action | null {
  if (marchesThisTurn(state, player.id) >= MAX_MARCHES_PER_TURN) return null;

  const capitalCoord = player.capitalTile;
  const capitalTile = state.map[hexKey(capitalCoord)];
  if (!capitalTile) return null;
  const capitalGarrisonOwner = garrisonOwnerOf(capitalTile);
  // A rival garrison already standing on our Capital isn't a reinforcement problem, it's an
  // active invasion — considerTerritoryMarch's recapture path handles marching back onto our own
  // occupied ground; walking more troops "in" here would just be an attack on our own tile.
  if (capitalGarrisonOwner !== null && capitalGarrisonOwner !== player.id) return null;
  const present = capitalGarrisonOwner === player.id ? capitalTile.militiaCount ?? 0 : 0;

  let threat = 0;
  for (const tile of Object.values(state.map)) {
    const garrison = garrisonOwnerOf(tile);
    if (!garrison || garrison === player.id) continue;
    if (hexDistance(tile.coord, capitalCoord) > CAPITAL_DEFENSE_THREAT_RADIUS) continue;
    threat = Math.max(threat, tile.militiaCount ?? 0);
  }
  if (threat <= 0) return null; // nothing nearby worth pulling troops home for right now

  const target = Math.min(threat + 1, CAPITAL_DEFENSE_TARGET_GARRISON_CAP);
  if (present >= target) return null; // already adequately defended for the threat that exists

  for (const fromCoord of hexNeighbors(capitalCoord)) {
    const fromTile = state.map[hexKey(fromCoord)];
    if (!fromTile || fromTile.ownerId !== player.id) continue;
    if (garrisonOwnerOf(fromTile) !== player.id) continue;
    // Never strip a tile mid-occupation — its own claim would reset (claimHeldTerritory).
    if (fromTile.ownerId !== player.id && fromTile.occupationSinceRound !== undefined) continue;
    const available = Math.max(0, (fromTile.militiaCount ?? 0) - MIN_SOLDIERS_LEFT_BEHIND);
    if (available <= 0) continue;
    const count = Math.min(available, target - present);
    if (count <= 0) continue;
    return { type: 'MoveSoldiers', actorId: player.id, fromCoord, toCoord: capitalCoord, count };
  }
  return null;
}

/** [DEFAULT — territory rework] The designer's picture, implemented: "alongside the border, where
 *  tiles of two different colors meet, both players station troops to protect their own tiles from
 *  enemy troops." Walks soldiers from a tile behind the lines onto an under-garrisoned border tile
 *  one hex away.
 *
 *  Strictly interior -> border, which is what makes it terminate: the destination must touch a
 *  rival and the source must not, so the reverse march is never a candidate and no pair of tiles
 *  can trade a stack back and forth. It also never strips an occupation force — soldiers standing
 *  on ground we've taken but not yet claimed have to stay put or the claim resets.
 *
 *  `urgentOnly` narrows it to border tiles a rival stack is ALREADY standing next to — the ones
 *  that get walked onto next turn if they're left empty. Those run ahead of the AI's own offensive
 *  in decideBuild; the unrestricted pass runs after it. */
function considerBorderReinforcement(state: GameState, player: Player, urgentOnly: boolean): Action | null {
  if (marchesThisTurn(state, player.id) >= MAX_MARCHES_PER_TURN) return null;

  for (const toCoord of player.ownedTiles) {
    const toTile = state.map[hexKey(toCoord)];
    if (!toTile || !isBorderTile(state, player, toCoord)) continue;
    if (urgentOnly && !isAdjacentToRivalStack(state, player, toCoord)) continue;
    const garrison = garrisonOwnerOf(toTile);
    // A rival garrison sitting on it isn't a reinforcement problem, it's a target — and marching
    // in would be an attack, which considerTerritoryMarch has already had its say about.
    if (garrison !== null && garrison !== player.id) continue;
    const present = garrison === player.id ? toTile.militiaCount ?? 0 : 0;
    if (present >= BORDER_GARRISON_TARGET) continue;

    for (const fromCoord of hexNeighbors(toCoord)) {
      const fromTile = state.map[hexKey(fromCoord)];
      if (!fromTile || fromTile.ownerId !== player.id) continue;
      if (garrisonOwnerOf(fromTile) !== player.id) continue;
      if (isBorderTile(state, player, fromCoord)) continue; // interior -> border only; see above
      // [DEFAULT — territory rework, Risk's rule] MIN_SOLDIERS_LEFT_BEHIND — the source tile can
      // never be emptied by a march, so only the surplus above that floor is ever movable.
      const available = Math.max(0, (fromTile.militiaCount ?? 0) - MIN_SOLDIERS_LEFT_BEHIND);
      if (available <= 0) continue;

      const count = Math.min(available, BORDER_GARRISON_TARGET - present);
      if (count <= 0) continue;
      return { type: 'MoveSoldiers', actorId: player.id, fromCoord, toCoord, count };
    }
  }
  return null;
}

/** [DEFAULT — balance rework, supersedes the old considerBuyMilitia; retargeted for the territory
 *  rework] Soldiers are not purchased — a Barracks passively fills a reserve at its own tile — so
 *  this only redeploys that reserve. DeploySoldiers is a free action (doesn't consume the one
 *  Build slot, §7.3). [DEFAULT — direct report, corrected here] It reaches only the Barracks
 *  tile itself or one hex out, the same physical reach as a MoveSoldiers march — NOT "any owned
 *  tile in one step" as an earlier version of this comment claimed; see the BUG FIX note on
 *  neediestGarrisonDestination below for why that changed.
 *
 *  The old version's central worry — "deploying is a one-way trip that permanently disarms the
 *  soldier, because attacks may only be launched FROM a Barracks" — is obsolete. Troops now march
 *  from wherever they stand, so a deployed garrison is a strike force, and the two jobs the
 *  designer describes (protect the border, threaten across it) are the same stack. What replaces
 *  it is a destination priority: our own border tiles first, up to BORDER_GARRISON_TARGET, then
 *  tiles that touch unclaimed ground (free hexes, no dice needed to take them). */
function considerDeploySoldiers(state: GameState, player: Player): Action | null {
  if (countActionsThisTurn(state, player.id, (e) => e.type === 'SoldiersDeployed') >= MAX_DEPLOYMENTS_PER_TURN) return null;
  // [DEFAULT — upkeep fix] While the army is unfeedable, the reserve still gets pushed to the
  // border (those tiles are what the desertion-shrunken army exists to hold) but NOT out to
  // frontier staging, which only exists to grab more ground and therefore more upkeep.
  const solvent = canFeedArmy(state, player);

  for (const coord of player.ownedTiles) {
    const tile = state.map[hexKey(coord)];
    if (tile?.building?.type !== 'Barracks') continue;
    // The reserve is only ours to move if it's actually ours — an invader standing on our
    // Barracks owns the stack on that tile, and the engine's DeploySoldiers doesn't check.
    if (garrisonOwnerOf(tile) !== player.id) continue;
    const reserve = tile.militiaCount ?? 0;
    if (reserve <= 0) continue;

    // A Barracks that is itself on the border keeps its own garrison before it exports any.
    // MIN_SOLDIERS_LEFT_BEHIND on top of that — the engine now enforces "never fully vacate the
    // Barracks" on every deploy to a DIFFERENT tile (see applyDeploySoldiers), same as it always
    // has for MoveSoldiers.
    const homeFloor = Math.max(isBorderTile(state, player, coord) ? BORDER_GARRISON_TARGET : 0, MIN_SOLDIERS_LEFT_BEHIND);
    const deployable = reserve - homeFloor;
    if (deployable <= 0) continue;

    const dest = neediestGarrisonDestination(state, player, coord, solvent);
    if (!dest) continue; // nowhere is short — leave the reserve where it is

    const count = Math.min(deployable, dest.want);
    if (count <= 0) continue;
    return { type: 'DeploySoldiers', actorId: player.id, fromCoord: coord, toCoord: dest.coord, count };
  }
  return null;
}

/** Where a Barracks reserve is most needed: the emptiest border tile, else a staging tile next to
 *  unclaimed ground. Returns how many soldiers that tile is short, never a negative.
 *
 *  [BUG FIX — direct report, "soldiers teleported"] Restricted to fromCoord's own neighbours —
 *  the engine now requires a deploy target to be the Barracks tile itself or one hex out, same
 *  physical reach as a MoveSoldiers march, so scanning every owned tile regardless of distance
 *  (as this used to) proposed deploys the engine would reject outright once that constraint
 *  landed. A reserve that needs to reach somewhere further than one hex has to get there the
 *  same way any other garrison does — hop by hop over successive turns (considerBorderReinforcement
 *  handles that leg once the recruits have left the Barracks). */
function neediestGarrisonDestination(
  state: GameState,
  player: Player,
  fromCoord: HexCoord,
  solvent: boolean
): { coord: HexCoord; want: number } | null {
  let best: { coord: HexCoord; want: number; score: number } | null = null;

  for (const coord of hexNeighbors(fromCoord)) {
    const ownedKey = player.ownedTiles.find((c) => hexKey(c) === hexKey(coord));
    if (!ownedKey) continue; // not ours — can't deploy onto ground we don't own
    const tile = state.map[hexKey(coord)];
    if (!tile) continue;
    const garrison = garrisonOwnerOf(tile);
    if (garrison !== null && garrison !== player.id) continue; // never hand reinforcements to an occupier
    const present = garrison === player.id ? tile.militiaCount ?? 0 : 0;

    const border = isBorderTile(state, player, coord);
    const staging = !border && solvent && touchesUnclaimedGround(state, coord);
    const target = border ? BORDER_GARRISON_TARGET : staging ? FRONTIER_GARRISON_TARGET : 0;
    const want = target - present;
    if (want <= 0) continue;

    // Border need outranks staging need outright; within a tier, the emptiest tile wins.
    const score = (border ? 100 : 0) + want;
    if (!best || score > best.score) best = { coord, want, score };
  }

  if (best) return { coord: best.coord, want: best.want };

  // [BUG FIX — direct report, "troops don't move at all, just starve"] No neighbour of the
  // Barracks itself registers a "want" — every one is already at target, or none of them are
  // border/staging tiles at all (the Barracks sits in the interior, one or more hops behind the
  // front). Without a fallback the reserve had nowhere legal to go even once, since Deploy is
  // now adjacency-limited same as a march — it would simply fill to BARRACKS_RESERVE_CAP and
  // sit there forever, which a live game confirmed exactly (both sides' reserves parked dead at
  // the cap). Push it to whichever OWNED neighbour is closest to a rival instead, purely to get
  // it moving — considerBorderReinforcement then relays it the rest of the way, one hop per
  // turn, from wherever it lands, exactly as it already does for any other interior tile. A
  // relay hop stays modest (FRONTIER_GARRISON_TARGET) rather than draining the whole reserve
  // into a single stepping-stone tile.
  let relay: { coord: HexCoord; distance: number } | null = null;
  for (const coord of hexNeighbors(fromCoord)) {
    if (!player.ownedTiles.some((c) => hexKey(c) === hexKey(coord))) continue;
    const tile = state.map[hexKey(coord)];
    if (!tile) continue;
    const garrison = garrisonOwnerOf(tile);
    if (garrison !== null && garrison !== player.id) continue;
    const distance = distanceToNearestRivalTile(state, player, coord);
    if (!relay || distance < relay.distance) relay = { coord, distance };
  }
  if (!relay || relay.distance === Infinity) return null; // no rival on the map yet — nothing to march toward
  return { coord: relay.coord, want: FRONTIER_GARRISON_TARGET };
}

// ── Gear economy: CraftGear and SellLoot [DEFAULT — balance rework pass 4, new mechanics] ─────

/** [DEFAULT — balance rework pass 4, new mechanic] Spends surplus Ore+Gold at an owned Smithy for
 *  a guaranteed Loot card (CraftGearAction) — one of the AI's new Ore/Gold sinks alongside
 *  Barracks/Watchtower upgrades, and the direct answer to those two resources having no
 *  meaningful late-game demand otherwise. Tries the HIGHEST rarity first: a guaranteed card is
 *  worth spending up for when the wallet allows it, rather than defaulting to the cheapest
 *  option every time. Respects the Barracks earmark (if any) the same way an ordinary building
 *  purchase does, so gear shopping never competes with actually affording an army. */
function considerCraftGear(state: GameState, player: Player, earmark: ResourceCost | null): Action | null {
  const hero = player.hero;
  const smithy = ownedSmithyTiles(state, player).find((t) => samePos(hero.position, t.coord));
  if (!smithy) return null;

  const isMage = classDefFor(player).startingBonus.kind === 'Mage';
  const rarityOrder: LootRarity[] = ['Legendary', 'Rare', 'Uncommon', 'Common'];
  for (const rarity of rarityOrder) {
    const cost = isMage ? applyMageDiscount(SMITHY_CRAFT_COSTS[rarity]) : SMITHY_CRAFT_COSTS[rarity];
    if (!canAffordCombined(player, hero, smithy.coord, cost)) continue;
    if (earmark && !respectsBarracksEarmark(player, smithy.coord, cost, earmark)) continue;
    return { type: 'CraftGear', actorId: player.id, coord: smithy.coord, rarity };
  }
  return null;
}

const LOOT_RARITY_ORDER: LootRarity[] = ['Common', 'Uncommon', 'Rare', 'Legendary'];

/** [DEFAULT — balance rework pass 4, new mechanic, direct request: "treasure/equipment has a
 *  gold value like in Munchkin which can be sold for additional troops"] Cashes in a surplus,
 *  UNEQUIPPED Loot card for Soldiers at an owned Barracks (SellLootAction) — CraftGear's inverse.
 *  Deliberately never sells anything currently EQUIPPED (that's real combat power, not surplus)
 *  and only fires once there's a genuine backlog — more unequipped cards than the hero could even
 *  use if every gear slot opened up (GEAR_SLOT_COUNT) — so a fresh Monster-kill trophy is never
 *  sold the same turn it's won. Sells the LOWEST rarity in the backlog first: a Common trades
 *  for troops far more readily than it would ever get equipped over something better, whereas a
 *  Legendary is worth holding for its own combat value unless the backlog runs deep. */
function considerSellLoot(state: GameState, player: Player): Action | null {
  const hero = player.hero;
  const unequipped = hero.inventory.filter((c) => !hero.equippedLootIds.includes(c.id));
  if (unequipped.length <= GEAR_SLOT_COUNT) return null;

  const barracks = ownedBarracksTiles(state, player).find((t) => samePos(hero.position, t.coord));
  if (!barracks) return null;
  if (garrisonOwnerOf(barracks) !== null && garrisonOwnerOf(barracks) !== player.id) return null; // occupied — engine would reject

  // [BUG FIX] Mirror applySellLoot's own room check (reducers.ts) — without it, the AI proposed
  // a sale the engine would reject outright once the Barracks reserve or the player's troop cap
  // was already full, which a full-game integration run caught as a genuine IllegalActionError,
  // not just a missed opportunity.
  const barracksTier = BARRACKS_TIERS[Math.min(tierOf(barracks.building!), BARRACKS_TIERS.length) - 1] ?? BARRACKS_TIERS[0];
  const currentArmy = ownedSoldierCount(state, player.id);
  const waterTiles = player.ownedTiles.filter((c) => {
    const t = state.map[hexKey(c)];
    return !!t && effectiveTileType(t) === 'River';
  }).length;
  const roomUnderTroopCap = Math.max(0, troopCapFor(waterTiles) - currentArmy);
  const roomUnderReserveCap = Math.max(0, barracksTier.reserveCap - (barracks.militiaCount ?? 0));
  if (Math.min(roomUnderTroopCap, roomUnderReserveCap) <= 0) return null;

  const card = [...unequipped].sort((a, b) => LOOT_RARITY_ORDER.indexOf(a.rarity) - LOOT_RARITY_ORDER.indexOf(b.rarity))[0];
  if (!card) return null;
  return { type: 'SellLoot', actorId: player.id, lootCardId: card.id, coord: barracks.coord };
}

/** Is a rival's stack of soldiers standing one hex from here, i.e. one march away from walking
 *  onto this tile? */
function isAdjacentToRivalStack(state: GameState, player: Player, coord: HexCoord): boolean {
  return hexNeighbors(coord).some((n) => {
    const tile = state.map[hexKey(n)];
    if (!tile) return false;
    const owner = garrisonOwnerOf(tile);
    return owner !== null && owner !== player.id;
  });
}

/** Does this tile touch a placed hex nobody owns? Those are free ground: soldiers walk on with no
 *  dice at all and the tile is theirs once they've stood on it into a later round. */
function touchesUnclaimedGround(state: GameState, coord: HexCoord): boolean {
  return hexNeighbors(coord).some((n) => {
    const tile = state.map[hexKey(n)];
    return !!tile && tile.ownerId === null;
  });
}

function isBorderTile(state: GameState, player: Player, coord: HexCoord): boolean {
  return hexNeighbors(coord).some((n) => {
    const t = state.map[hexKey(n)];
    return t?.ownerId && t.ownerId !== player.id;
  });
}
