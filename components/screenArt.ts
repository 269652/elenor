/** Full-bleed screen background art, same incremental-registry pattern as board/tileArt.ts —
 *  add a key once the file lands in public/artworks/screens/, nothing breaks in the meantime. */

export const SCREEN_ART: Partial<Record<'main' | 'newgame' | 'game', string>> = {
  main: '/artworks/screens/main.jpg',
  newgame: '/artworks/screens/newgame.jpg',
  game: '/artworks/screens/game.jpg',
};
