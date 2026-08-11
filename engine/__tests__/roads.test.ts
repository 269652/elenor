import { describe, expect, it } from 'vitest';
import { applyAction } from '../reducer';
import { hasRoadBetween, roadConnectedTiles, tileAt } from '../selectors';
import { BARRACKS_RESERVE_CAP, ROAD_COST, soldiersPerRoundFor, TILE_STOCKPILE_CAP } from '../constants';
import { edgeKey, emptyResourceBundle, hexKey, IllegalActionError, Phase, RESOURCE_TYPES } from '../types';
import type { GameState, HexCoord, Player, PlayerId, ResourceBundle, Tile } from '../types';
import { makePlayer, makeTile } from './testUtils';

/**
 * [DEFAULT — roads] Roads live on EDGES (GameState.roads, keyed by edgeKey) and exist to solve one
 * structural problem: a single movement-2 hero was both the empire's logistics corps and its
 * adventurer, so hauling crowded out everything else. Any owned tile joined to its owner's Capital
 * by an unbroken chain of that player's OWN roads, over tiles they own, has its stockpile swept
 * straight into the wallet each round — no hero visit, no carry cap, no deposit trip.
 *
 * Two rules in here are subtle enough to be worth naming: the Capital is the network's ANCHOR and
 * is deliberately NOT a member of the connected set, and traversal refuses to cross ground the
 * player doesn't own, so losing one mid-chain tile severs everything beyond it.
 */

// ── Fixture ────────────────────────────────────────────────────────────────────────────────

const CAPITAL: HexCoord = { q: 0, r: 0 };
const A: HexCoord = { q: 1, r: 0 };
const B: HexCoord = { q: 2, r: 0 };
const C: HexCoord = { q: 3, r: 0 };
/** Adjacent to CAPITAL, placed, owned by nobody. */
const FRONTIER: HexCoord = { q: 1, r: -1 };
/** Adjacent to CAPITAL but deliberately never placed. */
const UNPLACED: HexCoord = { q: 0, r: -1 };
/** p2's pair, far away from p1's chain and adjacent to each other. */
const P2_CAPITAL: HexCoord = { q: 9, r: 9 };
const P2_SECOND: HexCoord = { q: 10, r: 9 };

const ROAD_WOOD = ROAD_COST.Wood ?? 0;

function fixtureState(players: Player[], tiles: Tile[], overrides: Partial<GameState> = {}): GameState {
  const map: Record<string, Tile> = {};
  for (const t of tiles) map[hexKey(t.coord)] = t;
  return {
    gameId: 'g-roads',
    mode: 'hotseat',
    status: 'active',
    rngSeed: 'roads-seed',
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
    lootDeck: {
      drawPiles: { Common: [], Uncommon: [], Rare: [], Legendary: [] },
      discardPiles: { Common: [], Uncommon: [], Rare: [], Legendary: [] },
    },
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

interface NetworkOptions {
  /** Which of CAPITAL/A/B/C p1 owns. Defaults to the full chain. */
  p1Owns?: HexCoord[];
  /** Tiles owned by p2 among p1's chain (an invader who took a mid-chain tile). */
  p2Owns?: HexCoord[];
  wood?: number;
  roads?: Record<string, PlayerId>;
  stockpiles?: { coord: HexCoord; stockpile: Partial<ResourceBundle> }[];
  state?: Partial<GameState>;
}

function networkFixture(opts: NetworkOptions = {}) {
  const p1Owns = opts.p1Owns ?? [CAPITAL, A, B, C];
  const p2Owns = opts.p2Owns ?? [];
  const ownerOf = (coord: HexCoord): PlayerId | null => {
    if (p1Owns.some((c) => hexKey(c) === hexKey(coord))) return 'p1';
    if (p2Owns.some((c) => hexKey(c) === hexKey(coord))) return 'p2';
    return null;
  };
  const stockpileFor = (coord: HexCoord): ResourceBundle => {
    const seeded = opts.stockpiles?.find((s) => hexKey(s.coord) === hexKey(coord));
    return { ...emptyResourceBundle(), ...(seeded?.stockpile ?? {}) };
  };

  const p1 = makePlayer({
    id: 'p1',
    capitalTile: CAPITAL,
    ownedTiles: p1Owns,
    resources: { Wood: opts.wood ?? ROAD_WOOD },
  });
  const p2 = makePlayer({
    id: 'p2',
    capitalTile: P2_CAPITAL,
    ownedTiles: [P2_CAPITAL, P2_SECOND, ...p2Owns],
    resources: { Wood: 10 },
  });

  const tiles: Tile[] = [
    makeTile({ coord: CAPITAL, type: 'Plains', ownerId: ownerOf(CAPITAL), stockpile: stockpileFor(CAPITAL) }),
    makeTile({ coord: A, type: 'Forest', ownerId: ownerOf(A), stockpile: stockpileFor(A) }),
    makeTile({ coord: B, type: 'Forest', ownerId: ownerOf(B), stockpile: stockpileFor(B) }),
    makeTile({ coord: C, type: 'Forest', ownerId: ownerOf(C), stockpile: stockpileFor(C) }),
    makeTile({ coord: FRONTIER, type: 'Hills', ownerId: null }),
    makeTile({ coord: P2_CAPITAL, type: 'Plains', ownerId: 'p2' }),
    makeTile({ coord: P2_SECOND, type: 'Plains', ownerId: 'p2' }),
  ];

  const state = fixtureState([p1, p2], tiles, {
    turnOrder: ['p1', 'p2'],
    currentPlayerId: 'p1',
    roads: opts.roads ?? {},
    ...opts.state,
  });
  return state;
}

function playerIn(state: GameState, id: PlayerId): Player {
  return state.players.find((p) => p.id === id)!;
}

function eventsOfType(state: GameState, type: string) {
  return state.eventLog.filter((e) => e.type === type);
}

/** Advances the active player from Phase 1 to Phase 3, where production accumulates and the
 *  road network is swept — same entry point economy.test.ts uses. */
function advanceToGather(state: GameState): GameState {
  const actorId = state.currentPlayerId;
  expect(state.currentPhase).toBe(Phase.DrawAndPlaceTile);
  let s = applyAction(state, { type: 'AdvancePhase', actorId }); // -> MoveHero
  s = applyAction(s, { type: 'AdvancePhase', actorId }); // -> Gather
  expect(s.currentPhase).toBe(Phase.Gather);
  return s;
}

// ── edgeKey ────────────────────────────────────────────────────────────────────────────────

describe('edgeKey', () => {
  it('is order-independent — a border is the same border from either side', () => {
    expect(edgeKey(CAPITAL, A)).toBe(edgeKey(A, CAPITAL));
    expect(edgeKey(B, C)).toBe(edgeKey(C, B));
  });

  it('gives distinct edges distinct keys', () => {
    const keys = [edgeKey(CAPITAL, A), edgeKey(A, B), edgeKey(B, C), edgeKey(CAPITAL, FRONTIER)];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('formats as "q1,r1|q2,r2" with the endpoints canonically sorted', () => {
    expect(edgeKey(A, CAPITAL)).toBe(`${hexKey(CAPITAL)}|${hexKey(A)}`);
    // Negative coordinates sort by the same string rule, from either direction.
    expect(edgeKey({ q: -1, r: 0 }, CAPITAL)).toBe(edgeKey(CAPITAL, { q: -1, r: 0 }));
  });
});

// ── BuildRoad ──────────────────────────────────────────────────────────────────────────────

describe('BuildRoad: happy path', () => {
  it('charges ROAD_COST, records the edge against the actor, and logs RoadBuilt', () => {
    const state = networkFixture({ wood: ROAD_WOOD });
    const after = applyAction(state, { type: 'BuildRoad', actorId: 'p1', from: CAPITAL, to: A });

    expect(after.roads[edgeKey(CAPITAL, A)]).toBe('p1');
    expect(hasRoadBetween(after, 'p1', A, CAPITAL)).toBe(true);
    expect(playerIn(after, 'p1').resources.Wood).toBe(0);
    for (const r of RESOURCE_TYPES) {
      if (r === 'Wood') continue;
      expect(playerIn(after, 'p1').resources[r]).toBe(0); // nothing else was touched
    }
    const built = eventsOfType(after, 'RoadBuilt');
    expect(built).toHaveLength(1);
    expect(built[0].payload).toEqual({ from: CAPITAL, to: A });
    expect(built[0].actorId).toBe('p1');
  });

  it('may run one end out to an unowned frontier tile, as long as the other end is yours', () => {
    const state = networkFixture({ wood: ROAD_WOOD });
    const after = applyAction(state, { type: 'BuildRoad', actorId: 'p1', from: CAPITAL, to: FRONTIER });
    expect(after.roads[edgeKey(CAPITAL, FRONTIER)]).toBe('p1');
  });

  it('leaves an unrelated edge untouched (only the one edge is recorded)', () => {
    const state = networkFixture({ wood: 5 });
    const after = applyAction(state, { type: 'BuildRoad', actorId: 'p1', from: CAPITAL, to: A });
    expect(Object.keys(after.roads)).toEqual([edgeKey(CAPITAL, A)]);
    expect(hasRoadBetween(after, 'p1', A, B)).toBe(false);
  });
});

describe('BuildRoad: rejections', () => {
  it('rejects two hexes that are not adjacent', () => {
    const state = networkFixture({ wood: 5 });
    expect(() => applyAction(state, { type: 'BuildRoad', actorId: 'p1', from: CAPITAL, to: B })).toThrow(IllegalActionError);
    expect(() => applyAction(state, { type: 'BuildRoad', actorId: 'p1', from: CAPITAL, to: B })).toThrow(/ADJACENT/i);
  });

  it('rejects an endpoint that is not a placed tile', () => {
    const state = networkFixture({ wood: 5 });
    expect(state.map[hexKey(UNPLACED)]).toBeUndefined();
    expect(() => applyAction(state, { type: 'BuildRoad', actorId: 'p1', from: CAPITAL, to: UNPLACED })).toThrow(/placed tiles/i);
  });

  it('rejects an edge where neither end belongs to the actor', () => {
    const state = networkFixture({ wood: 5 });
    expect(() => applyAction(state, { type: 'BuildRoad', actorId: 'p1', from: P2_CAPITAL, to: P2_SECOND })).toThrow(
      /At least one end/i
    );
  });

  it('rejects an edge that already carries a road — including one somebody else laid', () => {
    const mine = networkFixture({ wood: 5, roads: { [edgeKey(CAPITAL, A)]: 'p1' } });
    expect(() => applyAction(mine, { type: 'BuildRoad', actorId: 'p1', from: CAPITAL, to: A })).toThrow(/already has a road/i);

    const theirs = networkFixture({ wood: 5, roads: { [edgeKey(CAPITAL, A)]: 'p2' } });
    expect(() => applyAction(theirs, { type: 'BuildRoad', actorId: 'p1', from: A, to: CAPITAL })).toThrow(/already has a road/i);
  });

  it('rejects a road the actor cannot afford', () => {
    const state = networkFixture({ wood: 0 });
    expect(() => applyAction(state, { type: 'BuildRoad', actorId: 'p1', from: CAPITAL, to: A })).toThrow(/afford/i);
    expect(() => applyAction(state, { type: 'BuildRoad', actorId: 'p1', from: CAPITAL, to: A })).toThrow(IllegalActionError);
  });

  it('rejects a road built out of turn', () => {
    const state = networkFixture({ wood: 5 });
    expect(() => applyAction(state, { type: 'BuildRoad', actorId: 'p2', from: P2_CAPITAL, to: P2_SECOND })).toThrow(/not p2's turn/i);
  });
});

describe('BuildRoad: Build-phase only', () => {
  it.each([Phase.Production, Phase.DrawAndPlaceTile, Phase.MoveHero, Phase.Gather, Phase.Fight])(
    'rejects a road laid in phase %i — roads are Build-phase only',
    (phase) => {
      const state = networkFixture({ wood: 5, state: { currentPhase: phase } });
      expect(() => applyAction(state, { type: 'BuildRoad', actorId: 'p1', from: CAPITAL, to: A })).toThrow(IllegalActionError);
      expect(() => applyAction(state, { type: 'BuildRoad', actorId: 'p1', from: CAPITAL, to: A })).toThrow(/Build/);
    }
  );

  it('works in Phase.Build and does not advance the phase itself', () => {
    const state = networkFixture({ wood: 5, state: { currentPhase: Phase.Build } });
    const after = applyAction(state, { type: 'BuildRoad', actorId: 'p1', from: CAPITAL, to: A });
    expect(after.roads[edgeKey(CAPITAL, A)]).toBe('p1');
    expect(after.currentPhase).toBe(Phase.Build);
  });
});

describe('BuildRoad does not consume the Build slot', () => {
  it('does not consume the one-build-per-turn slot, so a whole network can go up in one turn', () => {
    const state = networkFixture({ wood: 5 });
    let s = applyAction(state, { type: 'BuildRoad', actorId: 'p1', from: CAPITAL, to: A });
    expect(s.hasBuiltThisTurn).toBe(false);
    s = applyAction(s, { type: 'BuildRoad', actorId: 'p1', from: A, to: B });
    s = applyAction(s, { type: 'BuildRoad', actorId: 'p1', from: B, to: C });
    expect(s.hasBuiltThisTurn).toBe(false);
    expect(Object.keys(s.roads)).toHaveLength(3);
    expect(playerIn(s, 'p1').resources.Wood).toBe(5 - 3 * ROAD_WOOD);
  });

  it('still works after the turn\'s Build action has been spent', () => {
    const rich = networkFixture({ wood: 5, state: { hasBuiltThisTurn: true } });
    const after = applyAction(rich, { type: 'BuildRoad', actorId: 'p1', from: CAPITAL, to: A });
    expect(after.roads[edgeKey(CAPITAL, A)]).toBe('p1');
  });
});

// ── roadConnectedTiles ─────────────────────────────────────────────────────────────────────

describe('roadConnectedTiles', () => {
  it('connects a tile joined to the Capital by one segment', () => {
    const state = networkFixture({ roads: { [edgeKey(CAPITAL, A)]: 'p1' } });
    const connected = roadConnectedTiles(state, playerIn(state, 'p1'));
    expect(connected.has(hexKey(A))).toBe(true);
    expect(connected.has(hexKey(B))).toBe(false);
  });

  it('walks a two-segment chain, connecting both links', () => {
    const state = networkFixture({ roads: { [edgeKey(CAPITAL, A)]: 'p1', [edgeKey(A, B)]: 'p1' } });
    const connected = roadConnectedTiles(state, playerIn(state, 'p1'));
    expect(connected.has(hexKey(A))).toBe(true);
    expect(connected.has(hexKey(B))).toBe(true);
    expect(connected.size).toBe(2);
  });

  it('EXCLUDES the Capital itself — it is the network\'s anchor, not a member', () => {
    // Deliberate and load-bearing: including it would hand every player automatic income from
    // their starting tile before they laid a single road, repealing the collect-and-deposit
    // economy for the one tile everyone is guaranteed to own.
    const withRoads = networkFixture({ roads: { [edgeKey(CAPITAL, A)]: 'p1', [edgeKey(A, B)]: 'p1' } });
    expect(roadConnectedTiles(withRoads, playerIn(withRoads, 'p1')).has(hexKey(CAPITAL))).toBe(false);
    const bare = networkFixture();
    expect(roadConnectedTiles(bare, playerIn(bare, 'p1')).has(hexKey(CAPITAL))).toBe(false);
  });

  it('connects nothing when there are no roads at all', () => {
    const state = networkFixture();
    expect(roadConnectedTiles(state, playerIn(state, 'p1')).size).toBe(0);
  });

  it('does not connect a tile you do not own, even with a road running to it', () => {
    const state = networkFixture({ p1Owns: [CAPITAL], roads: { [edgeKey(CAPITAL, FRONTIER)]: 'p1' } });
    const connected = roadConnectedTiles(state, playerIn(state, 'p1'));
    expect(connected.has(hexKey(FRONTIER))).toBe(false);
    expect(connected.size).toBe(0);
  });

  it('does not connect your tiles via ANOTHER player\'s road', () => {
    const state = networkFixture({ roads: { [edgeKey(CAPITAL, A)]: 'p2', [edgeKey(A, B)]: 'p2' } });
    expect(roadConnectedTiles(state, playerIn(state, 'p1')).size).toBe(0);
    // ...and p2 gains nothing from it either: the chain doesn't touch p2's Capital.
    expect(roadConnectedTiles(state, playerIn(state, 'p2')).size).toBe(0);
  });

  it('gives nothing to a player who has lost their Capital — the anchor is gone', () => {
    const state = networkFixture({ p1Owns: [A, B], p2Owns: [CAPITAL], roads: { [edgeKey(CAPITAL, A)]: 'p1', [edgeKey(A, B)]: 'p1' } });
    expect(roadConnectedTiles(state, playerIn(state, 'p1')).size).toBe(0);
  });
});

describe('roadConnectedTiles: severing a chain', () => {
  it('losing a mid-chain tile cuts off everything beyond it', () => {
    const roads = { [edgeKey(CAPITAL, A)]: 'p1', [edgeKey(A, B)]: 'p1' };
    const intact = networkFixture({ p1Owns: [CAPITAL, A, B], roads });
    const beforeCut = roadConnectedTiles(intact, playerIn(intact, 'p1'));
    expect(beforeCut.has(hexKey(A))).toBe(true);
    expect(beforeCut.has(hexKey(B))).toBe(true);

    // A changes hands (an occupation that claimed through) — the rails are still on the ground,
    // but the supply line no longer runs over ground p1 controls.
    const severed = networkFixture({ p1Owns: [CAPITAL, B], p2Owns: [A], roads });
    const afterCut = roadConnectedTiles(severed, playerIn(severed, 'p1'));
    expect(afterCut.has(hexKey(A))).toBe(false);
    expect(afterCut.has(hexKey(B))).toBe(false);
    expect(afterCut.size).toBe(0);
    // The road segments themselves are untouched — it's the ownership that broke the chain.
    expect(severed.roads[edgeKey(A, B)]).toBe('p1');
  });
});

// ── Auto-collection through the real turn flow ─────────────────────────────────────────────

describe('collectRoadConnectedTiles: the payoff, through the real turn flow', () => {
  it('sweeps a connected tile straight into the wallet and leaves an unconnected pile alone', () => {
    const state = networkFixture({
      p1Owns: [CAPITAL, A, B],
      wood: 0, // an empty wallet, so every Wood asserted below demonstrably came off a tile
      roads: { [edgeKey(CAPITAL, A)]: 'p1' }, // A is connected; B is not
      stockpiles: [
        { coord: A, stockpile: { Wood: 3 } },
        { coord: B, stockpile: { Wood: 2 } },
      ],
      state: { currentPhase: Phase.DrawAndPlaceTile },
    });

    const gathered = advanceToGather(state);
    const p1 = playerIn(gathered, 'p1');

    // A (Forest) produced 1 more Wood, then the whole pile went home — no hero, no carry cap.
    expect(p1.resources.Wood).toBe(4);
    expect(tileAt(gathered, A)!.stockpile.Wood).toBe(0);
    // B produced too, but nothing connects it: its pile stays on the ground.
    expect(tileAt(gathered, B)!.stockpile.Wood).toBe(3);

    // The Capital is excluded from the sweep, so its own production stays on the tile.
    expect(tileAt(gathered, CAPITAL)!.stockpile.Food).toBeGreaterThan(0);
    expect(p1.resources.Food).toBe(0);

    const collected = eventsOfType(gathered, 'RoadSupplyCollected');
    expect(collected).toHaveLength(1);
    expect(collected[0].payload).toMatchObject({ tiles: 1, collected: { Wood: 4 } });
  });

  it('keeps sweeping every round, so a connected tile never sits at TILE_STOCKPILE_CAP', () => {
    let state = networkFixture({
      p1Owns: [CAPITAL, A, B],
      wood: 0,
      roads: { [edgeKey(CAPITAL, A)]: 'p1' },
      state: { currentPhase: Phase.DrawAndPlaceTile, roundNumber: 1 },
    });

    for (let i = 0; i < 8; i++) {
      state = advanceToGather(state);
      state = applyAction(state, { type: 'EndTurn', actorId: state.currentPlayerId }); // p1 -> p2
      state = applyAction(state, { type: 'EndTurn', actorId: state.currentPlayerId }); // p2 -> p1
    }

    expect(tileAt(state, A)!.stockpile.Wood).toBe(0);
    expect(playerIn(state, 'p1').resources.Wood).toBe(8);
    // The unconnected neighbor tops out at the cap instead, exactly as before roads existed.
    expect(tileAt(state, B)!.stockpile.Wood).toBe(TILE_STOCKPILE_CAP);
  });

  it('emits no RoadSupplyCollected event when the network is empty', () => {
    const state = networkFixture({ p1Owns: [CAPITAL, A], wood: 0, state: { currentPhase: Phase.DrawAndPlaceTile } });
    const gathered = advanceToGather(state);
    expect(eventsOfType(gathered, 'RoadSupplyCollected')).toHaveLength(0);
    expect(playerIn(gathered, 'p1').resources.Wood).toBe(0);
  });
});

// ── Territory-scaled recruitment ───────────────────────────────────────────────────────────

describe('soldiersPerRoundFor: reinforcements scale with territory', () => {
  it.each([
    [1, 1],
    [2, 1],
    [3, 1],
    [5, 1],
    [6, 2],
    [9, 3],
    [30, 10],
  ])('%i owned tiles -> %i recruits per round', (tiles, expected) => {
    expect(soldiersPerRoundFor(tiles)).toBe(expected);
  });

  it('never returns zero — a Barracks is never literally idle', () => {
    expect(soldiersPerRoundFor(0)).toBe(1);
    for (let t = 0; t <= 40; t++) expect(soldiersPerRoundFor(t)).toBe(Math.max(1, Math.floor(t / 3)));
  });

  /** A p1 owning `tileCount` Plains tiles in a row, with a Barracks holding `startingReserve`
   *  Soldiers on the first of them. */
  function barracksFixture(tileCount: number, startingReserve: number) {
    const coords: HexCoord[] = Array.from({ length: tileCount }, (_, i) => ({ q: i, r: 0 }));
    const p1 = makePlayer({ id: 'p1', capitalTile: coords[0], ownedTiles: coords, resources: { Food: 500 } });
    const p2 = makePlayer({ id: 'p2', capitalTile: P2_CAPITAL, ownedTiles: [P2_CAPITAL] });
    const tiles: Tile[] = coords.map((coord, i) =>
      makeTile({
        coord,
        type: 'Plains',
        ownerId: 'p1',
        ...(i === 0
          ? {
              building: { id: 'barracks', type: 'Barracks' as const, coord, ownerId: 'p1' },
              militiaCount: startingReserve,
            }
          : {}),
      })
    );
    tiles.push(makeTile({ coord: P2_CAPITAL, type: 'Plains', ownerId: 'p2' }));
    return fixtureState([p1, p2], tiles, {
      turnOrder: ['p1', 'p2'],
      currentPlayerId: 'p1',
      currentPhase: Phase.DrawAndPlaceTile,
    });
  }

  it('a Barracks recruits soldiersPerRoundFor(ownedTiles) in one production step', () => {
    const tileCount = 6;
    const state = barracksFixture(tileCount, 0);
    const gathered = advanceToGather(state);
    expect(soldiersPerRoundFor(tileCount)).toBe(2);
    expect(tileAt(gathered, { q: 0, r: 0 })!.militiaCount).toBe(soldiersPerRoundFor(tileCount));
  });

  it('a small holding still recruits the floor of 1', () => {
    const state = barracksFixture(2, 0);
    const gathered = advanceToGather(state);
    expect(tileAt(gathered, { q: 0, r: 0 })!.militiaCount).toBe(1);
  });

  it('a sprawling empire is bounded by BARRACKS_RESERVE_CAP, not by its tile count', () => {
    const tileCount = 30;
    expect(soldiersPerRoundFor(tileCount)).toBeGreaterThan(BARRACKS_RESERVE_CAP);
    const state = barracksFixture(tileCount, 0);
    const gathered = advanceToGather(state);
    expect(tileAt(gathered, { q: 0, r: 0 })!.militiaCount).toBe(BARRACKS_RESERVE_CAP);
  });

  it('a reserve already at the cap does not creep past it', () => {
    const state = barracksFixture(6, BARRACKS_RESERVE_CAP);
    const gathered = advanceToGather(state);
    expect(tileAt(gathered, { q: 0, r: 0 })!.militiaCount).toBe(BARRACKS_RESERVE_CAP);
  });
});
