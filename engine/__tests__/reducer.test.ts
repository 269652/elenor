import { describe, expect, it } from 'vitest';
import { applyAction } from '../reducer';
import { createGame } from '../setup';
import { hexNeighbors } from '../hex';
import { IllegalActionError, Phase } from '../types';

const PLAYERS = [
  { id: 'p1', name: 'Alice', color: '#f00' },
  { id: 'p2', name: 'Bob', color: '#0f0' },
];

describe('reducer integration — a full turn through all six phases', () => {
  it('walks Phase 1 -> 5 for player 1, then hands the turn to player 2 with Phase 0 auto-resolved', () => {
    let state = createGame('g1', PLAYERS, 'turn-flow-seed', 'hotseat');
    expect(state.currentPhase).toBe(Phase.DrawAndPlaceTile);
    const p1 = state.currentPlayerId;

    // Phase 1: draw + place adjacent to the Capital.
    state = applyAction(state, { type: 'DrawTile', actorId: p1 });
    expect(state.pendingTileDraw).not.toBeNull();
    const drawnType = state.pendingTileDraw!;
    const capital = state.players.find((p) => p.id === p1)!.capitalTile;
    const placeCoord = hexNeighbors(capital)[0];
    state = applyAction(state, { type: 'PlaceTile', actorId: p1, tileType: drawnType, coord: placeCoord });
    expect(state.map[`${placeCoord.q},${placeCoord.r}`]?.ownerId).toBe(p1);
    expect(state.pendingTileDraw).toBeNull();

    // Phase 2: advance and move the hero onto the new tile (or stay — path can be empty-ish;
    // move exactly one step if the new tile is enterable, else just advance).
    state = applyAction(state, { type: 'AdvancePhase', actorId: p1 });
    expect(state.currentPhase).toBe(Phase.MoveHero);
    const newTile = state.map[`${placeCoord.q},${placeCoord.r}`];
    if (newTile.type !== 'River') {
      state = applyAction(state, { type: 'MoveHero', actorId: p1, path: [placeCoord] });
      expect(state.players.find((p) => p.id === p1)!.hero.position).toEqual(placeCoord);
    }

    // Phase 3: Gather (no guaranteed action available — just advance through it).
    state = applyAction(state, { type: 'AdvancePhase', actorId: p1 });
    expect(state.currentPhase).toBe(Phase.Gather);
    state = applyAction(state, { type: 'AdvancePhase', actorId: p1 });
    expect(state.currentPhase).toBe(Phase.Fight);

    // Phase 4: [Munchkin exploration layer] stepping onto that brand-new tile in Phase 2 may
    // have drawn a Door card — if it came up Monster, it's mandatory (applyAdvancePhase refuses
    // to leave Phase 4 otherwise) and has to be fought here before advancing; a Utility card (or
    // no draw at all, e.g. a River tile the hero couldn't enter) leaves nothing pending.
    if (state.pendingDoorMonster) {
      const { coord, monsterCardId } = state.pendingDoorMonster;
      state = applyAction(state, { type: 'Fight', actorId: p1, combatType: 'HeroVsMonster', coord, monsterCardId });
      expect(state.pendingDoorMonster).toBeNull();
    }
    state = applyAction(state, { type: 'AdvancePhase', actorId: p1 });
    expect(state.currentPhase).toBe(Phase.Build);

    // Phase 5 -> stepping past Build ends the turn and auto-resolves Phase 0 for player 2.
    state = applyAction(state, { type: 'AdvancePhase', actorId: p1 });
    expect(state.currentPlayerId).toBe('p2');
    expect(state.currentPhase).toBe(Phase.DrawAndPlaceTile); // Phase 0 auto-resolved already
    expect(state.roundNumber).toBe(1); // still round 1 — round only increments once turnOrder wraps
  });

  it('rejects an action from a player who is not currently active', () => {
    const state = createGame('g2', PLAYERS, 'wrong-player-seed', 'hotseat');
    const notActive = state.players.find((p) => p.id !== state.currentPlayerId)!.id;
    expect(() => applyAction(state, { type: 'DrawTile', actorId: notActive })).toThrow(IllegalActionError);
  });

  it('rejects an action taken in the wrong phase', () => {
    const state = createGame('g3', PLAYERS, 'wrong-phase-seed', 'hotseat');
    // currentPhase is DrawAndPlaceTile — MoveHero is illegal here.
    expect(() => applyAction(state, { type: 'MoveHero', actorId: state.currentPlayerId, path: [] })).toThrow(IllegalActionError);
  });

  it('rejects placing a tile that does not touch an owned tile', () => {
    let state = createGame('g4', PLAYERS, 'illegal-placement-seed', 'hotseat');
    const p1 = state.currentPlayerId;
    state = applyAction(state, { type: 'DrawTile', actorId: p1 });
    const farAway = { q: 50, r: 50 };
    expect(() => applyAction(state, { type: 'PlaceTile', actorId: p1, tileType: state.pendingTileDraw!, coord: farAway })).toThrow(IllegalActionError);
  });

  it('rejects drawing a second tile after already placing one this turn (§3: one tile per turn)', () => {
    let state = createGame('g6', PLAYERS, 'double-draw-seed', 'hotseat');
    const p1 = state.currentPlayerId;
    state = applyAction(state, { type: 'DrawTile', actorId: p1 });
    const capital = state.players.find((p) => p.id === p1)!.capitalTile;
    const coord = hexNeighbors(capital)[0];
    state = applyAction(state, { type: 'PlaceTile', actorId: p1, tileType: state.pendingTileDraw!, coord });
    expect(state.hasPlacedTileThisTurn).toBe(true);
    expect(() => applyAction(state, { type: 'DrawTile', actorId: p1 })).toThrow(IllegalActionError);
  });

  it('a full round (both players act) advances roundNumber and resets per-round Rogue/Hunt trackers', () => {
    let state = createGame('g5', PLAYERS, 'round-flow-seed', 'hotseat');
    // Fast-forward both players through a full turn each via AdvancePhase/EndTurn only.
    for (let i = 0; i < 2; i++) {
      const actor = state.currentPlayerId;
      state = applyAction(state, { type: 'EndTurn', actorId: actor });
    }
    expect(state.roundNumber).toBe(2);
  });
});

// [DEFAULT — bugfix, found via a full-game AI balance simulation] nextPlayerId (reducers.ts) used
// to cycle turnOrder unconditionally, so an eliminated player kept taking full turns forever —
// one simulated 3-player game saw this run for 39 more rounds (63% of the game). Hand-marking a
// seat eliminated (rather than actually capturing their Capital) isolates the turn-order fix from
// the whole claim/capture flow already covered by territory.test.ts's "Claiming a Capital
// eliminates its owner" describe block.
describe('EndTurn/AdvancePhase skip eliminated seats (reducers.ts nextPlayerId)', () => {
  const THREE_PLAYERS = [
    { id: 'p1', name: 'Alice', color: '#f00' },
    { id: 'p2', name: 'Bob', color: '#0f0' },
    { id: 'p3', name: 'Carol', color: '#00f' },
  ];

  function eliminate(state: ReturnType<typeof createGame>, playerId: string) {
    return { ...state, players: state.players.map((p) => (p.id === playerId ? { ...p, isEliminated: true } : p)) };
  }

  // createGame rolls turnOrder from the seed (§1.3) rather than using input order — every test
  // below reads the ACTUAL resulting turnOrder rather than assuming ['p1','p2','p3'].

  it('EndTurn hands the turn to the next NON-eliminated seat, not just the next one in turnOrder', () => {
    let state = createGame('g-elim-1', THREE_PLAYERS, 'elim-seed-1', 'hotseat');
    const [first, second, third] = state.turnOrder;
    state = eliminate(state, second);

    state = applyAction(state, { type: 'EndTurn', actorId: first });
    expect(state.currentPlayerId).toBe(third); // NOT second — they're eliminated
  });

  it('keeps cycling correctly for the rest of the game once an elimination has happened', () => {
    let state = createGame('g-elim-2', THREE_PLAYERS, 'elim-seed-2', 'hotseat');
    const [first, second, third] = state.turnOrder;
    state = eliminate(state, second);

    state = applyAction(state, { type: 'EndTurn', actorId: first }); // -> third
    expect(state.currentPlayerId).toBe(third);
    state = applyAction(state, { type: 'EndTurn', actorId: third }); // wraps past `second`, back to first
    expect(state.currentPlayerId).toBe(first);
    expect(state.roundNumber).toBe(2); // a full round DID complete (first, [skip second], third), not stalled
  });

  it("an eliminated player's own turn is skipped even if they were current when eliminated mid-flow", () => {
    // Defensive case: even if something (a future feature) left an eliminated seat as the
    // CURRENT player, the next EndTurn from whoever's actually acting still steps past them.
    let state = createGame('g-elim-3', THREE_PLAYERS, 'elim-seed-3', 'hotseat');
    const [first, second, third] = state.turnOrder;
    state = eliminate(state, third);
    state = applyAction(state, { type: 'EndTurn', actorId: first }); // -> second (third eliminated, not next-in-line anyway)
    expect(state.currentPlayerId).toBe(second);
    state = applyAction(state, { type: 'EndTurn', actorId: second }); // wraps past eliminated third, back to first
    expect(state.currentPlayerId).toBe(first);
  });
});
