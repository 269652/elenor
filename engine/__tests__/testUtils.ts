import { rollDieAt } from '../rng';
import { BANK_TRADE_DEFAULT_RATIO, STARTING_RESOURCES } from '../constants';
import { emptyResourceBundle, hexKey } from '../types';
import type { ClassName, HeroState, Player, ResourceBundle, Tile } from '../types';

/** Brute-force helper: finds an RNG cursor that produces a desired die value, so tests can
 *  reproduce docs/rules-reference.md's worked examples exactly instead of only checking
 *  outcomes statistically. Not part of the engine's public API — test-only. */
export function findCursorForDie(seed: string, desired: number, startAt = 0): number {
  for (let c = startAt; c < startAt + 100_000; c++) {
    if (rollDieAt(seed, c) === desired) return c;
  }
  throw new Error(`Could not find a cursor producing die=${desired} near ${startAt}`);
}

/** Finds a cursor where a 2d6-keep-highest (Warrior advantage) roll starting there equals
 *  `desiredMax` exactly. */
export function findCursorForAdvantageMax(seed: string, desiredMax: number, startAt = 0): number {
  for (let c = startAt; c < startAt + 100_000; c++) {
    if (Math.max(rollDieAt(seed, c), rollDieAt(seed, c + 1)) === desiredMax) return c;
  }
  throw new Error(`Could not find a cursor producing advantage-max=${desiredMax} near ${startAt}`);
}

export function makeHero(overrides: Partial<HeroState> = {}): HeroState {
  return {
    id: 'hero-1',
    ownerId: 'player-1',
    level: 1,
    hp: 10,
    maxHp: 10,
    attack: 1,
    xp: 0,
    xpToNextLevel: 3,
    position: { q: 0, r: 0 },
    movementRange: 2,
    canBoat: false,
    inventory: [],
    equippedLootIds: [],
    activeCurses: [],
    hasHuntedThisRound: false,
    pendingLevelUp: false,
    carriedResources: emptyResourceBundle(),
    visitedTiles: [hexKey({ q: 0, r: 0 })], // matches the default `position` above
    ...overrides,
  };
}

export function makeTile(overrides: Partial<Tile> = {}): Tile {
  return {
    coord: { q: 0, r: 0 },
    type: 'Plains',
    ownerId: null,
    building: null,
    monsterDenCardId: null,
    stockpile: emptyResourceBundle(),
    ...overrides,
  };
}

/** overrides.resources is intentionally a Partial<ResourceBundle> (not the full bundle Player
 *  itself requires) — callers commonly want to set just e.g. { Food: 10 } and have the rest
 *  default to STARTING_RESOURCES's zeros, same idea as ResourceCost elsewhere in the engine. */
type MakePlayerOverrides = Partial<Omit<Player, 'resources'>> & { resources?: Partial<ResourceBundle> };

export function makePlayer(overrides: MakePlayerOverrides = {}, classId: ClassName = 'Farmer'): Player {
  const capitalTile = overrides.capitalTile ?? { q: 0, r: 0 };
  // Merge overrides.resources (a Partial<ResourceBundle> — callers commonly pass just e.g.
  // { Food: 10 }) onto STARTING_RESOURCES so every ResourceType key ends up defined (0, not
  // undefined). This has to be spread in AFTER `...overrides` below, or the blanket overrides
  // spread would clobber this merged bundle right back down to the raw (holey) partial.
  const resources: ResourceBundle = { ...STARTING_RESOURCES, ...(overrides.resources ?? {}) };
  return {
    id: 'player-1',
    name: 'Test Player',
    color: '#ff0000',
    classId,
    ownedTiles: [capitalTile],
    capitalTile,
    capitalTier: 0,
    hero: makeHero({ ownerId: overrides.id ?? 'player-1', position: capitalTile }),
    victoryPoints: 0,
    isEliminated: false,
    bankTradeRatio: BANK_TRADE_DEFAULT_RATIO,
    hasStolenThisRound: false,
    foragedTilesThisRound: [],
    ...overrides,
    resources,
  };
}
