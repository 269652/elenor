import { describe, expect, it } from 'vitest';
import { applyAction } from '../reducer';
import { garrisonOwnerOf } from '../reducers';
import { resolveArmyVsTerritory } from '../combat';
import { RngStream } from '../rng';
import { tileAt } from '../selectors';
import { SOLDIER_UPKEEP_FOOD_PER_GROUP, SOLDIER_UPKEEP_GROUP_SIZE, TERRITORY_CLAIM_ROUNDS } from '../constants';
import { hexKey, IllegalActionError, Phase } from '../types';
import type { GameState, HexCoord, Player, PlayerId, Tile } from '../types';
import { makePlayer, makeTile } from './testUtils';

/**
 * [DEFAULT — territory rework] Ground changes hands by OCCUPATION, not by conquest.
 *
 * The old model (a Phase-4 'Fight' with combatType 'ArmyVsTerritory', declared from behind an
 * adjacent Barracks, flipping the deed the instant the dice landed) is gone. Everything now runs
 * through one Phase-5 MoveSoldiersAction: troops take a tile by WALKING ONTO it, and the flag only
 * changes at the start of a LATER turn of theirs (Tile.occupationSinceRound + claimHeldTerritory),
 * so a rival always gets a turn in between to march back and contest it.
 *
 * That split — a tile's OCCUPIER and its OWNER are now separate facts — is what these tests are
 * really about. Every assertion about who holds a garrison goes through garrisonOwnerOf rather
 * than reading tile.ownerId, because those two answers legitimately disagree for a whole round.
 */

// ── Fixture ────────────────────────────────────────────────────────────────────────────────

/** A shared border, west to east: p1's Capital, p1's border tile, p2's border tile, p2's Capital.
 *  Consecutive coords are adjacent; P1_CAPITAL and P2_BORDER are not. */
const P1_CAPITAL: HexCoord = { q: 0, r: 0 };
const P1_BORDER: HexCoord = { q: 1, r: 0 };
const P2_BORDER: HexCoord = { q: 2, r: 0 };
const P2_CAPITAL: HexCoord = { q: 3, r: 0 };
/** Placed but unowned — adjacent to both of p1's tiles, adjacent to neither of p2's. */
const NEUTRAL: HexCoord = { q: 1, r: -1 };
/** Adjacent to P1_BORDER but deliberately NEVER placed in the map. */
const OFF_MAP: HexCoord = { q: 1, r: 1 };
/** Placed, owned by p2, and not adjacent to anything else in the fixture. */
const FAR: HexCoord = { q: 6, r: 0 };

interface BorderOptions {
  p1CapitalMilitia?: number;
  p1BorderMilitia?: number;
  p2BorderMilitia?: number;
  p2CapitalMilitia?: number;
  /** Watchtower on P2_BORDER — the §6.3 defender die bonus. */
  p2BorderWatchtower?: boolean;
  state?: Partial<GameState>;
}

/** Hand-built GameState, same pattern as balanceRework.test.ts's fixtureState. */
function fixtureState(players: Player[], tiles: Tile[], overrides: Partial<GameState> = {}): GameState {
  const map: Record<string, Tile> = {};
  for (const t of tiles) map[hexKey(t.coord)] = t;
  return {
    gameId: 'g-territory',
    mode: 'hotseat',
    status: 'active',
    rngSeed: 'territory-seed',
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

/** Both players hold a fat larder by default so per-turn Soldier upkeep never deserts a garrison
 *  mid-test and confounds a count assertion — upkeep gets its own dedicated case below. */
function borderFixture(opts: BorderOptions = {}): GameState {
  const p1 = makePlayer({
    id: 'p1',
    capitalTile: P1_CAPITAL,
    ownedTiles: [P1_CAPITAL, P1_BORDER],
    resources: { Food: 200, Meat: 0 },
  });
  const p2 = makePlayer({
    id: 'p2',
    capitalTile: P2_CAPITAL,
    ownedTiles: [P2_BORDER, P2_CAPITAL, FAR],
    resources: { Food: 200, Meat: 0 },
  });
  const tiles: Tile[] = [
    makeTile({ coord: P1_CAPITAL, type: 'Plains', ownerId: 'p1', militiaCount: opts.p1CapitalMilitia ?? 0 }),
    makeTile({ coord: P1_BORDER, type: 'Plains', ownerId: 'p1', militiaCount: opts.p1BorderMilitia ?? 0 }),
    makeTile({
      coord: P2_BORDER,
      type: 'Plains',
      ownerId: 'p2',
      militiaCount: opts.p2BorderMilitia ?? 0,
      ...(opts.p2BorderWatchtower
        ? { building: { id: 'wt', type: 'Watchtower' as const, coord: P2_BORDER, ownerId: 'p2' } }
        : {}),
    }),
    makeTile({ coord: P2_CAPITAL, type: 'Plains', ownerId: 'p2', militiaCount: opts.p2CapitalMilitia ?? 0 }),
    makeTile({ coord: NEUTRAL, type: 'Forest', ownerId: null }),
    makeTile({ coord: FAR, type: 'Plains', ownerId: 'p2' }),
  ];
  return fixtureState([p1, p2], tiles, { turnOrder: ['p1', 'p2'], currentPlayerId: 'p1', ...opts.state });
}

function playerIn(state: GameState, id: PlayerId): Player {
  return state.players.find((p) => p.id === id)!;
}

function eventsOfType(state: GameState, type: string) {
  return state.eventLog.filter((e) => e.type === type);
}

function ownsTile(player: Player, coord: HexCoord): boolean {
  return player.ownedTiles.some((c) => hexKey(c) === hexKey(coord));
}

/** Ends turns until it is `playerId`'s turn again — always at least one EndTurn, so this is
 *  genuinely "their NEXT turn" even when called while they are the active player. */
function advanceToNextTurnOf(state: GameState, playerId: PlayerId): GameState {
  let s = applyAction(state, { type: 'EndTurn', actorId: state.currentPlayerId });
  for (let guard = 0; s.currentPlayerId !== playerId && guard < 12; guard++) {
    s = applyAction(s, { type: 'EndTurn', actorId: s.currentPlayerId });
  }
  expect(s.currentPlayerId).toBe(playerId);
  return s;
}

/** Advances to `playerId`'s next turn exactly TERRITORY_CLAIM_ROUNDS times in a row — i.e. far
 *  enough that any occupation they're holding is guaranteed to have survived long enough to
 *  settle (claimHeldTerritory requires roundNumber >= occupationSinceRound + TERRITORY_CLAIM_ROUNDS,
 *  and each call to advanceToNextTurnOf that starts from this player's own turn advances the
 *  round counter by exactly 1). */
function advanceClaimWindow(state: GameState, playerId: PlayerId): GameState {
  let s = state;
  for (let i = 0; i < TERRITORY_CLAIM_ROUNDS; i++) s = advanceToNextTurnOf(s, playerId);
  return s;
}

/** Walks the active player from their freshly-started turn (Phase 1) up to Phase 5. */
function toBuildPhase(state: GameState): GameState {
  let s = state;
  for (let guard = 0; s.currentPhase !== Phase.Build && guard < 8; guard++) {
    s = applyAction(s, { type: 'AdvancePhase', actorId: s.currentPlayerId });
  }
  expect(s.currentPhase).toBe(Phase.Build);
  return s;
}

// ── Deterministic §6.3 dice ────────────────────────────────────────────────────────────────
// applyMoveSoldiers builds its RngStream from (rngSeed, rngCursor) and territory combat is the
// first thing that draws from it, so seeding the fixture's cursor pins the outcome exactly.
// Rather than asserting a particular roll, these helpers search for a cursor that produces the
// SHAPE of outcome a test needs and then compare the engine's result against combat.ts's own
// prediction for that same cursor.

const COMBAT_SEED = 'territory-seed';

function outcomeAt(cursor: number, attackers: number, defenders: number, watchtowerTier = 0) {
  return resolveArmyVsTerritory(attackers, defenders, watchtowerTier, new RngStream(COMBAT_SEED, cursor));
}

function findCursor(predicate: (cursor: number) => boolean, label: string): number {
  for (let c = 0; c < 100_000; c++) {
    if (predicate(c)) return c;
  }
  throw new Error(`No rng cursor found for: ${label}`);
}

// ── 1. Reinforcement ───────────────────────────────────────────────────────────────────────

describe('MoveSoldiers: marching onto your OWN tile is a plain reinforcement', () => {
  it('moves the count across, starts no occupation clock, and fights nobody', () => {
    const state = borderFixture({ p1CapitalMilitia: 5, p1BorderMilitia: 1 });
    const after = applyAction(state, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P1_CAPITAL, toCoord: P1_BORDER, count: 3 });

    expect(tileAt(after, P1_CAPITAL)!.militiaCount).toBe(2);
    expect(tileAt(after, P1_BORDER)!.militiaCount).toBe(4);
    expect(garrisonOwnerOf(tileAt(after, P1_BORDER)!)).toBe('p1');
    expect(tileAt(after, P1_BORDER)!.ownerId).toBe('p1');
    // No occupation clock on your own ground — there is nothing to claim.
    expect(tileAt(after, P1_BORDER)!.occupationSinceRound).toBeUndefined();
    expect(eventsOfType(after, 'SoldiersMarched')).toHaveLength(1);
    expect(eventsOfType(after, 'CombatResolved')).toHaveLength(0);
    expect(eventsOfType(after, 'TerritoryOccupied')).toHaveLength(0);
  });

  it('garrisonOwnerOf never reports a phantom claim on a tile that reads 0 soldiers', () => {
    // [territory rework, leave-one-behind] A march can no longer empty its own source tile down
    // to 0 (MIN_SOLDIERS_LEFT_BEHIND), so this used to drive the scenario through a real march;
    // now it's a direct check of the selector's own contract — garrisonOwnerId is only ever
    // meaningful alongside a positive militiaCount, whatever a stale/leftover value says (a tile
    // can genuinely reach 0 via combat losses, e.g. a repulsed attack losing every soldier).
    const state = borderFixture({});
    const phantom = { ...tileAt(state, P1_CAPITAL)!, militiaCount: 0, garrisonOwnerId: 'p1' as const };
    expect(garrisonOwnerOf(phantom)).toBeNull();
  });

  it('reinforcing clears a stale occupation clock left on a tile you have since taken back', () => {
    // A tile you own that still carries occupationSinceRound from an earlier invasion must not
    // keep a live clock once your own troops are the ones standing on it.
    const base = borderFixture({ p1CapitalMilitia: 2 });
    const stale = { ...tileAt(base, P1_BORDER)!, occupationSinceRound: 4 };
    const state: GameState = { ...base, map: { ...base.map, [hexKey(P1_BORDER)]: stale } };
    const after = applyAction(state, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P1_CAPITAL, toCoord: P1_BORDER, count: 1 });
    expect(tileAt(after, P1_BORDER)!.occupationSinceRound).toBeUndefined();
  });
});

// ── 2. Occupying undefended ground ─────────────────────────────────────────────────────────

describe('MoveSoldiers: marching onto UNDEFENDED hostile ground occupies it', () => {
  it('the garrison becomes the attacker\'s and the occupation clock starts — but the deed does not move', () => {
    const state = borderFixture({ p1BorderMilitia: 4 });
    const after = applyAction(state, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P1_BORDER, toCoord: P2_BORDER, count: 3 });
    const taken = tileAt(after, P2_BORDER)!;

    expect(taken.militiaCount).toBe(3);
    expect(garrisonOwnerOf(taken)).toBe('p1');
    expect(taken.occupationSinceRound).toBe(after.roundNumber);
    // The whole point: occupation, not conquest. Ownership has NOT changed yet.
    expect(taken.ownerId).toBe('p2');
    expect(ownsTile(playerIn(after, 'p2'), P2_BORDER)).toBe(true);
    expect(ownsTile(playerIn(after, 'p1'), P2_BORDER)).toBe(false);
    expect(eventsOfType(after, 'TerritoryOccupied')).toHaveLength(1);
    expect(eventsOfType(after, 'CombatResolved')).toHaveLength(0);
  });

  it('unowned neutral ground is occupied the same way (no owner to fight, still a multi-round wait)', () => {
    const state = borderFixture({ p1BorderMilitia: 3 }); // +1 over the moved count: MIN_SOLDIERS_LEFT_BEHIND
    const after = applyAction(state, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P1_BORDER, toCoord: NEUTRAL, count: 2 });
    const taken = tileAt(after, NEUTRAL)!;
    expect(garrisonOwnerOf(taken)).toBe('p1');
    expect(taken.occupationSinceRound).toBe(after.roundNumber);
    expect(taken.ownerId).toBeNull();
    expect(ownsTile(playerIn(after, 'p1'), NEUTRAL)).toBe(false);
  });
});

// ── 3. The claim lands a round LATER ───────────────────────────────────────────────────────

describe('claimHeldTerritory: ownership transfers only on a LATER round', () => {
  it('transfers at the occupier\'s next turn, updating both ownedTiles arrays and emitting TerritoryClaimed', () => {
    const state = borderFixture({ p1BorderMilitia: 4 });
    const occupied = applyAction(state, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P1_BORDER, toCoord: P2_BORDER, count: 3 });
    const roundOfOccupation = occupied.roundNumber;

    const next = advanceClaimWindow(occupied, 'p1');
    expect(next.roundNumber).toBe(roundOfOccupation + TERRITORY_CLAIM_ROUNDS);

    const claimed = tileAt(next, P2_BORDER)!;
    expect(claimed.ownerId).toBe('p1');
    expect(ownsTile(playerIn(next, 'p1'), P2_BORDER)).toBe(true);
    expect(ownsTile(playerIn(next, 'p2'), P2_BORDER)).toBe(false);
    // Clock cleared once settled, so it can't be claimed twice.
    expect(claimed.occupationSinceRound).toBeUndefined();
    expect(garrisonOwnerOf(claimed)).toBe('p1');

    const claims = eventsOfType(next, 'TerritoryClaimed');
    expect(claims).toHaveLength(1);
    expect(claims[0].payload).toMatchObject({ from: 'p2' });
    expect(claims[0].payload.coord).toEqual(P2_BORDER);
  });

  it('claims neutral ground too, recording no previous owner', () => {
    const state = borderFixture({ p1BorderMilitia: 3 }); // +1 over the moved count: MIN_SOLDIERS_LEFT_BEHIND
    const occupied = applyAction(state, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P1_BORDER, toCoord: NEUTRAL, count: 2 });
    const next = advanceClaimWindow(occupied, 'p1');
    expect(tileAt(next, NEUTRAL)!.ownerId).toBe('p1');
    expect(ownsTile(playerIn(next, 'p1'), NEUTRAL)).toBe(true);
    expect(eventsOfType(next, 'TerritoryClaimed')[0].payload).toMatchObject({ from: null });
  });

  it('does NOT transfer while the round number still equals occupationSinceRound', () => {
    // The one-round delay is the entire design: a rival must get a turn to march back before the
    // flag changes. This pins the comparison itself (round <= occupationSinceRound => no claim)
    // by starting p1's turn while the round counter has not yet ticked over. p0 sits ahead of p1
    // in turn order, so ending p0's turn hands play to p1 WITHOUT incrementing the round.
    const p0Capital: HexCoord = { q: -5, r: 5 };
    const p0 = makePlayer({ id: 'p0', capitalTile: p0Capital, ownedTiles: [p0Capital], resources: { Food: 200 } });
    const p1 = makePlayer({ id: 'p1', capitalTile: P1_CAPITAL, ownedTiles: [P1_CAPITAL, P1_BORDER], resources: { Food: 200 } });
    const p2 = makePlayer({ id: 'p2', capitalTile: P2_CAPITAL, ownedTiles: [P2_BORDER, P2_CAPITAL], resources: { Food: 200 } });
    const tiles: Tile[] = [
      makeTile({ coord: p0Capital, type: 'Plains', ownerId: 'p0' }),
      makeTile({ coord: P1_CAPITAL, type: 'Plains', ownerId: 'p1' }),
      makeTile({ coord: P1_BORDER, type: 'Plains', ownerId: 'p1' }),
      // p1's troops are standing on p2's tile, having arrived THIS round.
      makeTile({ coord: P2_BORDER, type: 'Plains', ownerId: 'p2', militiaCount: 3, garrisonOwnerId: 'p1', occupationSinceRound: 5 }),
      makeTile({ coord: P2_CAPITAL, type: 'Plains', ownerId: 'p2' }),
    ];
    const state = fixtureState([p0, p1, p2], tiles, {
      turnOrder: ['p0', 'p1', 'p2'],
      currentPlayerId: 'p0',
      roundNumber: 5,
      currentPhase: Phase.Build,
    });

    // p0 -> p1 within the same round: the claim must not fire.
    const p1SameRound = applyAction(state, { type: 'EndTurn', actorId: 'p0' });
    expect(p1SameRound.currentPlayerId).toBe('p1');
    expect(p1SameRound.roundNumber).toBe(5);
    expect(tileAt(p1SameRound, P2_BORDER)!.ownerId).toBe('p2');
    expect(tileAt(p1SameRound, P2_BORDER)!.occupationSinceRound).toBe(5);
    expect(ownsTile(playerIn(p1SameRound, 'p1'), P2_BORDER)).toBe(false);
    expect(eventsOfType(p1SameRound, 'TerritoryClaimed')).toHaveLength(0);

    // [territory rework: hold time tuned to TERRITORY_CLAIM_ROUNDS = 3] It takes that many more
    // laps before the claim lands, not just one — check every round strictly BEFORE the window
    // closes still shows no claim (this is the actual behaviour the tuned constant buys), then
    // confirm the final lap is the one that settles it.
    let s = p1SameRound;
    for (let i = 1; i < TERRITORY_CLAIM_ROUNDS; i++) {
      s = advanceToNextTurnOf(s, 'p1');
      expect(s.roundNumber, `round after lap ${i}`).toBe(5 + i);
      expect(tileAt(s, P2_BORDER)!.ownerId, `still p2's after lap ${i}`).toBe('p2');
      expect(eventsOfType(s, 'TerritoryClaimed'), `no claim yet after lap ${i}`).toHaveLength(0);
    }
    const settled = advanceToNextTurnOf(s, 'p1');
    expect(settled.roundNumber).toBe(5 + TERRITORY_CLAIM_ROUNDS);
    expect(tileAt(settled, P2_BORDER)!.ownerId).toBe('p1');
    expect(eventsOfType(settled, 'TerritoryClaimed')).toHaveLength(1);
  });

  it('does not transfer at a RIVAL\'s turn start either — only the occupier can settle their own claim', () => {
    const state = borderFixture({ p1BorderMilitia: 4 });
    const occupied = applyAction(state, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P1_BORDER, toCoord: P2_BORDER, count: 3 });
    const p2Turn = applyAction(occupied, { type: 'EndTurn', actorId: 'p1' });
    expect(p2Turn.currentPlayerId).toBe('p2');
    expect(tileAt(p2Turn, P2_BORDER)!.ownerId).toBe('p2');
    expect(eventsOfType(p2Turn, 'TerritoryClaimed')).toHaveLength(0);
  });
});

// ── 4. Combat on contact ───────────────────────────────────────────────────────────────────

describe('MoveSoldiers: marching onto a DEFENDED tile resolves §6.3 combat immediately', () => {
  it('on a win the attacker holds the ground with its survivors and the occupation clock starts', () => {
    const attackers = 6;
    const defenders = 2;
    const cursor = findCursor((c) => outcomeAt(c, attackers, defenders).tileCaptured, 'attacker captures 6v2');
    const expected = outcomeAt(cursor, attackers, defenders);

    // +1 over `attackers` on the source: MIN_SOLDIERS_LEFT_BEHIND. Doesn't touch the combat math
    // below — the reserve stays home and never enters resolveArmyVsTerritory.
    const state = borderFixture({ p1BorderMilitia: attackers + 1, p2BorderMilitia: defenders, state: { rngCursor: cursor } });
    const after = applyAction(state, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P1_BORDER, toCoord: P2_BORDER, count: attackers });
    const contested = tileAt(after, P2_BORDER)!;

    expect(contested.militiaCount).toBe(expected.attackerRemaining);
    expect(garrisonOwnerOf(contested)).toBe('p1');
    expect(contested.occupationSinceRound).toBe(after.roundNumber);
    // Winning the fight buys the ground, not the deed.
    expect(contested.ownerId).toBe('p2');
    expect(ownsTile(playerIn(after, 'p2'), P2_BORDER)).toBe(true);

    const combat = eventsOfType(after, 'CombatResolved');
    expect(combat).toHaveLength(1);
    expect(combat[0].payload).toMatchObject({ combatType: 'ArmyVsTerritory', defenderId: 'p2', tileCaptured: true });
    expect(after.rngCursor).toBeGreaterThan(cursor);
  });

  it('on a loss the survivors fall back to fromCoord and the defender keeps the tile', () => {
    const attackers = 3;
    const defenders = 3;
    const cursor = findCursor((c) => !outcomeAt(c, attackers, defenders).tileCaptured, 'attacker repulsed 3v3');
    const expected = outcomeAt(cursor, attackers, defenders);
    expect(expected.attackerLosses).toBeGreaterThan(0); // a real repulse, not a stalemate of zero

    const garrisonLeftHome = 2;
    const state = borderFixture({
      p1BorderMilitia: attackers + garrisonLeftHome,
      p2BorderMilitia: defenders,
      state: { rngCursor: cursor },
    });
    const after = applyAction(state, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P1_BORDER, toCoord: P2_BORDER, count: attackers });

    const held = tileAt(after, P2_BORDER)!;
    expect(held.militiaCount).toBe(expected.defenderRemaining);
    expect(garrisonOwnerOf(held)).toBe('p2');
    expect(held.ownerId).toBe('p2');
    expect(held.occupationSinceRound).toBeUndefined();

    const home = tileAt(after, P1_BORDER)!;
    expect(home.militiaCount).toBe(garrisonLeftHome + expected.attackerRemaining);
    expect(garrisonOwnerOf(home)).toBe('p1');
    expect(eventsOfType(after, 'CombatResolved')[0].payload).toMatchObject({ tileCaptured: false });
  });

  it('a Watchtower on the defended tile is applied — the same dice that would have taken it no longer do', () => {
    const attackers = 3;
    const defenders = 3;
    const cursor = findCursor(
      (c) => outcomeAt(c, attackers, defenders, 0).tileCaptured && !outcomeAt(c, attackers, defenders, 1).tileCaptured,
      'watchtower flips a capture into a repulse'
    );
    const state = borderFixture({
      p1BorderMilitia: attackers + 1, // +1: MIN_SOLDIERS_LEFT_BEHIND, doesn't touch the dice
      p2BorderMilitia: defenders,
      p2BorderWatchtower: true,
      state: { rngCursor: cursor },
    });
    const after = applyAction(state, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P1_BORDER, toCoord: P2_BORDER, count: attackers });
    expect(garrisonOwnerOf(tileAt(after, P2_BORDER)!)).toBe('p2');
    expect(eventsOfType(after, 'CombatResolved')[0].payload).toMatchObject({ tileCaptured: false });
  });
});

// ── 5. Rejections ──────────────────────────────────────────────────────────────────────────

describe('MoveSoldiers: rejections', () => {
  it('rejects marching soldiers that are not yours (a garrison belonging to someone else)', () => {
    // p1's own tile, but p2's troops are standing on it — ownership of the ground is irrelevant.
    const base = borderFixture({});
    const invaded = { ...tileAt(base, P1_BORDER)!, militiaCount: 4, garrisonOwnerId: 'p2', occupationSinceRound: 5 };
    const state: GameState = { ...base, map: { ...base.map, [hexKey(P1_BORDER)]: invaded } };
    expect(() => applyAction(state, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P1_BORDER, toCoord: P1_CAPITAL, count: 2 })).toThrow(
      IllegalActionError
    );
    expect(() => applyAction(state, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P1_BORDER, toCoord: P1_CAPITAL, count: 2 })).toThrow(
      /not your Soldiers/i
    );
  });

  it('rejects marching from a tile with no soldiers at all', () => {
    const state = borderFixture({ p1BorderMilitia: 0 });
    expect(() => applyAction(state, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P1_BORDER, toCoord: P2_BORDER, count: 1 })).toThrow(
      IllegalActionError
    );
  });

  it('rejects moving more soldiers than are actually present', () => {
    const state = borderFixture({ p1BorderMilitia: 3 });
    expect(() => applyAction(state, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P1_BORDER, toCoord: P2_BORDER, count: 4 })).toThrow(
      /Not enough Soldiers/i
    );
  });

  it('rejects a non-positive count', () => {
    const state = borderFixture({ p1BorderMilitia: 3 });
    expect(() => applyAction(state, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P1_BORDER, toCoord: P2_BORDER, count: 0 })).toThrow(
      /positive/i
    );
  });

  it('rejects a non-adjacent destination — soldiers march one hex at a time', () => {
    const state = borderFixture({ p1CapitalMilitia: 5 });
    expect(() => applyAction(state, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P1_CAPITAL, toCoord: P2_BORDER, count: 2 })).toThrow(
      /adjacent/i
    );
  });

  it('rejects marching off the edge of the map (adjacent, but no tile placed there)', () => {
    const state = borderFixture({ p1BorderMilitia: 3 });
    expect(state.map[hexKey(OFF_MAP)]).toBeUndefined();
    expect(() => applyAction(state, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P1_BORDER, toCoord: OFF_MAP, count: 1 })).toThrow(
      /off the edge of the map/i
    );
  });

  it.each([Phase.Production, Phase.DrawAndPlaceTile, Phase.MoveHero, Phase.Gather, Phase.Fight])(
    'rejects a march outside Phase 5 (phase %i)',
    (phase) => {
      const state = borderFixture({ p1BorderMilitia: 3, state: { currentPhase: phase } });
      expect(() => applyAction(state, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P1_BORDER, toCoord: P2_BORDER, count: 1 })).toThrow(
        IllegalActionError
      );
    }
  );

  it('rejects a march by a player whose turn it is not', () => {
    const state = borderFixture({ p2CapitalMilitia: 3 });
    expect(() => applyAction(state, { type: 'MoveSoldiers', actorId: 'p2', fromCoord: P2_CAPITAL, toCoord: P2_BORDER, count: 1 })).toThrow(
      /not p2's turn/i
    );
  });
});

// ── 6. Free action ─────────────────────────────────────────────────────────────────────────

describe('MoveSoldiers is a FREE action', () => {
  it('does not consume the one-build-per-turn slot', () => {
    const state = borderFixture({ p1CapitalMilitia: 4 });
    const after = applyAction(state, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P1_CAPITAL, toCoord: P1_BORDER, count: 2 });
    expect(after.hasBuiltThisTurn).toBe(false);
  });

  it('can be repeated in a single turn — a whole border can be reshuffled', () => {
    const state = borderFixture({ p1CapitalMilitia: 6 });
    let s = applyAction(state, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P1_CAPITAL, toCoord: P1_BORDER, count: 2 });
    s = applyAction(s, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P1_CAPITAL, toCoord: P1_BORDER, count: 2 });
    s = applyAction(s, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P1_BORDER, toCoord: P1_CAPITAL, count: 1 });
    expect(tileAt(s, P1_BORDER)!.militiaCount).toBe(3);
    expect(tileAt(s, P1_CAPITAL)!.militiaCount).toBe(3);
    expect(s.hasBuiltThisTurn).toBe(false);
  });

  it('still leaves the turn\'s Build action available afterwards', () => {
    const state = borderFixture({ p1CapitalMilitia: 4 });
    const marched = applyAction(state, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P1_CAPITAL, toCoord: P1_BORDER, count: 2 });
    const rich = {
      ...marched,
      players: marched.players.map((p) => (p.id === 'p1' ? { ...p, resources: { ...p.resources, Wood: 9, Stone: 9, Ore: 9, Gold: 9 } } : p)),
    };
    const built = applyAction(rich, { type: 'Build', actorId: 'p1', buildingType: 'Watchtower', coord: P1_BORDER });
    expect(tileAt(built, P1_BORDER)!.building?.type).toBe('Watchtower');
    expect(built.hasBuiltThisTurn).toBe(true);
  });
});

// ── 7. Advancing from captured ground ──────────────────────────────────────────────────────

describe('MoveSoldiers: fromCoord legality follows garrisonOwnerOf, not tile.ownerId', () => {
  it('an invader can keep advancing out of ground it occupies but does not own', () => {
    const state = borderFixture({ p1BorderMilitia: 6 }); // +1 over the step-1 move: MIN_SOLDIERS_LEFT_BEHIND
    // Step 1: take p2's border tile (undefended).
    const step1 = applyAction(state, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P1_BORDER, toCoord: P2_BORDER, count: 5 });
    expect(tileAt(step1, P2_BORDER)!.ownerId).toBe('p2'); // still p2's on paper
    expect(garrisonOwnerOf(tileAt(step1, P2_BORDER)!)).toBe('p1');

    // Step 2: push on from there onto p2's Capital, in the same Phase 5.
    const step2 = applyAction(step1, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P2_BORDER, toCoord: P2_CAPITAL, count: 3 });
    expect(tileAt(step2, P2_BORDER)!.militiaCount).toBe(2);
    expect(garrisonOwnerOf(tileAt(step2, P2_BORDER)!)).toBe('p1');
    expect(tileAt(step2, P2_BORDER)!.occupationSinceRound).toBe(step2.roundNumber); // clock keeps running
    expect(tileAt(step2, P2_CAPITAL)!.militiaCount).toBe(3);
    expect(garrisonOwnerOf(tileAt(step2, P2_CAPITAL)!)).toBe('p1');
    expect(tileAt(step2, P2_CAPITAL)!.occupationSinceRound).toBe(step2.roundNumber);
  });
});

// ── 8. Capital capture ─────────────────────────────────────────────────────────────────────

describe('Claiming a Capital eliminates its owner', () => {
  it('sets isEliminated and emits PlayerEliminated when the claim settles', () => {
    const state = borderFixture({ p1BorderMilitia: 7 }); // +1 over the step-1 move: MIN_SOLDIERS_LEFT_BEHIND
    // March onto p2's border tile, then straight on to their (undefended) Capital.
    let s = applyAction(state, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P1_BORDER, toCoord: P2_BORDER, count: 6 });
    s = applyAction(s, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P2_BORDER, toCoord: P2_CAPITAL, count: 4 });
    expect(playerIn(s, 'p2').isEliminated).toBe(false); // not yet — the claim hasn't landed

    const next = advanceClaimWindow(s, 'p1');
    expect(tileAt(next, P2_CAPITAL)!.ownerId).toBe('p1');
    expect(playerIn(next, 'p2').isEliminated).toBe(true);
    const eliminated = eventsOfType(next, 'PlayerEliminated');
    expect(eliminated).toHaveLength(1);
    expect(eliminated[0].payload).toMatchObject({ playerId: 'p2' });
    expect(ownsTile(playerIn(next, 'p2'), P2_CAPITAL)).toBe(false);
  });

  it('does not eliminate anyone while the Capital is merely occupied', () => {
    const state = borderFixture({ p1BorderMilitia: 7 }); // +1 over the step-1 move: MIN_SOLDIERS_LEFT_BEHIND
    let s = applyAction(state, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P1_BORDER, toCoord: P2_BORDER, count: 6 });
    s = applyAction(s, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P2_BORDER, toCoord: P2_CAPITAL, count: 4 });
    // p2 still gets a full turn of their own with their Capital under occupation.
    const p2Turn = applyAction(s, { type: 'EndTurn', actorId: 'p1' });
    expect(playerIn(p2Turn, 'p2').isEliminated).toBe(false);
    expect(eventsOfType(p2Turn, 'PlayerEliminated')).toHaveLength(0);
    expect(tileAt(p2Turn, P2_CAPITAL)!.ownerId).toBe('p2');
  });

  // ── Capital Conquest — instant win [DEFAULT — balance rework pass 4, new] ─────────────────
  describe('Capital Conquest — claiming a rival Capital wins the whole game immediately', () => {
    it('sets winnerId/winCondition/status the instant the claim settles, not merely eliminating', () => {
      const state = borderFixture({ p1BorderMilitia: 7 });
      let s = applyAction(state, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P1_BORDER, toCoord: P2_BORDER, count: 6 });
      s = applyAction(s, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P2_BORDER, toCoord: P2_CAPITAL, count: 4 });
      expect(s.winnerId).toBeNull(); // not yet — the claim hasn't landed

      const next = advanceClaimWindow(s, 'p1');
      expect(next.winnerId).toBe('p1');
      expect(next.winCondition).toBe('CapitalConquest');
      expect(next.status).toBe('finished');
      const ended = eventsOfType(next, 'GameEnded');
      expect(ended).toHaveLength(1);
      expect(ended[0].payload).toMatchObject({ winnerId: 'p1', winCondition: 'CapitalConquest' });
    });

    it('is exempt from WIN_MIN_ROUND — fires however early the claim can genuinely settle', () => {
      // TERRITORY_CLAIM_ROUNDS itself (3) already puts the settle round well under WIN_MIN_ROUND
      // (12) starting from round 5 — no special-casing needed to prove the exemption; if this
      // were gated the same way VP/Domination/HeroLevelRace are, it would NOT have fired yet.
      const state = borderFixture({ p1BorderMilitia: 7, state: { roundNumber: 2 } });
      let s = applyAction(state, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P1_BORDER, toCoord: P2_BORDER, count: 6 });
      s = applyAction(s, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P2_BORDER, toCoord: P2_CAPITAL, count: 4 });
      const next = advanceClaimWindow(s, 'p1');
      expect(next.roundNumber).toBeLessThan(12);
      expect(next.winnerId).toBe('p1');
      expect(next.winCondition).toBe('CapitalConquest');
    });

    it('once won, no further action is legal — the game has genuinely ended', () => {
      const state = borderFixture({ p1BorderMilitia: 7 });
      let s = applyAction(state, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P1_BORDER, toCoord: P2_BORDER, count: 6 });
      s = applyAction(s, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P2_BORDER, toCoord: P2_CAPITAL, count: 4 });
      const next = advanceClaimWindow(s, 'p1');
      expect(() => applyAction(next, { type: 'AdvancePhase', actorId: next.currentPlayerId })).toThrow(IllegalActionError);
    });
  });
});

// ── 9. Upkeep abroad ───────────────────────────────────────────────────────────────────────

describe('Soldier upkeep is charged on troops standing on FOREIGN ground', () => {
  /** p1's ONLY soldiers are parked on a tile p2 owns, arriving this round so the claim can't fire
   *  and turn them into a domestic garrison before the bill is calculated. 'first' sits ahead of
   *  p1 in turn order, so ending its turn starts p1's turn without ticking the round over. */
  function invasionFixture(militia: number, food: number) {
    const firstCapital: HexCoord = { q: -5, r: 5 };
    const first = makePlayer({ id: 'first', capitalTile: firstCapital, ownedTiles: [firstCapital], resources: { Food: 50 } });
    const p1 = makePlayer({ id: 'p1', capitalTile: P1_CAPITAL, ownedTiles: [P1_CAPITAL], resources: { Food: food, Meat: 0 } });
    const p2 = makePlayer({ id: 'p2', capitalTile: P2_CAPITAL, ownedTiles: [P2_BORDER, P2_CAPITAL], resources: { Food: 50, Meat: 0 } });
    const tiles: Tile[] = [
      makeTile({ coord: firstCapital, type: 'Plains', ownerId: 'first' }),
      makeTile({ coord: P1_CAPITAL, type: 'Plains', ownerId: 'p1', militiaCount: 0 }),
      makeTile({ coord: P2_BORDER, type: 'Plains', ownerId: 'p2', militiaCount: militia, garrisonOwnerId: 'p1', occupationSinceRound: 5 }),
      makeTile({ coord: P2_CAPITAL, type: 'Plains', ownerId: 'p2', militiaCount: 0 }),
    ];
    return fixtureState([first, p1, p2], tiles, {
      turnOrder: ['first', 'p1', 'p2'],
      currentPlayerId: 'first',
      roundNumber: 5,
      currentPhase: Phase.Build,
    });
  }

  it('bills the invader for an army that owns no ground under its feet', () => {
    const militia = 5;
    const bill = Math.ceil(militia / SOLDIER_UPKEEP_GROUP_SIZE) * SOLDIER_UPKEEP_FOOD_PER_GROUP;
    const state = invasionFixture(militia, 10);

    const p1Turn = applyAction(state, { type: 'EndTurn', actorId: 'first' });
    expect(p1Turn.currentPlayerId).toBe('p1');
    // The tile is still p2's — an invasion force is not rent-free just because it's abroad.
    expect(tileAt(p1Turn, P2_BORDER)!.ownerId).toBe('p2');
    expect(playerIn(p1Turn, 'p1').resources.Food).toBe(10 - bill);
    expect(tileAt(p1Turn, P2_BORDER)!.militiaCount).toBe(militia); // paid in full, nobody deserts
    const paid = eventsOfType(p1Turn, 'SoldierUpkeepPaid');
    expect(paid).toHaveLength(1);
    expect(paid[0].payload).toMatchObject({ totalSoldiers: militia });
    expect(paid[0].actorId).toBe('p1');
  });

  it('does not bill the tile\'s OWNER for someone else\'s garrison sitting on it', () => {
    const state = invasionFixture(5, 10);
    let s = applyAction(state, { type: 'EndTurn', actorId: 'first' }); // p1's turn — p1 pays
    s = applyAction(s, { type: 'EndTurn', actorId: 'p1' }); // p2's turn — p2 must NOT pay
    expect(s.currentPlayerId).toBe('p2');
    expect(playerIn(s, 'p2').resources.Food).toBe(50);
    expect(s.eventLog.filter((e) => e.type === 'SoldierUpkeepPaid' && e.actorId === 'p2')).toHaveLength(0);
  });

  it('starves an unaffordable invasion force into desertion, abroad just like at home', () => {
    const state = invasionFixture(6, 0); // bill = 4 food-equivalent, wallet empty
    const p1Turn = applyAction(state, { type: 'EndTurn', actorId: 'first' });
    expect(tileAt(p1Turn, P2_BORDER)!.militiaCount).toBe(0);
    expect(eventsOfType(p1Turn, 'SoldiersDeserted')).toHaveLength(1);
  });
});

// ── 10. Retaking contested ground before the claim lands ───────────────────────────────────

describe('A contested tile can be RETAKEN before the claim lands', () => {
  it('the rival marches back in, beats the occupier, and ownership never transfers', () => {
    const invaders = 3;
    const counterAttackers = 6;
    // p2's counter-attack must actually succeed; the occupation march itself draws no dice, so
    // the fixture cursor is still untouched when the counter-attack resolves.
    const cursor = findCursor((c) => outcomeAt(c, counterAttackers, invaders).tileCaptured, 'counter-attack succeeds 6v3');
    const expected = outcomeAt(cursor, counterAttackers, invaders);

    // Both +1 over their moved counts: MIN_SOLDIERS_LEFT_BEHIND, on each side of the fight.
    const state = borderFixture({
      p1BorderMilitia: invaders + 1,
      p2CapitalMilitia: counterAttackers + 1,
      state: { rngCursor: cursor },
    });

    // Round 5, p1's Phase 5: take p2's undefended border tile.
    const occupied = applyAction(state, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P1_BORDER, toCoord: P2_BORDER, count: invaders });
    expect(garrisonOwnerOf(tileAt(occupied, P2_BORDER)!)).toBe('p1');
    expect(occupied.rngCursor).toBe(cursor); // an uncontested march spends no dice

    // Still round 5, p2's turn: march back in from the Capital and throw them out.
    const p2Turn = toBuildPhase(applyAction(occupied, { type: 'EndTurn', actorId: 'p1' }));
    expect(p2Turn.roundNumber).toBe(5);
    const retaken = applyAction(p2Turn, {
      type: 'MoveSoldiers',
      actorId: 'p2',
      fromCoord: P2_CAPITAL,
      toCoord: P2_BORDER,
      count: counterAttackers,
    });

    const tile = tileAt(retaken, P2_BORDER)!;
    expect(garrisonOwnerOf(tile)).toBe('p2');
    expect(tile.militiaCount).toBe(expected.attackerRemaining);
    expect(tile.ownerId).toBe('p2');

    // And when p1's turn finally comes round again, there is nothing left to claim.
    const p1Next = advanceToNextTurnOf(retaken, 'p1');
    expect(p1Next.roundNumber).toBe(6);
    expect(tileAt(p1Next, P2_BORDER)!.ownerId).toBe('p2');
    expect(ownsTile(playerIn(p1Next, 'p1'), P2_BORDER)).toBe(false);
    expect(ownsTile(playerIn(p1Next, 'p2'), P2_BORDER)).toBe(true);
    expect(eventsOfType(p1Next, 'TerritoryClaimed')).toHaveLength(0);
  });

  it('a failed counter-attack leaves the occupier in place and the claim still lands', () => {
    const invaders = 6;
    const counterAttackers = 2;
    const cursor = findCursor((c) => !outcomeAt(c, counterAttackers, invaders).tileCaptured, 'counter-attack repulsed 2v6');

    // Both +1 over their moved counts: MIN_SOLDIERS_LEFT_BEHIND.
    const state = borderFixture({
      p1BorderMilitia: invaders + 1,
      p2CapitalMilitia: counterAttackers + 1,
      state: { rngCursor: cursor },
    });
    const occupied = applyAction(state, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P1_BORDER, toCoord: P2_BORDER, count: invaders });
    const p2Turn = toBuildPhase(applyAction(occupied, { type: 'EndTurn', actorId: 'p1' }));
    const repulsed = applyAction(p2Turn, {
      type: 'MoveSoldiers',
      actorId: 'p2',
      fromCoord: P2_CAPITAL,
      toCoord: P2_BORDER,
      count: counterAttackers,
    });
    expect(garrisonOwnerOf(tileAt(repulsed, P2_BORDER)!)).toBe('p1');

    const p1Next = advanceClaimWindow(repulsed, 'p1');
    expect(tileAt(p1Next, P2_BORDER)!.ownerId).toBe('p1');
    expect(ownsTile(playerIn(p1Next, 'p1'), P2_BORDER)).toBe(true);
  });
});

// ── Known engine bugs ──────────────────────────────────────────────────────────────────────

/**
 * SKIPPED ON PURPOSE — these are reproductions of real defects in engine/reducers.ts, not tests of
 * intended behaviour, and this task does not own that file. Each one asserts what SHOULD happen,
 * so removing the `.skip` is the acceptance check once the engine is fixed.
 *
 * Root cause, one line: applyMoveSoldiers/resolveSoldierUpkeep were taught that a tile's OCCUPIER
 * and its OWNER are separate facts (garrisonOwnerOf), but the three OTHER writers of
 * Tile.militiaCount were not — they still read and write the garrison as if it always belonged to
 * tile.ownerId. Every case below is that same assumption, verified against the engine as of this
 * commit (each currently produces the "actual" value quoted in its comment).
 */
describe('Occupier-vs-owner: every writer of militiaCount respects garrisonOwnerOf (regression)', () => {
  /** p1 owns both tiles; a Barracks sits on the Capital; P1_BORDER is occupied by p2's troops. */
  function occupiedHomeFixture(barracksReserve: number, invaders: number, barracksInvaded = false) {
    const p1 = makePlayer({ id: 'p1', capitalTile: P1_CAPITAL, ownedTiles: [P1_CAPITAL, P1_BORDER], resources: { Food: 200 } });
    const p2 = makePlayer({ id: 'p2', capitalTile: P2_CAPITAL, ownedTiles: [P2_CAPITAL], resources: { Food: 200 } });
    const tiles: Tile[] = [
      makeTile({
        coord: P1_CAPITAL,
        type: 'Plains',
        ownerId: 'p1',
        building: { id: 'barracks', type: 'Barracks' as const, coord: P1_CAPITAL, ownerId: 'p1' },
        militiaCount: barracksInvaded ? invaders : barracksReserve,
        ...(barracksInvaded ? { garrisonOwnerId: 'p2', occupationSinceRound: 5 } : {}),
      }),
      makeTile({
        coord: P1_BORDER,
        type: 'Plains',
        ownerId: 'p1',
        militiaCount: barracksInvaded ? 0 : invaders,
        ...(barracksInvaded ? {} : { garrisonOwnerId: 'p2', occupationSinceRound: 5 }),
      }),
      makeTile({ coord: P2_CAPITAL, type: 'Plains', ownerId: 'p2' }),
    ];
    return fixtureState([p1, p2], tiles, { turnOrder: ['p1', 'p2'], currentPlayerId: 'p1' });
  }

  it('DeploySoldiers must not hand reinforcements to an enemy occupying your tile', () => {
    // ACTUAL: the destination's militiaCount grows to 6 while garrisonOwnerId stays 'p2' — p1's
    // four Soldiers are absorbed into the invading army (and billed to p2's upkeep, not p1's).
    // applyDeploySoldiers only checks toTile.ownerId; it needs a garrisonOwnerOf check too.
    const state = occupiedHomeFixture(5, 2);
    expect(() =>
      applyAction(state, { type: 'DeploySoldiers', actorId: 'p1', fromCoord: P1_CAPITAL, toCoord: P1_BORDER, count: 4 })
    ).toThrow(IllegalActionError);
  });

  it('DeploySoldiers must not let you march an ENEMY garrison out of your own Barracks tile', () => {
    // ACTUAL: p1 "deploys" p2's six occupying Soldiers off the Barracks tile and onto another of
    // p1's tiles, where they become p1's — an invading army captured wholesale, for free.
    // applyDeploySoldiers checks fromTile.ownerId where it should check garrisonOwnerOf(fromTile).
    const state = occupiedHomeFixture(0, 6, true);
    expect(() =>
      applyAction(state, { type: 'DeploySoldiers', actorId: 'p1', fromCoord: P1_CAPITAL, toCoord: P1_BORDER, count: 6 })
    ).toThrow(IllegalActionError);
  });

  it('a Barracks under enemy occupation must not recruit for the occupier', () => {
    // ACTUAL: accumulateTileProduction walks p1's ownedTiles, finds the Barracks, and adds this
    // round's recruits straight onto the enemy stack standing on it (2 -> 3, still garrisoned by
    // p2). The same loop's `currentArmy` throttle also counts enemy garrisons on owned tiles as
    // p1's while ignoring p1's own troops abroad, so it can disagree with resolveSoldierUpkeep.
    const state = { ...occupiedHomeFixture(0, 2, true), currentPhase: Phase.DrawAndPlaceTile };
    let s = applyAction(state, { type: 'AdvancePhase', actorId: 'p1' }); // -> MoveHero
    s = applyAction(s, { type: 'AdvancePhase', actorId: 'p1' }); // -> Gather (production fires)
    const barracks = tileAt(s, P1_CAPITAL)!;
    expect(barracks.militiaCount).toBe(2); // the occupier's stack is untouched
    expect(garrisonOwnerOf(barracks)).toBe('p2');
  });

  it('building a Barracks must not delete an enemy army standing on the tile', () => {
    // ACTUAL: applyBuild's `if (buildingType === 'Barracks') tile.militiaCount = 0` wipes the five
    // occupying Soldiers — a 5-Wood/2-Ore building doubles as a free army-delete on your own soil.
    const base = occupiedHomeFixture(0, 5);
    const state: GameState = {
      ...base,
      players: base.players.map((p) => (p.id === 'p1' ? { ...p, resources: { ...p.resources, Wood: 9, Ore: 9, Food: 200 } } : p)),
    };
    const after = applyAction(state, { type: 'Build', actorId: 'p1', buildingType: 'Barracks', coord: P1_BORDER });
    expect(tileAt(after, P1_BORDER)!.militiaCount).toBe(5);
    expect(garrisonOwnerOf(tileAt(after, P1_BORDER)!)).toBe('p2');
  });
});
