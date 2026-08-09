/** Pointy-top axial -> pixel projection. Matches engine/hex.ts's neighbor directions exactly
 *  (per docs/ui-spec.md's recommendation to keep hex math and rendering in lockstep) — see
 *  Red Blob Games' axial coordinate reference for the standard formula this follows. */

import type { HexCoord } from '@/engine';

export interface Pixel {
  x: number;
  y: number;
}

export function axialToPixel(coord: HexCoord, size: number): Pixel {
  const x = size * Math.sqrt(3) * (coord.q + coord.r / 2);
  const y = size * 1.5 * coord.r;
  return { x, y };
}

/** SVG polygon `points` string for a single pointy-top hex of the given size, centered at
 *  the origin (translate the <g> to position it). */
export function hexPolygonPoints(size: number): string {
  const points: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    points.push(`${(size * Math.cos(angle)).toFixed(2)},${(size * Math.sin(angle)).toFixed(2)}`);
  }
  return points.join(' ');
}
