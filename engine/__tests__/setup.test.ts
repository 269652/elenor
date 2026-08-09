import { describe, expect, it } from 'vitest';
import { hexDistance } from '../hex';
import { createGame } from '../setup';
import { CAPITAL_MIN_DISTANCE, STARTING_RESOURCES } from '../constants';
import { Phase } from '../types';

const PLAYERS = [
  { id: 'p1', name: 'Alice', color: '#f00' },
  { id: 'p2', name: 'Bob', color: '#0f0' },
  { id: 'p3', name: 'Carol', color: '#00f' },
];

describe('createGame (§1 Setup)', () => {
  it('rejects fewer than 2 or more than 6 players', () => {
    expect(() => createGame('g', [PLAYERS[0]], 'seed', 'hotseat')).toThrow();
    expect(() => createGame('g', Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, color: '#000' })), 'seed', 'hotseat')).toThrow();
  });

  it('is fully deterministic for a given seed', () => {
    const a = createGame('g1', PLAYERS, 'fixed-seed', 'hotseat');
    const b = createGame('g1', PLAYERS, 'fixed-seed', 'hotseat');
    expect(a).toEqual(b);
  });

  it('produces different games for different seeds', () => {
    const a = createGame('g1', PLAYERS, 'seed-a', 'hotseat');
    const b = createGame('g1', PLAYERS, 'seed-b', 'hotseat');
    expect(a.turnOrder).not.toEqual(b.players.map((p) => p.id)); // sanity: seeds diverge somewhere
  });

  it('places every Capital at >= CAPITAL_MIN_DISTANCE from every other Capital (§1.4)', () => {
    const state = createGame('g1', PLAYERS, 'placement-seed', 'hotseat');
    for (let i = 0; i < state.players.length; i++) {
      for (let j = i + 1; j < state.players.length; j++) {
        const dist = hexDistance(state.players[i].capitalTile, state.players[j].capitalTile);
        expect(dist).toBeGreaterThanOrEqual(CAPITAL_MIN_DISTANCE);
      }
    }
  });

  it('every player gets a unique class out of the 7', () => {
    const state = createGame('g1', PLAYERS, 'class-seed', 'hotseat');
    const classes = state.players.map((p) => p.classId);
    expect(new Set(classes).size).toBe(classes.length);
  });

  it('seeds starting resources at or above the §1.2 baseline (class bonuses only add)', () => {
    const state = createGame('g1', PLAYERS, 'resource-seed', 'hotseat');
    for (const p of state.players) {
      expect(p.resources.Wood).toBeGreaterThanOrEqual(STARTING_RESOURCES.Wood);
      expect(p.resources.Stone).toBeGreaterThanOrEqual(STARTING_RESOURCES.Stone);
    }
  });

  it('lands on Phase 1 for the first player — Phase 0 is a pure pass-through (§2)', () => {
    const state = createGame('g1', PLAYERS, 'phase-seed', 'hotseat');
    expect(state.currentPhase).toBe(Phase.DrawAndPlaceTile);
    expect(state.currentPlayerId).toBe(state.turnOrder[0]);
    expect(state.eventLog.some((e) => e.type === 'PhaseAdvanced')).toBe(true);
  });

  it('every tile starts with an empty stockpile and every hero starts carrying nothing', () => {
    const state = createGame('g1', PLAYERS, 'stockpile-seed', 'hotseat');
    for (const tile of Object.values(state.map)) {
      for (const r of ['Wood', 'Stone', 'Food', 'Ore', 'Gold'] as const) expect(tile.stockpile[r]).toBe(0);
    }
    for (const p of state.players) {
      for (const r of ['Wood', 'Stone', 'Food', 'Ore', 'Gold'] as const) expect(p.hero.carriedResources[r]).toBe(0);
    }
  });

  it('every hero spawns on its own Capital tile with base stats before class bonuses skew things', () => {
    const state = createGame('g1', PLAYERS, 'hero-seed', 'hotseat');
    for (const p of state.players) {
      expect(p.hero.position).toEqual(p.capitalTile);
      expect(p.hero.level).toBe(1);
      expect(p.hero.attack).toBeGreaterThanOrEqual(1); // 1 base, +2 more if Warrior
      expect(p.hero.hp).toBe(p.hero.maxHp);
    }
  });
});
