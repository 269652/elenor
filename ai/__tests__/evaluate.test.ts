import { describe, expect, it } from 'vitest';
import { createGame } from '@/engine';
import { evaluatePosition, relativeEvaluation } from '../evaluate';

const PLAYERS = [
  { id: 'p1', name: 'Alice', color: '#f00' },
  { id: 'p2', name: 'Bob', color: '#0f0' },
];

describe('evaluatePosition', () => {
  it('rewards more owned territory', () => {
    const state = createGame('g1', PLAYERS, 'eval-seed-1', 'hotseat');
    const baseline = evaluatePosition(state, 'p1');

    const richer = structuredClone(state);
    const p1r = richer.players.find((p) => p.id === 'p1')!;
    p1r.ownedTiles.push({ q: 99, r: 99 }, { q: 98, r: 98 });
    expect(evaluatePosition(richer, 'p1')).toBeGreaterThan(baseline);
  });

  it('rewards a higher hero level', () => {
    const state = createGame('g2', PLAYERS, 'eval-seed-2', 'hotseat');
    const baseline = evaluatePosition(state, 'p1');

    const leveled = structuredClone(state);
    leveled.players.find((p) => p.id === 'p1')!.hero.level = 8;
    expect(evaluatePosition(leveled, 'p1')).toBeGreaterThan(baseline);
  });

  it('penalizes low HP relative to max', () => {
    const state = createGame('g3', PLAYERS, 'eval-seed-3', 'hotseat');
    const baseline = evaluatePosition(state, 'p1');

    const hurt = structuredClone(state);
    hurt.players.find((p) => p.id === 'p1')!.hero.hp = 1;
    expect(evaluatePosition(hurt, 'p1')).toBeLessThan(baseline);
  });

  it('treats an eliminated player as a strongly negative position', () => {
    const state = createGame('g4', PLAYERS, 'eval-seed-4', 'hotseat');
    const eliminated = structuredClone(state);
    eliminated.players.find((p) => p.id === 'p1')!.isEliminated = true;
    expect(evaluatePosition(eliminated, 'p1')).toBeLessThan(-100);
  });

  it('values Victory Points heavily — the dominant term by design', () => {
    const state = createGame('g5', PLAYERS, 'eval-seed-5', 'hotseat');
    const withVp = structuredClone(state);
    withVp.players.find((p) => p.id === 'p1')!.capitalTier = 2;
    // a couple of VP-worthy building tiles too, so the delta isn't hair-thin
    for (const coord of [{ q: 50, r: 50 }, { q: 51, r: 51 }, { q: 52, r: 52 }]) {
      withVp.players.find((p) => p.id === 'p1')!.ownedTiles.push(coord);
    }
    expect(evaluatePosition(withVp, 'p1')).toBeGreaterThan(evaluatePosition(state, 'p1'));
  });
});

describe('relativeEvaluation', () => {
  it('is antisymmetric', () => {
    const state = createGame('g6', PLAYERS, 'eval-seed-6', 'hotseat');
    const skewed = structuredClone(state);
    skewed.players.find((p) => p.id === 'p1')!.hero.level = 7;
    expect(relativeEvaluation(skewed, 'p1', 'p2')).toBeCloseTo(-relativeEvaluation(skewed, 'p2', 'p1'), 10);
  });

  it('favors whichever player is objectively ahead', () => {
    const state = createGame('g7', PLAYERS, 'eval-seed-7', 'hotseat');
    const skewed = structuredClone(state);
    const p1 = skewed.players.find((p) => p.id === 'p1')!;
    p1.hero.level = 9;
    p1.ownedTiles.push({ q: 40, r: 40 }, { q: 41, r: 41 }, { q: 42, r: 42 });
    expect(relativeEvaluation(skewed, 'p1', 'p2')).toBeGreaterThan(0);
  });
});
