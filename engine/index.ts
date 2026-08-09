/** Public engine API surface — import from `@/engine`, not from individual files, outside
 *  this directory (server/, hooks/, components/ should all go through here). */

export * from './types';
export * from './constants';
export * from './hex';
export { RngStream, randomAt, rollDieAt } from './rng';
export * from './selectors';
export * from './combat';
export { createGame } from './setup';
export type { SetupPlayerInput } from './setup';
export { applyAction } from './reducer';
/** [DEFAULT — territory rework] The one reducer-side helper the UI/AI genuinely need: a tile's
 *  garrison and a tile's owner are now separate facts, and every reader has to ask which one it
 *  means. Everything else in reducers.ts stays behind applyAction. */
export { garrisonOwnerOf } from './reducers';
export { buildMonsterCatalog, buildLootCatalog, buildBadStuffCatalog, buildUtilityCatalog, buildDoorCatalog, getMonsterById } from './catalogs';
export { buildDoorDeck, drawDoor } from './decks';
