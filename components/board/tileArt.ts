/** Painted tile artwork registry — maps a TileType to its commissioned illustration under
 *  public/artworks/tiles/, if one exists yet. Tile types with no entry fall back to the flat
 *  color + icon rendering in HexBoard.tsx, so new art can be dropped in incrementally (drop a
 *  file at public/artworks/tiles/<name>.jpg and add one line here) without anything breaking
 *  in the meantime. */

import type { TileType } from '@/engine';

export const TILE_ART: Partial<Record<TileType, string>> = {
  Plains: '/artworks/tiles/plains.jpg',
  Forest: '/artworks/tiles/forest.jpg',
  Desert: '/artworks/tiles/desert.jpg',
  Mountain: '/artworks/tiles/mountain.jpg',
  River: '/artworks/tiles/river.jpg',
  Hills: '/artworks/tiles/hills.jpg', // source file was named earth.png — rocky/mining terrain, matches Hills not Ashland
  Volcano: '/artworks/tiles/volcano.jpg',
  Ruins: '/artworks/tiles/ruins.jpg',
};
