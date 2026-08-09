/** Colorblind-safe-ish palette (distinct hue + distinct icon per type, never color alone —
 *  docs/ui-spec.md's accessibility note) for tiles and resources. */

import type { ResourceType, TileType } from '@/engine';

/** Fallback flat fills for tile types with no painted artwork yet (see tileArt.ts) — muted,
 *  gouache-like tones tuned to sit alongside the commissioned paintings rather than clash as
 *  flat web-safe color against them. */
export const TILE_COLOR: Record<TileType, string> = {
  Forest: '#2d5a3a',
  Plains: '#b8923a',
  Hills: '#8a6a3a',
  Mountain: '#5c6570',
  Desert: '#c9a56a',
  River: '#2f6f8f',
  Ruins: '#4a3168',
  Volcano: '#7a2a1f',
  Ashland: '#4a4238',
};

export const TILE_ICON: Record<TileType, string> = {
  Forest: '🌲',
  Plains: '🌾',
  Hills: '⛰️',
  Mountain: '🏔️',
  Desert: '🏜️',
  River: '🌊',
  Ruins: '🏚️',
  Volcano: '🌋',
  Ashland: '🌑',
};

export const RESOURCE_COLOR: Record<ResourceType, string> = {
  Wood: '#65a30d',
  Stone: '#78716c',
  Food: '#ca8a04',
  Ore: '#475569',
  Meat: '#b5533a',
  Gold: '#eab308',
};

export const RESOURCE_ICON: Record<ResourceType, string> = {
  Wood: '🪵',
  Stone: '🪨',
  Food: '🌽',
  Ore: '⛏️',
  Meat: '🥩',
  Gold: '🪙',
};
