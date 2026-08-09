/** Axial hex coordinate math. Flat-top axial (q, r); 6 neighbors per hex, per docs/rules-reference.md. */

import type { HexCoord } from './types';
export { hexKey } from './types';

const DIRECTIONS: HexCoord[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

export function hexEquals(a: HexCoord, b: HexCoord): boolean {
  return a.q === b.q && a.r === b.r;
}

export function hexNeighbors(coord: HexCoord): HexCoord[] {
  return DIRECTIONS.map((d) => ({ q: coord.q + d.q, r: coord.r + d.r }));
}

export function isAdjacent(a: HexCoord, b: HexCoord): boolean {
  return hexNeighbors(a).some((n) => hexEquals(n, b));
}

/** Standard axial hex distance. */
export function hexDistance(a: HexCoord, b: HexCoord): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

/**
 * Up to 6 points, one per primary hex direction, each `radius` steps from the origin.
 * Consecutive entries are exactly `radius` apart (and all other pairs farther), so setting
 * `radius = CAPITAL_MIN_DISTANCE` gives a symmetric layout that satisfies §1.4's "axial
 * distance >= 3 from every other Capital" constraint for up to 6 players in one shot — no
 * search/backtracking needed. v1 auto-places capitals this way rather than taking a manual
 * per-player placement decision; see engine/setup.ts.
 */
export function spawnRingPositions(radius: number, count: number): HexCoord[] {
  return DIRECTIONS.slice(0, count).map((d) => ({ q: d.q * radius, r: d.r * radius }));
}

/** Ring of hexes centered on `center` at exactly `radius` distance. */
export function hexRing(center: HexCoord, radius: number): HexCoord[] {
  if (radius <= 0) return [center];
  const results: HexCoord[] = [];
  let hex: HexCoord = { q: center.q + DIRECTIONS[4].q * radius, r: center.r + DIRECTIONS[4].r * radius };
  for (let side = 0; side < 6; side++) {
    for (let step = 0; step < radius; step++) {
      results.push(hex);
      hex = { q: hex.q + DIRECTIONS[side].q, r: hex.r + DIRECTIONS[side].r };
    }
  }
  return results;
}
