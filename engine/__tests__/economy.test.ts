import { describe, expect, it } from 'vitest';
import { applyAction } from '../reducer';
import { createGame } from '../setup';
import { carryCapacityFor, tileAt, totalCarried } from '../selectors';
import { hexKey, hexNeighbors } from '../hex';
import { TILE_STOCKPILE_CAP } from '../constants';
import { Phase, IllegalActionError, RESOURCE_TYPES } from '../types';

const PLAYERS = [
  { id: 'p1', name: 'Alice', color: '#f00' },
  { id: 'p2', name: 'Bob', color: '#0f0' },
];

/** Advances the current player straight to Phase 3 (Gather) without drawing/placing/moving,
 *  so tests can inspect the tile-production-accumulation step in isolation. */
function advanceToGather(state: ReturnType<typeof createGame>) {
  let s = state;
  const actorId = s.currentPlayerId;
  expect(s.currentPhase).toBe(Phase.DrawAndPlaceTile);
  s = applyAction(s, { type: 'AdvancePhase', actorId }); // -> MoveHero
  s = applyAction(s, { type: 'AdvancePhase', actorId }); // -> Gather (accumulation fires here)
  expect(s.currentPhase).toBe(Phase.Gather);
  return s;
}

/** Creates a game and draws the first player's Phase-1 tile, retrying with a different seed
 *  if the draw is a River — River is legitimately impassable without a Dock (§4.2), and tests
 *  that want to walk the hero onto the freshly-placed tile need a walkable draw. */
function createGameWithWalkableFirstDraw(gameId: string, seedPrefix: string) {
  for (let i = 0; i < 30; i++) {
    let state = createGame(gameId, PLAYERS, `${seedPrefix}-${i}`, 'hotseat');
    const actorId = state.currentPlayerId;
    state = applyAction(state, { type: 'DrawTile', actorId });
    if (state.pendingTileDraw !== 'River') return { state, actorId };
  }
  throw new Error(`Could not find a walkable first draw for seed prefix ${seedPrefix} after 30 attempts`);
}

describe('Resource economy: tile production accumulates at Phase 3 entry, not Phase 0', () => {
  it('the Capital tile stockpile is untouched right after game creation (Phase 0/1)', () => {
    const state = createGame('g1', PLAYERS, 'economy-seed-1', 'hotseat');
    const p1 = state.players.find((p) => p.id === state.currentPlayerId)!;
    const capitalTile = tileAt(state, p1.capitalTile)!;
    expect(capitalTile.stockpile.Food).toBe(0);
  });

  it('the Capital tile (Plains -> Food) accumulates on entering Phase 3', () => {
    const state = createGame('g2', PLAYERS, 'economy-seed-2', 'hotseat');
    const p1id = state.currentPlayerId;
    const afterGather = advanceToGather(state);
    const p1after = afterGather.players.find((p) => p.id === p1id)!;
    const capitalTile = tileAt(afterGather, p1after.capitalTile)!;
    // At least the base 1 Food; Farmer class adds its baseline on top of that.
    expect(capitalTile.stockpile.Food).toBeGreaterThanOrEqual(1);
  });

  it('production never exceeds TILE_STOCKPILE_CAP even across many rounds', () => {
    let state = createGame('g3', PLAYERS, 'economy-seed-3', 'hotseat');
    // Cycle both players' turns repeatedly via EndTurn (skips drawing/placing/gathering —
    // production still accumulates every time Phase 3 is entered).
    for (let i = 0; i < 40; i++) {
      state = advanceToGather(state);
      state = applyAction(state, { type: 'EndTurn', actorId: state.currentPlayerId });
    }
    for (const tile of Object.values(state.map)) {
      // Asserted against the constant, not a copied literal — the cap was retuned 10 -> 5 in
      // the balance rework and a hardcoded number here silently stopped testing anything.
      for (const r of RESOURCE_TYPES) {
        expect(tile.stockpile[r]).toBeLessThanOrEqual(TILE_STOCKPILE_CAP);
      }
    }
  });
});

describe('Resource economy: collecting is bounded by hero carry capacity', () => {
  it('CollectResources takes at most what fits, leaving the rest on the tile', () => {
    let state = createGame('g4', PLAYERS, 'economy-seed-4', 'hotseat');
    // Fast-forward many rounds so the Capital's stockpile is sitting at TILE_STOCKPILE_CAP.
    for (let i = 0; i < 15; i++) {
      state = advanceToGather(state);
      state = applyAction(state, { type: 'EndTurn', actorId: state.currentPlayerId });
    }
    state = advanceToGather(state);
    const player = state.players.find((p) => p.id === state.currentPlayerId)!;
    const capacity = carryCapacityFor(player.hero);

    // [DEFAULT — balance rework] TILE_STOCKPILE_CAP dropped 10 -> 5, which is exactly a level-1
    // hero's carry capacity (base 4 + level 1), so a SINGLE-resource tile can no longer hold
    // more than one hero-load — that's the stated intent of the retune, not a bug. Overflow now
    // requires a tile stockpiling more than one resource type, which is what a real Cow
    // Stable/Windmill/Hunting Lodge tile looks like in play; seed a second type here so this
    // test still exercises the carry cap rather than trivially fitting everything.
    const capitalKey = hexKey(player.capitalTile);
    const seeded = { ...state.map[capitalKey], stockpile: { ...state.map[capitalKey].stockpile, Gold: TILE_STOCKPILE_CAP } };
    state = { ...state, map: { ...state.map, [capitalKey]: seeded } };

    const before = tileAt(state, player.capitalTile)!.stockpile;
    const totalBefore = RESOURCE_TYPES.reduce((sum, r) => sum + before[r], 0);
    expect(totalBefore).toBeGreaterThan(capacity); // otherwise the test doesn't exercise the cap

    state = applyAction(state, { type: 'Gather', actorId: state.currentPlayerId, coord: player.capitalTile, gatherKind: 'CollectResources' });
    const after = state.players.find((p) => p.id === state.currentPlayerId)!;
    expect(totalCarried(after.hero)).toBe(capacity);
    // Whatever didn't fit stays put — nothing is destroyed in the handoff.
    const remaining = tileAt(state, player.capitalTile)!.stockpile;
    const totalRemaining = RESOURCE_TYPES.reduce((sum, r) => sum + remaining[r], 0);
    expect(totalRemaining).toBe(totalBefore - capacity);
    for (const r of RESOURCE_TYPES) expect(remaining[r]).toBeGreaterThanOrEqual(0);
  });

  it('rejects Gather actions when the hero is already at full capacity', () => {
    let state = createGame('g5', PLAYERS, 'economy-seed-5', 'hotseat');
    for (let i = 0; i < 15; i++) {
      state = advanceToGather(state);
      state = applyAction(state, { type: 'EndTurn', actorId: state.currentPlayerId });
    }
    state = advanceToGather(state);
    const player = state.players.find((p) => p.id === state.currentPlayerId)!;
    state = applyAction(state, { type: 'Gather', actorId: state.currentPlayerId, coord: player.capitalTile, gatherKind: 'CollectResources' });
    expect(() =>
      applyAction(state, { type: 'Gather', actorId: state.currentPlayerId, coord: player.capitalTile, gatherKind: 'CollectResources' })
    ).toThrow(IllegalActionError);
  });
});

describe('Resource economy: spend-local vs deposit-at-Capital', () => {
  it('Build on the tile the hero is standing on can spend carried resources directly', () => {
    let state = createGame('g6', PLAYERS, 'economy-seed-6', 'hotseat');
    for (let i = 0; i < 15; i++) {
      state = advanceToGather(state);
      state = applyAction(state, { type: 'EndTurn', actorId: state.currentPlayerId });
    }
    state = advanceToGather(state);
    const actorId = state.currentPlayerId;
    let player = state.players.find((p) => p.id === actorId)!;
    state = applyAction(state, { type: 'Gather', actorId, coord: player.capitalTile, gatherKind: 'CollectResources' });
    player = state.players.find((p) => p.id === actorId)!;
    const walletFoodBefore = player.resources.Food;
    const carriedFoodBefore = player.hero.carriedResources.Food;
    expect(carriedFoodBefore).toBeGreaterThan(0);

    // STARTING_RESOURCES is now all zeros (balance rework) and this player's Capital is
    // Plains, so they never gather any Wood or Stone — give them enough to afford the Town's
    // tier-2 upgrade cost without touching the Food assertions below, which are the actual
    // point of this test.
    state = {
      ...state,
      players: state.players.map((p) => (p.id === actorId ? { ...p, resources: { ...p.resources, Wood: 5, Stone: 5 } } : p)),
    };

    // Advance to Fight then Build. The Capital tile always carries a Town from turn 1
    // (territory rework), so — unlike an ordinary empty tile — the only Build-phase action
    // available there is upgrading it, not constructing something new on top of it. That's a
    // fine substitute for exercising "carried resources pay first": tier 2 costs Food among
    // other things, same as Farm did before this test needed rewriting. The Town's tiers run
    // through their own bespoke path (buildingType 'Capital', CAPITAL_TIERS) rather than the
    // generic UpgradeBuildingAction — see engine/reducers.ts's applyBuild Capital branch.
    state = applyAction(state, { type: 'AdvancePhase', actorId }); // -> Fight
    state = applyAction(state, { type: 'AdvancePhase', actorId }); // -> Build
    state = applyAction(state, { type: 'Build', actorId, buildingType: 'Capital', coord: player.capitalTile });

    const after = state.players.find((p) => p.id === actorId)!;
    // Tier 2 costs 3 Food (+ Wood + Stone from the wallet). Wallet Food must be untouched;
    // carried Food must have paid it.
    expect(after.resources.Food).toBe(walletFoodBefore);
    expect(after.hero.carriedResources.Food).toBeLessThan(carriedFoodBefore);
    expect(after.capitalTier).toBe(2);
  });

  it('DepositResources requires the hero to be at the Capital, then moves carried -> wallet', () => {
    let state = createGame('g7', PLAYERS, 'economy-seed-7', 'hotseat');
    for (let i = 0; i < 15; i++) {
      state = advanceToGather(state);
      state = applyAction(state, { type: 'EndTurn', actorId: state.currentPlayerId });
    }
    state = advanceToGather(state);
    const actorId = state.currentPlayerId;
    let player = state.players.find((p) => p.id === actorId)!;
    state = applyAction(state, { type: 'Gather', actorId, coord: player.capitalTile, gatherKind: 'CollectResources' });
    player = state.players.find((p) => p.id === actorId)!;
    const carriedBefore = totalCarried(player.hero);
    expect(carriedBefore).toBeGreaterThan(0);
    const walletFoodBefore = player.resources.Food;

    state = applyAction(state, { type: 'DepositResources', actorId });
    const after = state.players.find((p) => p.id === actorId)!;
    expect(totalCarried(after.hero)).toBe(0);
    expect(after.resources.Food).toBeGreaterThanOrEqual(walletFoodBefore);
  });

  it('rejects DepositResources once the hero has moved off the Capital', () => {
    const { state: drawn, actorId } = createGameWithWalkableFirstDraw('g8', 'economy-seed-8');
    const player = drawn.players.find((p) => p.id === actorId)!;

    // Place the drawn tile adjacent to the Capital, then walk the hero onto it (one MoveHero
    // action — a hero may only move once per turn, see hasMovedThisTurn).
    const placeCoord = hexNeighbors(player.capitalTile)[0];
    let state = applyAction(drawn, { type: 'PlaceTile', actorId, tileType: drawn.pendingTileDraw!, coord: placeCoord });
    state = applyAction(state, { type: 'AdvancePhase', actorId }); // -> MoveHero
    state = applyAction(state, { type: 'MoveHero', actorId, path: [placeCoord] });

    const moved = state.players.find((p) => p.id === actorId)!;
    expect(moved.hero.position).toEqual(placeCoord);
    expect(() => applyAction(state, { type: 'DepositResources', actorId })).toThrow(IllegalActionError);
  });

  it('rejects a second MoveHero action in the same turn (movement budget can\'t be stacked)', () => {
    const { state: drawn, actorId } = createGameWithWalkableFirstDraw('g8b', 'economy-seed-8b');
    const player = drawn.players.find((p) => p.id === actorId)!;
    const placeCoord = hexNeighbors(player.capitalTile)[0];
    let state = applyAction(drawn, { type: 'PlaceTile', actorId, tileType: drawn.pendingTileDraw!, coord: placeCoord });
    state = applyAction(state, { type: 'AdvancePhase', actorId }); // -> MoveHero
    state = applyAction(state, { type: 'MoveHero', actorId, path: [placeCoord] });
    expect(() => applyAction(state, { type: 'MoveHero', actorId, path: [player.capitalTile] })).toThrow(IllegalActionError);
  });
});

describe('carryCapacityFor', () => {
  it('is base 4 + hero level', () => {
    const state = createGame('g9', PLAYERS, 'capacity-seed', 'hotseat');
    const player = state.players.find((p) => p.id === state.currentPlayerId)!;
    expect(carryCapacityFor(player.hero)).toBe(4 + player.hero.level);
  });
});
