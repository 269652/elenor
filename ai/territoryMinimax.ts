/**
 * Minimax (expectiminimax, technically — §6.3 combat is stochastic, so a chance node sits
 * between the AI's move and the opponent's reply) search over territory MARCHES — the "Risk
 * part" of the game. This is the one decision in decideAction.ts that gets genuine adversarial
 * lookahead rather than a one-shot heuristic:
 *
 *   MAX (this AI picks a march: which stack, which adjacent hex, how many soldiers)
 *     -> CHANCE (tile taken vs repulsed, via combatPrediction.ts's exact capture probability)
 *          -> MIN (the rival picks their best reply: march back onto the contested hex from any
 *                  adjacent stack of theirs, or do nothing — evaluated from OUR perspective, so
 *                  "best reply" means "worst for us")
 *
 * [DEFAULT — territory rework] What changed: there is no Phase-4 "attack that tile" action any
 * more. Ground is taken by WALKING ONTO IT (MoveSoldiersAction, Phase 5) from any tile holding
 * your troops — a Barracks is just where recruits appear, it is not a launch pad and its
 * adjacency to anything means nothing. Three consequences for this search:
 *
 *   1. Sources are every tile whose garrisonOwnerOf() is us, not just Barracks tiles.
 *   2. An UNDEFENDED hostile or neutral hex needs no dice at all — walking on is free ground, and
 *      the AI should always be happy to take it. Those candidates skip the chance node entirely.
 *   3. Winning the dice does NOT flip the deed. The winner OCCUPIES; ownership transfers only if
 *      the occupier is still standing there at the start of a later turn (claimHeldTerritory), so
 *      the hypotheticals below deliberately leave ownerId alone and let evaluate.ts price the
 *      occupation — which is also what makes the rival's "march back and contest it" reply the
 *      genuinely strong answer it should be.
 *
 * Positions are evaluated via evaluate.ts on a hypothetically-mutated GameState rather than a
 * hand-rolled score delta — that way "how good is this outcome" always goes through the exact
 * same formula as the AI's baseline judgment of the real position, and can never silently drift
 * out of sync with it.
 */

import { hexKey, hexNeighbors, MIN_SOLDIERS_LEFT_BEHIND, tierOf, type GameState, type HexCoord, type PlayerId, type Tile } from '@/engine';
import { garrisonOwnerOf } from '@/engine/reducers';
import { predictArmyVsTerritory } from './combatPrediction';
import { evaluatePosition } from './evaluate';

export interface TerritoryAttackOption {
  /** A tile holding THIS player's soldiers (garrisonOwnerOf === us), adjacent to targetCoord. */
  fromCoord: HexCoord;
  targetCoord: HexCoord;
  attackingUnits: number;
  minimaxValue: number;
  /** True when a rival garrison is standing on the destination and §6.3 dice will actually roll;
   *  false means it's empty ground and the march is an unopposed occupation. */
  contested: boolean;
  /** True when the destination is a tile WE own that a rival garrison has taken up residence on —
   *  i.e. this march is a counter-attack to stop their claim landing, not an expansion. */
  isRecapture: boolean;
}

/** How many soldiers to commit to walking onto UNDEFENDED ground. Not a minimax decision: no
 *  dice are rolled, so every count scores the same occupation and the search would be indifferent.
 *  The real constraint is holding it for a round against whoever marches back, so send enough to
 *  match the largest rival stack that could reach it, bounded by what's actually standing here. */
const OCCUPY_FORCE_CAP = 4;

/** The best march this player could make right now, or null if none beats standing still.
 *  Covers all three flavours in one enumeration — unopposed occupation of free ground, an assault
 *  on a defended tile, and retaking one of our own tiles a rival is sitting on. */
export function findBestTerritoryAttack(state: GameState, playerId: string): TerritoryAttackOption | null {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return null;

  const baseline = evaluatePosition(state, playerId);
  let best: TerritoryAttackOption | null = null;

  for (const fromTile of Object.values(state.map)) {
    if (garrisonOwnerOf(fromTile) !== playerId) continue;
    const garrison = fromTile.militiaCount ?? 0;
    if (garrison <= 0) continue;

    // Ground we've taken but not yet claimed has to keep a garrison standing on it or the
    // occupation clock resets and the whole fight was for nothing — see claimHeldTerritory. That
    // reserve of 1 and the engine's own MIN_SOLDIERS_LEFT_BEHIND floor (Risk's "never fully
    // vacate a tile" rule, applied to every march) are two independent reasons to hold troops
    // back, so take whichever demands more.
    const holdingAnUnclaimedTile = fromTile.ownerId !== playerId && fromTile.occupationSinceRound !== undefined;
    const reserve = Math.max(MIN_SOLDIERS_LEFT_BEHIND, holdingAnUnclaimedTile ? 1 : 0);
    const availableUnits = garrison - reserve;
    if (availableUnits <= 0) continue;

    for (const targetCoord of hexNeighbors(fromTile.coord)) {
      const targetTile = state.map[hexKey(targetCoord)];
      if (!targetTile) continue; // unplaced hex — soldiers can't march off the edge of the map
      const defenderId = garrisonOwnerOf(targetTile);
      if (defenderId === playerId) continue; // our own stack — that's a reinforcement, not an attack
      const contested = defenderId !== null;
      const isRecapture = contested && targetTile.ownerId === playerId;
      if (!contested && targetTile.ownerId === playerId) continue; // our own empty tile — a redeploy

      // Whose reply the MIN node models. For a defended tile it's the garrison's owner; for empty
      // hostile ground it's whoever holds the deed; neutral ground has nobody to answer with.
      const rivalId = defenderId ?? targetTile.ownerId ?? null;

      for (const units of candidateUnitCounts(state, playerId, availableUnits, targetTile, contested)) {
        const value = marchValue(state, playerId, rivalId, fromTile.coord, targetCoord, units, contested);
        if (!best || value > best.minimaxValue) {
          best = { fromCoord: fromTile.coord, targetCoord, attackingUnits: units, minimaxValue: value, contested, isRecapture };
        }
      }
    }
  }

  // Only march if some option actually beats the do-nothing baseline — a move that merely ties
  // isn't worth the soldiers (real losses even when the expected score is flat), and for empty
  // ground it also means the AI won't strip a border tile bare to grab a hex it can't hold.
  if (best && best.minimaxValue > baseline) return best;
  return null;
}

/** A handful of representative unit counts rather than every integer 1..available — this AI
 *  reasons about "commit light / commit even / commit heavy / commit everything," not every
 *  possible army size, which keeps the search fast without meaningfully narrowing what it can
 *  decide (the evaluation function is smooth enough that the optimum is rarely far from one of
 *  these). Undefended ground collapses to a single count — see OCCUPY_FORCE_CAP. */
function candidateUnitCounts(
  state: GameState,
  playerId: PlayerId,
  available: number,
  targetTile: Tile,
  contested: boolean
): number[] {
  if (!contested) {
    const threat = largestRivalStackAdjacentTo(state, playerId, targetTile.coord);
    return [Math.min(available, Math.max(1, Math.min(threat, OCCUPY_FORCE_CAP)))];
  }
  const defending = targetTile.militiaCount ?? 0;
  const raw = [
    Math.min(available, Math.max(1, defending)),
    Math.min(available, defending + 1),
    Math.min(available, Math.ceil(defending * 1.5) || 1),
    available,
  ];
  return [...new Set(raw)].filter((n) => n >= 1 && n <= available);
}

/** The biggest single enemy stack that could march onto `coord` next turn — i.e. what an
 *  occupying force has to survive to actually keep the ground. */
function largestRivalStackAdjacentTo(state: GameState, playerId: PlayerId, coord: HexCoord): number {
  let biggest = 0;
  for (const n of hexNeighbors(coord)) {
    const tile = state.map[hexKey(n)];
    if (!tile) continue;
    const owner = garrisonOwnerOf(tile);
    if (owner === null || owner === playerId) continue;
    biggest = Math.max(biggest, tile.militiaCount ?? 0);
  }
  return biggest;
}

function marchValue(
  state: GameState,
  attackerId: PlayerId,
  rivalId: PlayerId | null,
  fromCoord: HexCoord,
  targetCoord: HexCoord,
  units: number,
  contested: boolean
): number {
  if (!contested) {
    // No dice: the soldiers simply walk on and the occupation clock starts.
    const occupied = applyHypotheticalOutcome(state, attackerId, fromCoord, targetCoord, units, units, 0, true);
    return rivalId ? bestOpponentResponseValue(occupied, attackerId, rivalId, targetCoord) : evaluatePosition(occupied, attackerId);
  }

  const targetTile = state.map[hexKey(targetCoord)];
  const defendingUnits = targetTile?.militiaCount ?? 0;
  const watchtowerTier = targetTile?.building?.type === 'Watchtower' ? tierOf(targetTile.building) : 0;
  const prediction = predictArmyVsTerritory(units, defendingUnits, watchtowerTier);

  // CHANCE node: tile taken vs repulsed. The taken branch's attacker survivor count is EXACT, not
  // an approximation — §6.3 pairs each attacker against one defender, so wiping the garrison out
  // means every pair was won and the attacker lost nobody. The repulsed branch still uses
  // combatPrediction's unconditional expectations (a full per-branch binomial breakdown is more
  // precision than a 1-ply opponent model can use); the capture PROBABILITY itself — the number
  // the attack/no-attack decision actually turns on — is exact either way.
  const takenState = applyHypotheticalOutcome(state, attackerId, fromCoord, targetCoord, units, units, 0, true);
  const repulsedState = applyHypotheticalOutcome(
    state,
    attackerId,
    fromCoord,
    targetCoord,
    units,
    prediction.expectedAttackerRemaining,
    prediction.expectedDefenderRemaining,
    false
  );

  const takenValue = rivalId ? bestOpponentResponseValue(takenState, attackerId, rivalId, targetCoord) : evaluatePosition(takenState, attackerId);
  const repulsedValue = rivalId ? bestOpponentResponseValue(repulsedState, attackerId, rivalId, targetCoord) : evaluatePosition(repulsedState, attackerId);

  return prediction.captureProbability * takenValue + (1 - prediction.captureProbability) * repulsedValue;
}

/**
 * MIN node — the rival's best reply, evaluated from OUR perspective (so "best for them" surfaces
 * as the minimum score for us). Scoped to a small, concrete set of replies rather than a
 * recursive call back into the AI's own full decision logic: an unbounded mutual recursion here
 * (their move considers our best reply considers their best reply...) has no natural termination
 * without additional depth-limiting machinery, and a 1-ply opponent model is already enough to
 * stop the AI from walking a lone soldier onto a hex three enemy stacks are standing next to.
 *
 * [DEFAULT — territory rework] The reply set is now "march back onto the contested hex from ANY
 * adjacent tile holding their troops," which is both far broader than the old Barracks-only rule
 * and far more threatening, because ownership hasn't transferred yet: dislodging our garrison
 * before the start of our next turn doesn't just cost us a tile, it means we never got one.
 */
function bestOpponentResponseValue(state: GameState, attackerId: PlayerId, defenderId: PlayerId, contestedCoord: HexCoord): number {
  const defender = state.players.find((p) => p.id === defenderId);
  if (!defender || defender.isEliminated) return evaluatePosition(state, attackerId); // nothing left to respond with

  const options: number[] = [evaluatePosition(state, attackerId)]; // "do nothing"

  const contestedTile = state.map[hexKey(contestedCoord)];
  if (contestedTile && garrisonOwnerOf(contestedTile) === attackerId) {
    const defendingUnits = contestedTile.militiaCount ?? 0;
    const watchtowerTier = contestedTile.building?.type === 'Watchtower' ? tierOf(contestedTile.building) : 0;
    for (const neighbor of hexNeighbors(contestedCoord)) {
      const tile = state.map[hexKey(neighbor)];
      if (!tile || garrisonOwnerOf(tile) !== defenderId) continue;
      const units = tile.militiaCount ?? 0;
      if (units <= 0) continue;

      const prediction = predictArmyVsTerritory(units, defendingUnits, watchtowerTier);
      const retaken = applyHypotheticalOutcome(state, defenderId, neighbor, contestedCoord, units, units, 0, true);
      const held = applyHypotheticalOutcome(
        state,
        defenderId,
        neighbor,
        contestedCoord,
        units,
        prediction.expectedAttackerRemaining,
        prediction.expectedDefenderRemaining,
        false
      );
      options.push(
        prediction.captureProbability * evaluatePosition(retaken, attackerId) +
          (1 - prediction.captureProbability) * evaluatePosition(held, attackerId)
      );
    }
  }

  return Math.min(...options);
}

/**
 * Applies one march's outcome to a COPY of the state. `moverId` is whoever is doing the marching
 * (this is used for both our attack and the rival's reply, so it isn't always the AI).
 *
 * Deliberately shallow: only the two affected tiles are duplicated, and ownerId/ownedTiles are
 * never touched, because taking ground no longer transfers it — evaluate.ts prices the occupation
 * instead. A structuredClone of the whole GameState here would also deep-copy four card decks and
 * the entire event log for every one of the dozens of hypotheticals a single decision explores,
 * which is pure waste: evaluatePosition only ever READS, and everything it reads that this
 * function changes lives in `map`.
 */
function applyHypotheticalOutcome(
  state: GameState,
  moverId: PlayerId,
  fromCoord: HexCoord,
  targetCoord: HexCoord,
  units: number,
  moverRemaining: number,
  defenderRemaining: number,
  tookTheGround: boolean
): GameState {
  const original = state.map[hexKey(fromCoord)];
  const originalTarget = state.map[hexKey(targetCoord)];
  if (!original || !originalTarget) return state;

  const from: Tile = { ...original };
  const target: Tile = { ...originalTarget };

  from.militiaCount = Math.max(0, (from.militiaCount ?? 0) - units);

  if (tookTheGround) {
    target.militiaCount = Math.max(0, Math.round(moverRemaining));
    target.garrisonOwnerId = target.militiaCount > 0 ? moverId : null;
    // Occupation, not conquest: the deed only changes hands at the start of a later turn.
    target.occupationSinceRound = target.ownerId === moverId ? undefined : state.roundNumber;
  } else {
    target.militiaCount = Math.max(0, Math.round(defenderRemaining));
    // Rounding an expectation can land on zero even though a repulse means at least one defender
    // survived; keep the garrison's owner consistent with its size either way.
    if (target.militiaCount === 0) target.garrisonOwnerId = null;
    from.militiaCount = from.militiaCount + Math.max(0, Math.round(moverRemaining)); // survivors fall back
  }
  from.garrisonOwnerId = from.militiaCount > 0 ? moverId : null;

  return { ...state, map: { ...state.map, [hexKey(fromCoord)]: from, [hexKey(targetCoord)]: target } };
}
