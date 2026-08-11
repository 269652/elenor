import { describe, expect, it } from 'vitest';
import { applyAction } from '../reducer';
import { maxTierFor, nextUpgradeFor, produceAmountForTier, tierOf, tileAt } from '../selectors';
import {
  BARRACKS_RESERVE_CAP,
  BUILDING_DEFINITIONS,
  MEAT_UPKEEP_VALUE,
  SOLDIER_UPKEEP_FOOD_PER_GROUP,
  SOLDIER_UPKEEP_GROUP_SIZE,
  soldiersPerRoundFor,
  TILE_STOCKPILE_CAP,
} from '../constants';
import { emptyResourceBundle, hexKey, IllegalActionError, Phase, RESOURCE_TYPES } from '../types';
import type { BuildingDefinition, BuildingType, GameState, Player, ResourceBundle, Tile, TileType } from '../types';
import { makePlayer, makeTile } from './testUtils';

/** Hand-built GameState, same pattern as selectors.test.ts's fixtureState — but takes an
 *  explicit tile list (rather than deriving one Plains tile per owned coord) so tests can pin
 *  down exact tile types, buildings, and militiaCount. */
function fixtureState(players: Player[], tiles: Tile[], overrides: Partial<GameState> = {}): GameState {
  const map: Record<string, Tile> = {};
  for (const t of tiles) map[hexKey(t.coord)] = t;
  return {
    gameId: 'g1',
    mode: 'hotseat',
    status: 'active',
    rngSeed: 'seed',
    rngCursor: 0,
    roundNumber: 5,
    turnOrder: players.map((p) => p.id),
    currentPlayerId: players[0].id,
    currentPhase: Phase.Build,
    map,
    roads: {},
    players,
    tileDeck: { drawPile: [], discardPile: [] },
    monsterDeck: { drawPile: [], discardPile: [] },
    lootDeck: { drawPiles: { Common: [], Uncommon: [], Rare: [], Legendary: [] }, discardPiles: { Common: [], Uncommon: [], Rare: [], Legendary: [] } },
    badStuffDeck: { drawPile: [], discardPile: [] },
    doorDeck: { drawPile: [], discardPile: [] },
    pendingDoorMonster: null,
    eventLog: [],
    winnerId: null,
    winCondition: null,
    pendingTileDraw: null,
    hasPlacedTileThisTurn: false,
    hasFoughtThisTurn: false,
    hasBuiltThisTurn: false,
    hasMovedThisTurn: false,
    ...overrides,
  };
}

describe('Meat resource (balance rework)', () => {
  it('emptyResourceBundle includes Meat: 0 alongside the other five', () => {
    expect(emptyResourceBundle()).toEqual({ Wood: 0, Stone: 0, Food: 0, Ore: 0, Meat: 0, Gold: 0 });
  });

  it('RESOURCE_TYPES includes Meat (now 6 resource types)', () => {
    expect(RESOURCE_TYPES).toContain('Meat');
    expect(RESOURCE_TYPES).toHaveLength(6);
  });
});

/** A wallet fat enough to pay for any single building in the table, so build-schedule tests
 *  fail on the ROUND GATE and never incidentally on affordability. */
const RICH_WALLET: ResourceBundle = { Wood: 99, Stone: 99, Food: 99, Ore: 99, Meat: 99, Gold: 99 };

/** First tile type a definition allows — every round-gated building declares an explicit list
 *  (nothing gated is 'any'/'starting-tile-only'), which the assertion below pins down. */
function firstAllowedTileType(def: BuildingDefinition): TileType {
  expect(Array.isArray(def.allowedTileTypes)).toBe(true);
  return (def.allowedTileTypes as TileType[])[0];
}

describe('Build schedule: minRound gating (balance rework)', () => {
  // Data-driven straight off the definition table: retuning the schedule in constants.ts
  // retunes these cases too, instead of leaving a duplicated list here to drift out of sync.
  const roundGated = (Object.entries(BUILDING_DEFINITIONS) as [BuildingType, BuildingDefinition][]).filter(
    ([, def]) => def.minRound !== undefined
  );

  it('the table actually carries a schedule, and every gate is past the opening round', () => {
    expect(roundGated.length).toBeGreaterThan(0);
    for (const [, def] of roundGated) expect(def.minRound).toBeGreaterThan(1);
  });

  /** p1 owns a Plains Capital plus a target tile of whatever type `def` requires, holds
   *  RICH_WALLET, and already owns any prerequisite building the definition names (Windmill
   *  requires a Farm) so only the round gate is under test. */
  function scheduleFixture(def: BuildingDefinition, roundNumber: number) {
    const capital = { q: 0, r: 0 };
    const target = { q: 1, r: 0 };
    const prereqCoord = { q: 2, r: 0 };
    const p2Capital = { q: 9, r: 9 };
    const owned = [capital, target];
    const tiles: Tile[] = [
      makeTile({ coord: capital, type: 'Plains', ownerId: 'p1' }),
      makeTile({ coord: target, type: firstAllowedTileType(def), ownerId: 'p1' }),
      makeTile({ coord: p2Capital, type: 'Plains', ownerId: 'p2' }),
    ];
    if (def.requiresBuilding) {
      const prereqDef = BUILDING_DEFINITIONS[def.requiresBuilding];
      owned.push(prereqCoord);
      tiles.push(
        makeTile({
          coord: prereqCoord,
          type: firstAllowedTileType(prereqDef),
          ownerId: 'p1',
          building: { id: 'prereq', type: def.requiresBuilding, coord: prereqCoord, ownerId: 'p1' },
        })
      );
    }
    const p1 = makePlayer({ id: 'p1', capitalTile: capital, ownedTiles: owned, resources: RICH_WALLET });
    const p2 = makePlayer({ id: 'p2', capitalTile: p2Capital, ownedTiles: [p2Capital] });
    return { state: fixtureState([p1, p2], tiles, { roundNumber }), target };
  }

  it.each(roundGated)('%s is rejected on the round before its minRound', (type, def) => {
    const { state, target } = scheduleFixture(def, def.minRound! - 1);
    const build = () => applyAction(state, { type: 'Build', actorId: 'p1', buildingType: type, coord: target });
    expect(build).toThrow(IllegalActionError);
    expect(build).toThrow(new RegExp(`before round ${def.minRound}`));
  });

  it.each(roundGated)('%s is rejected on round 1 as well', (type, def) => {
    const { state, target } = scheduleFixture(def, 1);
    const build = () => applyAction(state, { type: 'Build', actorId: 'p1', buildingType: type, coord: target });
    expect(build).toThrow(IllegalActionError);
    // Matching the round-gate message specifically — otherwise a fixture mistake (wrong tile
    // type, unaffordable cost, missing prerequisite) would let this pass for the wrong reason.
    expect(build).toThrow(new RegExp(`before round ${def.minRound}`));
  });

  it.each(roundGated)('%s can be built exactly on its minRound', (type, def) => {
    const { state, target } = scheduleFixture(def, def.minRound!);
    const after = applyAction(state, { type: 'Build', actorId: 'p1', buildingType: type, coord: target });
    expect(tileAt(after, target)?.building?.type).toBe(type);
  });

  it.each(roundGated)('%s can still be built well after its minRound', (type, def) => {
    const { state, target } = scheduleFixture(def, def.minRound! + 5);
    const after = applyAction(state, { type: 'Build', actorId: 'p1', buildingType: type, coord: target });
    expect(tileAt(after, target)?.building?.type).toBe(type);
  });

  it('the schedule is tiered, not one flat gate (basic producers open before the mid-game ones)', () => {
    const gate = (t: BuildingType) => BUILDING_DEFINITIONS[t].minRound!;
    expect(gate('Sawmill')).toBeLessThan(gate('Farm'));
    expect(gate('Farm')).toBeLessThan(gate('HuntingLodge'));
    expect(gate('HuntingLodge')).toBeLessThan(gate('Windmill'));
    // Windmill is second-order: its prerequisite must be available strictly earlier.
    expect(gate('Farm')).toBeLessThan(gate('Windmill'));
  });
});

describe('Build schedule: the intentionally UN-gated buildings (balance rework)', () => {
  // Barracks/CowStable/Watchtower carry no minRound on purpose — Barracks' cost is its gate,
  // and gating the Risk layer further is the opposite of what the rework wanted. A regression
  // here would quietly push military play even later, so it gets an explicit test.
  const ungated: BuildingType[] = ['Barracks', 'CowStable', 'Watchtower'];

  it.each(ungated)('%s declares no minRound', (type) => {
    expect(BUILDING_DEFINITIONS[type].minRound).toBeUndefined();
  });

  it.each(ungated)('%s can be built on round 1', (type) => {
    const capital = { q: 0, r: 0 };
    const p2Capital = { q: 9, r: 9 };
    const p1 = makePlayer({ id: 'p1', capitalTile: capital, ownedTiles: [capital], resources: RICH_WALLET });
    const p2 = makePlayer({ id: 'p2', capitalTile: p2Capital, ownedTiles: [p2Capital] });
    const tiles = [makeTile({ coord: capital, type: 'Plains', ownerId: 'p1' }), makeTile({ coord: p2Capital, type: 'Plains', ownerId: 'p2' })];
    const state = fixtureState([p1, p2], tiles, { roundNumber: 1 });
    const after = applyAction(state, { type: 'Build', actorId: 'p1', buildingType: type, coord: capital });
    expect(tileAt(after, capital)?.building?.type).toBe(type);
  });

  it('Barracks costs less Ore than Food or Wood — Ore-heavy pricing made the Risk layer terrain-dependent', () => {
    const cost = BUILDING_DEFINITIONS.Barracks.cost;
    expect(cost).toEqual({ Wood: 3, Ore: 2, Food: 5 });
    expect(cost.Ore!).toBeLessThan(cost.Wood!);
    expect(cost.Ore!).toBeLessThan(cost.Food!);
  });
});

describe('Barracks: Plains-only (balance rework)', () => {
  const cost = BUILDING_DEFINITIONS.Barracks.cost;

  it('rejects building Barracks on a Forest tile', () => {
    const capital = { q: 0, r: 0 };
    const forest = { q: 1, r: 0 };
    const p1 = makePlayer({
      id: 'p1',
      capitalTile: capital,
      ownedTiles: [capital, forest],
      resources: { Wood: cost.Wood!, Ore: cost.Ore!, Food: cost.Food! },
    });
    const p2 = makePlayer({ id: 'p2', capitalTile: { q: 9, r: 9 }, ownedTiles: [{ q: 9, r: 9 }] });
    const tiles = [
      makeTile({ coord: capital, type: 'Plains', ownerId: 'p1' }),
      makeTile({ coord: forest, type: 'Forest', ownerId: 'p1' }),
      makeTile({ coord: { q: 9, r: 9 }, type: 'Plains', ownerId: 'p2' }),
    ];
    const state = fixtureState([p1, p2], tiles);
    expect(() => applyAction(state, { type: 'Build', actorId: 'p1', buildingType: 'Barracks', coord: forest })).toThrow(IllegalActionError);
  });

  it('rejects building Barracks on a Mountain tile', () => {
    const capital = { q: 0, r: 0 };
    const mountain = { q: 1, r: 0 };
    const p1 = makePlayer({
      id: 'p1',
      capitalTile: capital,
      ownedTiles: [capital, mountain],
      resources: { Wood: cost.Wood!, Ore: cost.Ore!, Food: cost.Food! },
    });
    const p2 = makePlayer({ id: 'p2', capitalTile: { q: 9, r: 9 }, ownedTiles: [{ q: 9, r: 9 }] });
    const tiles = [
      makeTile({ coord: capital, type: 'Plains', ownerId: 'p1' }),
      makeTile({ coord: mountain, type: 'Mountain', ownerId: 'p1' }),
      makeTile({ coord: { q: 9, r: 9 }, type: 'Plains', ownerId: 'p2' }),
    ];
    const state = fixtureState([p1, p2], tiles);
    expect(() => applyAction(state, { type: 'Build', actorId: 'p1', buildingType: 'Barracks', coord: mountain })).toThrow(IllegalActionError);
  });

  it('allows building Barracks on a Plains tile, initializing militiaCount to 0', () => {
    const capital = { q: 0, r: 0 };
    const p1 = makePlayer({
      id: 'p1',
      capitalTile: capital,
      ownedTiles: [capital],
      resources: { Wood: cost.Wood!, Ore: cost.Ore!, Food: cost.Food! },
    });
    const p2 = makePlayer({ id: 'p2', capitalTile: { q: 9, r: 9 }, ownedTiles: [{ q: 9, r: 9 }] });
    const tiles = [makeTile({ coord: capital, type: 'Plains', ownerId: 'p1' }), makeTile({ coord: { q: 9, r: 9 }, type: 'Plains', ownerId: 'p2' })];
    const state = fixtureState([p1, p2], tiles);
    const after = applyAction(state, { type: 'Build', actorId: 'p1', buildingType: 'Barracks', coord: capital });
    const tile = tileAt(after, capital)!;
    expect(tile.building?.type).toBe('Barracks');
    expect(tile.militiaCount).toBe(0);
  });
});

describe('Barracks: passive Soldier production & reserve cap (balance rework)', () => {
  it('accumulates territory-scaled recruits per round and holds at BARRACKS_RESERVE_CAP over many rounds', () => {
    const capital = { q: 0, r: 0 };
    const p2Capital = { q: 9, r: 9 };
    // A large Food stockpile so per-round Soldier upkeep (charged automatically each time it
    // becomes p1's turn again) never causes desertion and confounds the cap measurement.
    const p1 = makePlayer({ id: 'p1', capitalTile: capital, ownedTiles: [capital], resources: { Food: 1000 } });
    const p2 = makePlayer({ id: 'p2', capitalTile: p2Capital, ownedTiles: [p2Capital] });
    const barracksTile = makeTile({
      coord: capital,
      type: 'Plains',
      ownerId: 'p1',
      building: { id: 'b1', type: 'Barracks', coord: capital, ownerId: 'p1' },
      militiaCount: 0,
    });
    const p2Tile = makeTile({ coord: p2Capital, type: 'Plains', ownerId: 'p2' });
    let state = fixtureState([p1, p2], [barracksTile, p2Tile], {
      turnOrder: ['p1', 'p2'],
      currentPlayerId: 'p1',
      currentPhase: Phase.DrawAndPlaceTile,
    });

    function advanceToGather(s: GameState): GameState {
      const actorId = s.currentPlayerId;
      // §3: drawing a tile each turn is mandatory before Phase 1 can be left (reducers.ts's
      // requireTileDrawnThisTurn) — draw here so this pass-through-Phase-1 helper honestly
      // satisfies the rule the same way a real turn would.
      let x = applyAction(s, { type: 'DrawTile', actorId });
      x = applyAction(x, { type: 'AdvancePhase', actorId }); // -> MoveHero
      x = applyAction(x, { type: 'AdvancePhase', actorId }); // -> Gather (accumulation fires here)
      return x;
    }

    /** EndTurn from wherever `s` currently sits, drawing the mandatory §3 tile first if the
     *  active player is still parked in Phase 1 (e.g. the OTHER player's turn, which this test
     *  never routes through advanceToGather). */
    function safeEndTurn(s: GameState): GameState {
      const actorId = s.currentPlayerId;
      const drawn =
        s.currentPhase === Phase.DrawAndPlaceTile && s.pendingTileDraw === null && !s.hasPlacedTileThisTurn
          ? applyAction(s, { type: 'DrawTile', actorId })
          : s;
      return applyAction(drawn, { type: 'EndTurn', actorId });
    }

    // [DEFAULT — balance rework pass 3] The rate is territory-scaled, not flat: p1 holds a single
    // tile, so soldiersPerRoundFor(1) is the SOLDIERS_PER_BARRACKS_MIN floor of 1 per round.
    const perRound = soldiersPerRoundFor(1);
    state = advanceToGather(state); // p1's first production step: militiaCount 0 -> perRound
    expect(tileAt(state, capital)?.militiaCount).toBe(perRound);
    state = safeEndTurn(state); // p1 -> p2
    state = safeEndTurn(state); // p2 -> p1 (new round, upkeep charged)

    // Enough further rounds that an UNCLAMPED reserve would overshoot the cap outright —
    // otherwise this lands on BARRACKS_RESERVE_CAP by arithmetic coincidence and never actually
    // exercises the Math.min in accumulateTileProduction.
    const extraRounds = BARRACKS_RESERVE_CAP + 5;
    expect(perRound * (extraRounds + 1)).toBeGreaterThan(BARRACKS_RESERVE_CAP);
    for (let i = 0; i < extraRounds; i++) {
      state = advanceToGather(state);
      state = safeEndTurn(state);
      state = safeEndTurn(state);
    }

    expect(tileAt(state, capital)?.militiaCount).toBe(BARRACKS_RESERVE_CAP);
  });
});

/** [DEFAULT — territory rework] DeploySoldiers is now only half the soldier-movement story:
 *  reinforcing, invading and territory combat all moved to MoveSoldiersAction, which takes ground
 *  by marching onto it (see engine/__tests__/territory.test.ts). What survives here is the
 *  Barracks-reserve reassignment these cases already covered — every fixture below is a garrison
 *  standing on its OWN owner's ground, which is the only shape applyDeploySoldiers reasons about
 *  correctly. The occupier-vs-owner cases it gets WRONG are pinned in territory.test.ts's
 *  "KNOWN ENGINE BUGS" block rather than here, because they are engine defects, not deploy rules. */
describe('DeploySoldiers (balance rework, supersedes BuyMilitia)', () => {
  function twoPlayerBarracksFixture(fromMilitia: number, extraTiles: Tile[] = []) {
    const capital = { q: 0, r: 0 };
    const outpost = { q: 1, r: 0 };
    const p2Capital = { q: 9, r: 9 };
    const p1 = makePlayer({ id: 'p1', capitalTile: capital, ownedTiles: [capital, outpost] });
    const p2 = makePlayer({ id: 'p2', capitalTile: p2Capital, ownedTiles: [p2Capital] });
    const barracksTile = makeTile({
      coord: capital,
      type: 'Plains',
      ownerId: 'p1',
      building: { id: 'b1', type: 'Barracks', coord: capital, ownerId: 'p1' },
      militiaCount: fromMilitia,
    });
    const outpostTile = makeTile({ coord: outpost, type: 'Plains', ownerId: 'p1', militiaCount: 0 });
    const p2Tile = makeTile({ coord: p2Capital, type: 'Plains', ownerId: 'p2' });
    const state = fixtureState([p1, p2], [barracksTile, outpostTile, p2Tile, ...extraTiles]);
    return { state, capital, outpost, p2Capital };
  }

  it('happy path: reserve decreases, target garrison increases', () => {
    const { state, capital, outpost } = twoPlayerBarracksFixture(10);
    const after = applyAction(state, { type: 'DeploySoldiers', actorId: 'p1', fromCoord: capital, toCoord: outpost, count: 4 });
    expect(tileAt(after, capital)?.militiaCount).toBe(6);
    expect(tileAt(after, outpost)?.militiaCount).toBe(4);
  });

  it('rejects when fromCoord has no Barracks', () => {
    const { state, outpost, capital } = twoPlayerBarracksFixture(10);
    // outpost has no Barracks — try to "deploy" out of it instead of the real Barracks tile.
    expect(() => applyAction(state, { type: 'DeploySoldiers', actorId: 'p1', fromCoord: outpost, toCoord: capital, count: 1 })).toThrow(
      IllegalActionError
    );
  });

  it('rejects when count exceeds the reserve', () => {
    const { state, capital, outpost } = twoPlayerBarracksFixture(3);
    expect(() => applyAction(state, { type: 'DeploySoldiers', actorId: 'p1', fromCoord: capital, toCoord: outpost, count: 5 })).toThrow(
      IllegalActionError
    );
  });

  it("rejects when toCoord isn't owned by the actor", () => {
    const { state, capital, p2Capital } = twoPlayerBarracksFixture(10);
    expect(() =>
      applyAction(state, { type: 'DeploySoldiers', actorId: 'p1', fromCoord: capital, toCoord: p2Capital, count: 1 })
    ).toThrow(IllegalActionError);
  });

  it('fromCoord === toCoord is a harmless no-op', () => {
    const { state, capital } = twoPlayerBarracksFixture(7);
    const after = applyAction(state, { type: 'DeploySoldiers', actorId: 'p1', fromCoord: capital, toCoord: capital, count: 4 });
    expect(tileAt(after, capital)?.militiaCount).toBe(7);
  });
});

describe('Soldier upkeep (resolveSoldierUpkeep, balance rework)', () => {
  /** Puts `target` through Phase 0 exactly once (via a dummy player's EndTurn), so upkeep
   *  charges against target's pre-set map/resources without needing a full round loop. */
  function chargeUpkeepFor(target: Player, targetTiles: Tile[]): GameState {
    const dummyCoord = { q: 50, r: 50 };
    const dummy = makePlayer({ id: 'dummy', capitalTile: dummyCoord, ownedTiles: [dummyCoord] });
    const dummyTile = makeTile({ coord: dummyCoord, type: 'Plains', ownerId: 'dummy' });
    const state = fixtureState([dummy, target], [dummyTile, ...targetTiles], {
      turnOrder: ['dummy', target.id],
      currentPlayerId: 'dummy',
      currentPhase: Phase.Build,
    });
    return applyAction(state, { type: 'EndTurn', actorId: 'dummy' });
  }

  it('pays upkeep from Food alone when Food fully covers the bill', () => {
    const capital = { q: 0, r: 0 };
    const militia = 5; // ceil(5/3) = 2 groups * 2 Food/group = 4 Food needed
    const needed = Math.ceil(militia / SOLDIER_UPKEEP_GROUP_SIZE) * SOLDIER_UPKEEP_FOOD_PER_GROUP;
    const target = makePlayer({ id: 'target', capitalTile: capital, ownedTiles: [capital], resources: { Food: 10, Meat: 0 } });
    const tile = makeTile({ coord: capital, type: 'Plains', ownerId: 'target', militiaCount: militia });
    const after = chargeUpkeepFor(target, [tile]);
    const p = after.players.find((x) => x.id === 'target')!;
    expect(p.resources.Food).toBe(10 - needed);
    expect(p.resources.Meat).toBe(0);
    expect(tileAt(after, capital)?.militiaCount).toBe(militia); // no desertion, fully paid
  });

  it('spends Meat FIRST and only falls back to Food for the remainder', () => {
    // [balance rework pass 2] Deliberate ordering change: Meat's only use in the entire game is
    // feeding soldiers, while Food also buys buildings, Capital tiers and hero level-ups. Paying
    // Food first drained wallets to zero every round and starved hero progression, so upkeep now
    // burns the single-purpose resource before touching the contested one.
    const capital = { q: 0, r: 0 };
    const militia = 5; // needed = 4 food-equivalent units
    const needed = Math.ceil(militia / SOLDIER_UPKEEP_GROUP_SIZE) * SOLDIER_UPKEEP_FOOD_PER_GROUP;
    const startFood = 3;
    const startMeat = 1;
    // 1 Meat covers MEAT_UPKEEP_VALUE units; Food covers only what's left after that.
    const meatUse = Math.min(startMeat, Math.floor(needed / MEAT_UPKEEP_VALUE));
    const foodUse = needed - meatUse * MEAT_UPKEEP_VALUE;
    const target = makePlayer({ id: 'target', capitalTile: capital, ownedTiles: [capital], resources: { Food: startFood, Meat: startMeat } });
    const tile = makeTile({ coord: capital, type: 'Plains', ownerId: 'target', militiaCount: militia });
    const after = chargeUpkeepFor(target, [tile]);
    const p = after.players.find((x) => x.id === 'target')!;
    expect(p.resources.Meat).toBe(startMeat - meatUse); // Meat consumed before Food
    expect(p.resources.Food).toBe(startFood - foodUse);
    expect(tileAt(after, capital)?.militiaCount).toBe(militia); // no desertion, fully paid
  });

  it('covers the whole bill from Meat alone when there is enough of it, leaving Food untouched', () => {
    const capital = { q: 0, r: 0 };
    const militia = 5; // needed = 4 food-equivalent units = 2 Meat
    const needed = Math.ceil(militia / SOLDIER_UPKEEP_GROUP_SIZE) * SOLDIER_UPKEEP_FOOD_PER_GROUP;
    const target = makePlayer({ id: 'target', capitalTile: capital, ownedTiles: [capital], resources: { Food: 7, Meat: 5 } });
    const tile = makeTile({ coord: capital, type: 'Plains', ownerId: 'target', militiaCount: militia });
    const after = chargeUpkeepFor(target, [tile]);
    const p = after.players.find((x) => x.id === 'target')!;
    expect(p.resources.Food).toBe(7); // Food is the contested resource — protect it
    expect(p.resources.Meat).toBe(5 - needed / MEAT_UPKEEP_VALUE);
    expect(tileAt(after, capital)?.militiaCount).toBe(militia);
  });

  it('deserts Soldiers on a shortfall, trimming the largest garrison first, and empties the wallet', () => {
    const bigCoord = { q: 0, r: 0 };
    const smallCoord = { q: 1, r: 0 };
    const bigMilitia = 10;
    const smallMilitia = 5;
    const target = makePlayer({
      id: 'target',
      capitalTile: bigCoord,
      ownedTiles: [bigCoord, smallCoord],
      resources: { Food: 1, Meat: 1 }, // paidEquivalent = 1 + 1*MEAT_UPKEEP_VALUE = 3 -> 1 sustainable group (3 soldiers)
    });
    const bigTile = makeTile({ coord: bigCoord, type: 'Plains', ownerId: 'target', militiaCount: bigMilitia });
    const smallTile = makeTile({ coord: smallCoord, type: 'Plains', ownerId: 'target', militiaCount: smallMilitia });
    const after = chargeUpkeepFor(target, [bigTile, smallTile]);
    const p = after.players.find((x) => x.id === 'target')!;
    expect(p.resources.Food).toBe(0);
    expect(p.resources.Meat).toBe(0);
    // sustainableSoldiers = floor((1 + 1*2) / 2) * 3 = 3; trimmed from the biggest garrison first.
    expect(tileAt(after, bigCoord)?.militiaCount).toBe(0);
    expect(tileAt(after, smallCoord)?.militiaCount).toBe(3);
  });

  it('does nothing when the player has no Soldiers anywhere', () => {
    const capital = { q: 0, r: 0 };
    const target = makePlayer({ id: 'target', capitalTile: capital, ownedTiles: [capital], resources: { Food: 5, Meat: 5 } });
    const tile = makeTile({ coord: capital, type: 'Plains', ownerId: 'target' }); // militiaCount undefined/0
    const after = chargeUpkeepFor(target, [tile]);
    const p = after.players.find((x) => x.id === 'target')!;
    expect(p.resources.Food).toBe(5);
    expect(p.resources.Meat).toBe(5);
  });
});

describe('Multi-tier building upgrades (UpgradeBuildingAction, balance rework)', () => {
  type UpgradableType = 'Farm' | 'Quarry' | 'CowStable';

  /** A tile holding `buildingType` at `currentTier`, owned by a p1 whose wallet contains
   *  EXACTLY the cost of the next tier — so if payment is wrong in either direction, the
   *  post-upgrade "every resource is back to zero" assertion catches it. Tier 1 is stored as
   *  an ABSENT tier field on purpose (the undefined-means-1 convention, see selectors.tierOf). */
  function tierFixture(buildingType: UpgradableType, tileType: TileType, currentTier: number, wallet?: Partial<ResourceBundle>) {
    const coord = { q: 0, r: 0 };
    const p2Capital = { q: 9, r: 9 };
    const def = BUILDING_DEFINITIONS[buildingType];
    const next = nextUpgradeFor(def, currentTier);
    const p1 = makePlayer({ id: 'p1', capitalTile: coord, ownedTiles: [coord], resources: wallet ?? { ...(next?.cost ?? {}) } });
    const p2 = makePlayer({ id: 'p2', capitalTile: p2Capital, ownedTiles: [p2Capital] });
    const tile = makeTile({
      coord,
      type: tileType,
      ownerId: 'p1',
      building: { id: 'b1', type: buildingType, coord, ownerId: 'p1', ...(currentTier > 1 ? { tier: currentTier } : {}) },
    });
    const p2Tile = makeTile({ coord: p2Capital, type: 'Plains', ownerId: 'p2' });
    const state = fixtureState([p1, p2], [tile, p2Tile], { turnOrder: ['p1', 'p2'], currentPlayerId: 'p1' });
    return { state, coord, def, next };
  }

  it('a freshly built building has no tier field and reads as tier 1', () => {
    const { state, coord } = tierFixture('CowStable', 'Plains', 1);
    const tile = tileAt(state, coord)!;
    expect(tile.building!.tier).toBeUndefined();
    expect(tierOf(tile.building!)).toBe(1);
  });

  it('CowStable walks 1 -> 2 -> 3 -> 4 -> 5, each step charging that tier\'s own cost', () => {
    const def = BUILDING_DEFINITIONS.CowStable;
    expect(maxTierFor(def)).toBe(5);
    for (let tier = 1; tier < maxTierFor(def); tier++) {
      const { state, coord, next } = tierFixture('CowStable', 'Plains', tier);
      const after = applyAction(state, { type: 'UpgradeBuilding', actorId: 'p1', coord });
      const building = tileAt(after, coord)!.building!;
      expect(tierOf(building)).toBe(tier + 1);
      // Wallet held exactly this tier's cost — an over- or under-charge shows up here.
      const p = after.players.find((x) => x.id === 'p1')!;
      for (const r of RESOURCE_TYPES) expect(p.resources[r]).toBe(0);
      expect(produceAmountForTier(def, tierOf(building))).toBe(next!.produceAmount);
    }
  });

  it('CowStable production climbs 1, 2, 3, 4, 5 Meat/round across its five tiers', () => {
    // Starting at 1 (it used to open at 3) is the whole point of the retune: one cheap
    // building must no longer cover a 9-Soldier army's upkeep outright.
    expect(BUILDING_DEFINITIONS.CowStable.produceAmount).toBe(1);
    expect(BUILDING_DEFINITIONS.CowStable.upgrades!.map((u) => u.produceAmount)).toEqual([2, 3, 4, 5]);
  });

  it.each([1, 2, 3, 4, 5])('a tier %i CowStable actually stockpiles that much Meat in one production step', (tier) => {
    const { state: base, coord } = tierFixture('CowStable', 'Plains', tier, {});
    // Phase 1 is a pure pass-through here (not under test), so satisfy §3's "drew a tile this
    // turn" reducer guard directly on the fixture rather than actually drawing one.
    let state = { ...base, currentPhase: Phase.DrawAndPlaceTile, hasPlacedTileThisTurn: true };
    state = applyAction(state, { type: 'AdvancePhase', actorId: 'p1' }); // -> MoveHero
    state = applyAction(state, { type: 'AdvancePhase', actorId: 'p1' }); // -> Gather (accumulation fires)
    expect(tileAt(state, coord)?.stockpile.Meat).toBe(tier);
    expect(tileAt(state, coord)?.stockpile.Meat).toBe(produceAmountForTier(BUILDING_DEFINITIONS.CowStable, tier));
  });

  it.each(['Farm', 'Quarry'] as const)('%s walks 1 -> 2 -> 3 and stops there', (buildingType) => {
    const def = BUILDING_DEFINITIONS[buildingType];
    const tileType: TileType = buildingType === 'Farm' ? 'Plains' : 'Hills';
    expect(maxTierFor(def)).toBe(3);
    expect(def.produceAmount).toBe(1);
    expect(def.upgrades!.map((u) => u.produceAmount)).toEqual([2, 3]);

    for (const tier of [1, 2]) {
      const { state, coord } = tierFixture(buildingType, tileType, tier);
      const after = applyAction(state, { type: 'UpgradeBuilding', actorId: 'p1', coord });
      expect(tierOf(tileAt(after, coord)!.building!)).toBe(tier + 1);
      const p = after.players.find((x) => x.id === 'p1')!;
      for (const r of RESOURCE_TYPES) expect(p.resources[r]).toBe(0);
    }
  });

  it.each([
    ['CowStable', 'Plains'],
    ['Farm', 'Plains'],
    ['Quarry', 'Hills'],
  ] as const)('rejects upgrading a %s already at its max tier', (buildingType, tileType) => {
    const maxTier = maxTierFor(BUILDING_DEFINITIONS[buildingType]);
    // A deliberately huge wallet, so the rejection can only be about the tier cap.
    const { state, coord } = tierFixture(buildingType, tileType, maxTier, RICH_WALLET);
    expect(() => applyAction(state, { type: 'UpgradeBuilding', actorId: 'p1', coord })).toThrow(IllegalActionError);
    expect(() => applyAction(state, { type: 'UpgradeBuilding', actorId: 'p1', coord })).toThrow(/max tier/);
  });

  it('rejects UpgradeBuilding on a building with no upgrades defined at all (e.g. Sawmill)', () => {
    const coord = { q: 0, r: 0 };
    const p2Capital = { q: 9, r: 9 };
    expect(BUILDING_DEFINITIONS.Sawmill.upgrades).toBeUndefined();
    const p1 = makePlayer({ id: 'p1', capitalTile: coord, ownedTiles: [coord], resources: RICH_WALLET });
    const p2 = makePlayer({ id: 'p2', capitalTile: p2Capital, ownedTiles: [p2Capital] });
    const tile = makeTile({ coord, type: 'Forest', ownerId: 'p1', building: { id: 'b1', type: 'Sawmill', coord, ownerId: 'p1' } });
    const p2Tile = makeTile({ coord: p2Capital, type: 'Plains', ownerId: 'p2' });
    const state = fixtureState([p1, p2], [tile, p2Tile], { turnOrder: ['p1', 'p2'], currentPlayerId: 'p1' });
    expect(() => applyAction(state, { type: 'UpgradeBuilding', actorId: 'p1', coord })).toThrow(IllegalActionError);
  });

  it('rejects an upgrade the player cannot afford (one short of the tier cost)', () => {
    const def = BUILDING_DEFINITIONS.CowStable;
    const cost = nextUpgradeFor(def, 1)!.cost;
    const oneShort: Partial<ResourceBundle> = { ...cost, Food: cost.Food! - 1 };
    const { state, coord } = tierFixture('CowStable', 'Plains', 1, oneShort);
    expect(() => applyAction(state, { type: 'UpgradeBuilding', actorId: 'p1', coord })).toThrow(IllegalActionError);
  });

  it('consumes the turn\'s one Build slot, so a second Phase 5 action is rejected', () => {
    const { state, coord } = tierFixture('CowStable', 'Plains', 1, RICH_WALLET);
    const after = applyAction(state, { type: 'UpgradeBuilding', actorId: 'p1', coord });
    expect(after.hasBuiltThisTurn).toBe(true);
    expect(() => applyAction(after, { type: 'UpgradeBuilding', actorId: 'p1', coord })).toThrow(IllegalActionError);
  });

  it('each upgrade tier costs strictly more than the tier below, and none is cheaper than the original build', () => {
    // Note the first upgrade is allowed to cost exactly what the building itself did — CowStable
    // is priced that way on purpose (same bill, double the output). It's the tiers ABOVE that
    // must escalate, or later tiers would be free money.
    const total = (cost: Partial<ResourceBundle>) => RESOURCE_TYPES.reduce((sum, r) => sum + (cost[r] ?? 0), 0);
    for (const def of [BUILDING_DEFINITIONS.CowStable, BUILDING_DEFINITIONS.Farm, BUILDING_DEFINITIONS.Quarry]) {
      const upgradeCosts = def.upgrades!.map((u) => total(u.cost));
      expect(upgradeCosts[0]).toBeGreaterThanOrEqual(total(def.cost));
      for (let i = 1; i < upgradeCosts.length; i++) expect(upgradeCosts[i]).toBeGreaterThan(upgradeCosts[i - 1]);
    }
  });
});

describe('TILE_STOCKPILE_CAP (balance rework: lowered 10 -> 5)', () => {
  it('pins the retuned value — an uncollected tile banks at most one level-1 hero-load', () => {
    // The one place the literal lives in a test. Everything else asserts against the constant.
    expect(TILE_STOCKPILE_CAP).toBe(5);
  });

  it('a tile nobody collects from tops out at TILE_STOCKPILE_CAP per resource type', () => {
    const capital = { q: 0, r: 0 };
    const p2Capital = { q: 9, r: 9 };
    // A CowStable on a Plains Capital puts TWO resource types on one tile (base Food from the
    // terrain, Meat from the building) so the per-resource-type nature of the cap is exercised,
    // not just a single running total.
    const p1 = makePlayer({ id: 'p1', capitalTile: capital, ownedTiles: [capital], resources: { Food: 1000, Meat: 1000 } });
    const p2 = makePlayer({ id: 'p2', capitalTile: p2Capital, ownedTiles: [p2Capital] });
    const tiles = [
      makeTile({
        coord: capital,
        type: 'Plains',
        ownerId: 'p1',
        building: { id: 'b1', type: 'CowStable', coord: capital, ownerId: 'p1' },
      }),
      makeTile({ coord: p2Capital, type: 'Plains', ownerId: 'p2' }),
    ];
    let state = fixtureState([p1, p2], tiles, {
      turnOrder: ['p1', 'p2'],
      currentPlayerId: 'p1',
      currentPhase: Phase.DrawAndPlaceTile,
      roundNumber: 1,
    });

    // Ten full rounds without a single Gather — far more production than the cap allows.
    for (let i = 0; i < 10; i++) {
      state = applyAction(state, { type: 'DrawTile', actorId: 'p1' }); // §3: mandatory before leaving Phase 1
      state = applyAction(state, { type: 'AdvancePhase', actorId: 'p1' }); // -> MoveHero
      state = applyAction(state, { type: 'AdvancePhase', actorId: 'p1' }); // -> Gather (accumulate)
      state = applyAction(state, { type: 'EndTurn', actorId: state.currentPlayerId }); // p1 -> p2
      state = applyAction(state, { type: 'DrawTile', actorId: state.currentPlayerId }); // p2's mandatory §3 draw
      state = applyAction(state, { type: 'EndTurn', actorId: state.currentPlayerId }); // p2 -> p1, new round
    }

    const stockpile = tileAt(state, capital)!.stockpile;
    expect(stockpile.Food).toBe(TILE_STOCKPILE_CAP);
    expect(stockpile.Meat).toBe(TILE_STOCKPILE_CAP);
    for (const r of RESOURCE_TYPES) expect(stockpile[r]).toBeLessThanOrEqual(TILE_STOCKPILE_CAP);
  });

  it('a high-tier producer cannot overshoot the cap in a single production step either', () => {
    // A tier-5 CowStable makes 5 Meat/round; starting from a tile already holding some Meat,
    // the cap must clamp rather than letting one big step run past it.
    const capital = { q: 0, r: 0 };
    const p2Capital = { q: 9, r: 9 };
    const p1 = makePlayer({ id: 'p1', capitalTile: capital, ownedTiles: [capital] });
    const p2 = makePlayer({ id: 'p2', capitalTile: p2Capital, ownedTiles: [p2Capital] });
    const tiles = [
      makeTile({
        coord: capital,
        type: 'Plains',
        ownerId: 'p1',
        building: { id: 'b1', type: 'CowStable', coord: capital, ownerId: 'p1', tier: 5 },
        stockpile: { ...emptyResourceBundle(), Meat: TILE_STOCKPILE_CAP - 1 },
      }),
      makeTile({ coord: p2Capital, type: 'Plains', ownerId: 'p2' }),
    ];
    let state = fixtureState([p1, p2], tiles, { turnOrder: ['p1', 'p2'], currentPlayerId: 'p1', currentPhase: Phase.DrawAndPlaceTile });
    state = applyAction(state, { type: 'DrawTile', actorId: 'p1' }); // §3: mandatory before leaving Phase 1
    state = applyAction(state, { type: 'AdvancePhase', actorId: 'p1' }); // -> MoveHero
    state = applyAction(state, { type: 'AdvancePhase', actorId: 'p1' }); // -> Gather (accumulate 5 Meat)
    expect(tileAt(state, capital)?.stockpile.Meat).toBe(TILE_STOCKPILE_CAP);
  });
});
