import { describe, expect, it } from 'vitest';
import { hexDistance, hexKey, hexNeighbors, isAdjacent, spawnRingPositions } from '../hex';

describe('hex math', () => {
  it('hexKey formats as "q,r"', () => {
    expect(hexKey({ q: 3, r: -2 })).toBe('3,-2');
  });

  it('every neighbor is exactly distance 1 away', () => {
    const center = { q: 5, r: -3 };
    for (const n of hexNeighbors(center)) {
      expect(hexDistance(center, n)).toBe(1);
      expect(isAdjacent(center, n)).toBe(true);
    }
  });

  it('a hex is not adjacent to itself', () => {
    const center = { q: 0, r: 0 };
    expect(isAdjacent(center, center)).toBe(false);
  });

  it('hexDistance is symmetric and zero for identical coords', () => {
    const a = { q: 2, r: -5 };
    const b = { q: -3, r: 1 };
    expect(hexDistance(a, b)).toBe(hexDistance(b, a));
    expect(hexDistance(a, a)).toBe(0);
  });

  it('spawnRingPositions(3, N) satisfies the Capital min-distance-3 rule for every pair, 2-6 players', () => {
    for (let n = 2; n <= 6; n++) {
      const points = spawnRingPositions(3, n);
      expect(points).toHaveLength(n);
      for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) {
          expect(hexDistance(points[i], points[j])).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });
});
