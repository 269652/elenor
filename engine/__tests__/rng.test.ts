import { describe, expect, it } from 'vitest';
import { RngStream, randomAt, rollDieAt } from '../rng';

describe('rng', () => {
  it('is deterministic for the same seed + cursor', () => {
    expect(randomAt('seed-a', 42)).toBe(randomAt('seed-a', 42));
    expect(rollDieAt('seed-a', 7)).toBe(rollDieAt('seed-a', 7));
  });

  it('differs across seeds for the same cursor (no accidental collapse)', () => {
    expect(randomAt('seed-a', 0)).not.toBe(randomAt('seed-b', 0));
  });

  it('rollDie always returns 1-6', () => {
    for (let c = 0; c < 2000; c++) {
      const v = rollDieAt('dice-seed', c);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
    }
  });

  it('RngStream.next() advances the cursor and matches randomAt at each position', () => {
    const stream = new RngStream('stream-seed', 10);
    const a = stream.next();
    const b = stream.next();
    expect(a).toBe(randomAt('stream-seed', 10));
    expect(b).toBe(randomAt('stream-seed', 11));
    expect(stream.cursor).toBe(12);
  });

  it('shuffle is a permutation (same multiset, generally reordered)', () => {
    const stream = new RngStream('shuffle-seed', 0);
    const input = Array.from({ length: 50 }, (_, i) => i);
    const shuffled = stream.shuffle(input);
    expect(shuffled.slice().sort((a, b) => a - b)).toEqual(input);
    expect(shuffled).not.toEqual(input); // astronomically unlikely to match if shuffle works
  });

  it('rollDieWithAdvantage(true) is >= a plain roll at the same cursor, and >= max of the two component rolls', () => {
    for (let c = 0; c < 200; c += 2) {
      const s1 = new RngStream('adv-seed', c);
      const adv = s1.rollDieWithAdvantage(true);
      const s2 = new RngStream('adv-seed', c);
      const d1 = s2.rollDie();
      const d2 = s2.rollDie();
      expect(adv).toBe(Math.max(d1, d2));
    }
  });
});
