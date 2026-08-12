/**
 * Game creation — §1 Setup. Produces the initial GameState from a list of seated players and
 * an RNG seed. Two deliberate v1 simplifications from the rules reference, called out here
 * since they touch setup specifically:
 *
 *  - Capital placement is auto-generated in a symmetric ring (see hex.ts spawnRingPositions)
 *    rather than a player-driven placement sub-phase. This trivially satisfies §1.4's "axial
 *    distance >= 3" rule but means Miner's "starting tile biased near Hills/Mountain" has no
 *    placement decision to bias — it keeps its +1 starting Ore, and the tile-bias half of its
 *    bonus is a documented no-op in v1.
 *  - Woodcutter's "starts with a Sawmill pre-built" is contradictory as written: the Capital
 *    tile type is fixed to Plains (§1.4), and Sawmill only builds on Forest (§7.1) — there is
 *    no Forest tile yet at turn zero to put it on. v1 keeps the persistent, unambiguous half
 *    of the bonus (+1 Wood per owned Forest tile, applied when tile production accumulates —
 *    see reducers.ts's accumulateTileProduction) and swaps the impossible pre-built Sawmill
 *    for a one-time +2 Wood starting bonus of equivalent value.
 *
 * Resource economy note: tiles start with an empty stockpile and heroes start carrying
 * nothing — see reducers.ts's accumulateTileProduction/applyGather/applyDepositResources for
 * the produce-on-tile / collect-by-visiting / deposit-at-Capital loop this feeds into.
 */

import { buildBadStuffDeck, buildDoorDeck, buildLootDeck, buildMonsterDeck, buildTileDeck } from './decks';
import { BANK_TRADE_DEFAULT_RATIO, CAPITAL_MIN_DISTANCE, CLASS_DEFINITIONS, MERCHANT_RATIO, STARTING_RESOURCES } from './constants';
import { hexKey, spawnRingPositions } from './hex';
import { emptyResourceBundle, Phase } from './types';
import { RngStream } from './rng';
import { resolveProductionForNewTurn } from './reducers';
import { freshHeroState } from './selectors';
import type { ClassName, GameMode, GameState, Player, PlayerId, ResourceBundle, Tile } from './types';

export interface SetupPlayerInput {
  id: PlayerId;
  name: string;
  color: string;
  /** Omit to auto-assign a random unused class. */
  classId?: ClassName;
}

const ALL_CLASSES: ClassName[] = ['Woodcutter', 'Miner', 'Farmer', 'Warrior', 'Mage', 'Merchant', 'Rogue'];

export function createGame(gameId: string, playerInputs: SetupPlayerInput[], seed: string, mode: GameMode): GameState {
  if (playerInputs.length < 2 || playerInputs.length > 6) {
    throw new Error(`Player count must be 2-6, got ${playerInputs.length}`); // §1.1
  }

  const rng = new RngStream(seed, 0);

  // §1.4 step 1: turn order by 1d6, highest first, reroll ties among the tied group only.
  const turnOrder = resolveTurnOrder(playerInputs.map((p) => p.id), rng);

  // Class assignment: shuffle the 7 classes, deal one per seated player (no duplicates).
  const shuffledClasses = rng.shuffle(ALL_CLASSES);
  const classByPlayer = new Map<PlayerId, ClassName>();
  playerInputs.forEach((p, i) => classByPlayer.set(p.id, p.classId ?? shuffledClasses[i]));

  const spawnPoints = spawnRingPositions(CAPITAL_MIN_DISTANCE, playerInputs.length);

  const map: Record<string, Tile> = {};
  const players: Player[] = playerInputs.map((input, i) => {
    const classId = classByPlayer.get(input.id)!;
    const capitalTile = spawnPoints[i];
    map[hexKey(capitalTile)] = {
      coord: capitalTile,
      type: 'Plains',
      ownerId: input.id,
      // [DEFAULT — territory rework] The starting tile is special: it carries a Town from turn
      // one rather than sitting empty until someone spends a Build action on it. tier: 1 here
      // mirrors the player's own capitalTier (kept in sync by applyBuild's Capital branch on
      // every later upgrade) so UI/AI code reading tile.building.tier sees the truth without a
      // special case for the Capital.
      building: { id: `bldg-${hexKey(capitalTile)}`, type: 'Capital', coord: capitalTile, ownerId: input.id, tier: 1 },
      monsterDenCardId: null,
      stockpile: emptyResourceBundle(),
    };
    return buildStartingPlayer(input, classId, capitalTile);
  });

  const state: GameState = {
    gameId,
    mode,
    status: 'active',
    rngSeed: seed,
    rngCursor: rng.cursor,
    roundNumber: 1,
    turnOrder,
    currentPlayerId: turnOrder[0],
    currentPhase: Phase.Production,
    map,
    roads: {}, // no supply network yet — every tile starts needing a hero visit
    players,
    tileDeck: buildTileDeck(playerInputs.length, rng),
    monsterDeck: buildMonsterDeck(rng),
    lootDeck: buildLootDeck(rng),
    badStuffDeck: buildBadStuffDeck(rng),
    doorDeck: buildDoorDeck(rng),
    pendingDoorMonster: null,
    eventLog: [
      {
        id: 'evt-0',
        round: 1,
        phase: Phase.Production,
        actorId: 'system',
        type: 'GameStarted',
        payload: { turnOrder, seed },
        seq: 0,
      },
    ],
    winnerId: null,
    winCondition: null,
    pendingTileDraw: null,
    hasPlacedTileThisTurn: false,
    hasFoughtThisTurn: false,
    hasBuiltThisTurn: false,
    hasMovedThisTurn: false,
    heroCoordBeforeMoveThisTurn: null,
  };
  state.rngCursor = rng.cursor;

  // Phase 0 has no player action — it resolves immediately for whoever goes first, then the
  // engine lands on Phase 1 for them to actually act on. See reducers.ts for the shared
  // start-of-turn helper used here and by EndTurn/AdvancePhase.
  return resolveProductionForNewTurn(state, turnOrder[0]);
}

function resolveTurnOrder(playerIds: PlayerId[], rng: RngStream): PlayerId[] {
  const rolls = new Map<PlayerId, number>(playerIds.map((id) => [id, rng.rollDie()]));
  let groups = groupByRoll(playerIds, rolls);

  // Reroll within tied groups until every group has a unique-enough ordering. Bounded loop —
  // 1d6 ties resolve almost always within a couple of passes for realistic player counts.
  for (let pass = 0; pass < 20 && groups.some((g) => g.length > 1); pass++) {
    for (const group of groups) {
      if (group.length <= 1) continue;
      for (const id of group) rolls.set(id, rng.rollDie());
    }
    groups = groupByRoll(playerIds, rolls);
  }

  return [...playerIds].sort((a, b) => (rolls.get(b)! - rolls.get(a)!) || a.localeCompare(b));
}

function groupByRoll(playerIds: PlayerId[], rolls: Map<PlayerId, number>): PlayerId[][] {
  const byRoll = new Map<number, PlayerId[]>();
  for (const id of playerIds) {
    const roll = rolls.get(id)!;
    byRoll.set(roll, [...(byRoll.get(roll) ?? []), id]);
  }
  return [...byRoll.values()];
}

function buildStartingPlayer(input: SetupPlayerInput, classId: ClassName, capitalTile: Player['capitalTile']): Player {
  const resources: ResourceBundle = { ...STARTING_RESOURCES };
  let bankTradeRatio = BANK_TRADE_DEFAULT_RATIO;

  // Only the resource-side starting bonuses live here now — heroMaxHpBonus (Farmer) and
  // startingWeaponAttackBonus (Warrior), plus tier 1's free-Town heroMaxHpBonus, are folded into
  // freshHeroState below (selectors.ts) so setup, the second-hero unlock, and permadeath respawn
  // all compute a hero's stat line the same way.
  const bonus = CLASS_DEFINITIONS[classId].startingBonus;
  switch (bonus.kind) {
    case 'Woodcutter':
      resources.Wood += 2; // stand-in for the un-placeable pre-built Sawmill — see file header
      break;
    case 'Miner':
      resources.Ore += bonus.startingOreBonus;
      break;
    case 'Farmer':
      break; // heroMaxHpBonus applied in freshHeroState
    case 'Warrior':
      break; // startingWeaponAttackBonus applied in freshHeroState
    case 'Mage':
      break; // building discount applied at build-time; ranged attack handled in reducers.ts
    case 'Merchant':
      resources.Gold += bonus.startingGoldBonus;
      bankTradeRatio = MERCHANT_RATIO;
      break;
    case 'Rogue':
      break; // pass-through/steal handled in selectors.ts / reducers.ts
  }

  return {
    id: input.id,
    name: input.name,
    color: input.color,
    classId,
    resources,
    ownedTiles: [capitalTile],
    capitalTile,
    capitalTier: 1, // tier 1 is the free starting Town — see CAPITAL_TIERS[0] and this file's map[] init above
    hero: freshHeroState({
      id: `${input.id}-hero-1`,
      ownerId: input.id,
      classId,
      capitalTier: 1,
      capitalTile,
    }),
    victoryPoints: 0,
    isEliminated: false,
    bankTradeRatio,
    hasStolenThisRound: false,
    foragedTilesThisRound: [],
  };
}
