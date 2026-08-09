/** Deck construction and draw/reshuffle logic. All pure — take a deck + RngStream, return a
 *  new deck plus whatever was drawn. Reshuffles discardPile back into drawPile when empty. */

import { buildBadStuffCatalog, buildDoorCatalog, buildLootCatalog, buildMonsterCatalog } from './catalogs';
import { riverTileCountFor, tileDeckSize, TILE_DECK_COMPOSITION } from './constants';
import type { RngStream } from './rng';
import type {
  BadStuffCard,
  BadStuffDeckState,
  DoorCard,
  DoorDeckState,
  LootCard,
  LootDeckState,
  LootRarity,
  MonsterCard,
  MonsterDeckState,
  TileDeckState,
  TileType,
} from './types';

export function buildTileDeck(playerCount: number, rng: RngStream): TileDeckState {
  const size = tileDeckSize(playerCount);
  // [DEFAULT — direct request] River is carved out as an absolute per-player count BEFORE the
  // percentage composition applies to what's left — see riverTileCountFor's doc comment in
  // constants.ts for why a flat deck percentage scaled wrong with player count.
  const riverCount = Math.min(size, riverTileCountFor(playerCount));
  const remaining = size - riverCount;
  const bag: TileType[] = Array<TileType>(riverCount).fill('River');
  const entries = (Object.entries(TILE_DECK_COMPOSITION) as [TileType, number][]).filter(([type]) => type !== 'River');
  for (const [type, pct] of entries) {
    if (pct <= 0) continue;
    const count = Math.round((pct / 100) * remaining);
    for (let i = 0; i < count; i++) bag.push(type);
  }
  return { drawPile: rng.shuffle(bag), discardPile: [] };
}

export function buildMonsterDeck(rng: RngStream): MonsterDeckState {
  return { drawPile: rng.shuffle(buildMonsterCatalog()), discardPile: [] };
}

export function buildLootDeck(rng: RngStream): LootDeckState {
  const rarities: LootRarity[] = ['Common', 'Uncommon', 'Rare', 'Legendary'];
  const drawPiles = {} as Record<LootRarity, LootCard[]>;
  const discardPiles = {} as Record<LootRarity, LootCard[]>;
  for (const rarity of rarities) {
    drawPiles[rarity] = rng.shuffle(buildLootCatalog(rarity));
    discardPiles[rarity] = [];
  }
  return { drawPiles, discardPiles };
}

export function buildBadStuffDeck(rng: RngStream): BadStuffDeckState {
  return { drawPile: rng.shuffle(buildBadStuffCatalog()), discardPile: [] };
}

/** [DEFAULT — Munchkin exploration layer] One shuffled deck mixing Monster and Utility door
 *  cards together — see DoorCard's doc comment in types.ts for why it's a single combined pile
 *  rather than two separately-drawn decks (this is exactly what the physical game's Door deck
 *  does: monsters and non-monster cards, shuffled as one pile). */
export function buildDoorDeck(rng: RngStream): DoorDeckState {
  return { drawPile: rng.shuffle(buildDoorCatalog()), discardPile: [] };
}

export function drawTile(deck: TileDeckState, rng: RngStream): { tile: TileType; deck: TileDeckState } {
  let { drawPile, discardPile } = deck;
  if (drawPile.length === 0) {
    drawPile = rng.shuffle(discardPile);
    discardPile = [];
  }
  const [tile, ...rest] = drawPile;
  return { tile, deck: { drawPile: rest, discardPile } };
}

export function discardTile(deck: TileDeckState, tile: TileType): TileDeckState {
  return { ...deck, discardPile: [...deck.discardPile, tile] };
}

/** Draws a monster to guard a freshly-placed Ruins tile. Deliberately does NOT append to
 *  discardPile — the card is now "in play" (tracked via Tile.monsterDenCardId) until it's
 *  actually defeated, not merely drawn. Auto-discarding here would let a reshuffle hand the
 *  same monster to a second Ruins tile while it's still guarding the first. Call
 *  discardMonster() explicitly once a hero wins the fight. */
export function drawMonster(deck: MonsterDeckState, rng: RngStream): { card: MonsterCard; deck: MonsterDeckState } {
  let { drawPile, discardPile } = deck;
  if (drawPile.length === 0) {
    drawPile = rng.shuffle(discardPile);
    discardPile = [];
  }
  const [card, ...rest] = drawPile;
  return { card, deck: { drawPile: rest, discardPile } };
}

/** Retires a defeated monster back to the discard pile, making it eligible for a future
 *  reshuffle onto some other Ruins tile. */
export function discardMonster(deck: MonsterDeckState, card: MonsterCard): MonsterDeckState {
  return { ...deck, discardPile: [...deck.discardPile, card] };
}

/** Draws one Loot card of the given rarity.
 *
 *  Returns `card: null` when that rarity is genuinely exhausted — callers MUST handle it. Unlike
 *  the tile/monster/bad-stuff decks, a Loot card that gets drawn is kept by its hero forever
 *  (there is no rule that returns it), so `discardPiles` for a rarity stays empty in practice and
 *  the reshuffle below can't refill anything. The pile really can run dry, and the treasure
 *  simply isn't there when it does.
 *
 *  This used to destructure an empty array and hand back `undefined` typed as `LootCard`, so the
 *  first draw past exhaustion crashed with a TypeError deep inside a reducer rather than failing
 *  as a rule. It went unnoticed for a long time only because the AI never actually reached a
 *  Monster Den, so barely any loot was ever drawn; once heroes started adventuring it reproduced
 *  almost immediately. Modeling exhaustion in the return type is what keeps that honest. */
export function drawLoot(deck: LootDeckState, rarity: LootRarity, rng: RngStream): { card: LootCard | null; deck: LootDeckState } {
  let drawPile = deck.drawPiles[rarity];
  let discardPile = deck.discardPiles[rarity];
  if (drawPile.length === 0) {
    drawPile = rng.shuffle(discardPile);
    discardPile = [];
  }
  if (drawPile.length === 0) return { card: null, deck };
  const [card, ...rest] = drawPile;
  return {
    card,
    deck: {
      drawPiles: { ...deck.drawPiles, [rarity]: rest },
      discardPiles: { ...deck.discardPiles, [rarity]: discardPile },
    },
  };
}

export function drawBadStuff(deck: BadStuffDeckState, rng: RngStream): { card: BadStuffCard; deck: BadStuffDeckState } {
  let { drawPile, discardPile } = deck;
  if (drawPile.length === 0) {
    drawPile = rng.shuffle(discardPile);
    discardPile = [];
  }
  const [card, ...rest] = drawPile;
  return { card, deck: { drawPile: rest, discardPile: [...discardPile, card] } };
}

/** Draws the next Door card. Unlike Loot, nothing permanently leaves this deck — a fought
 *  Monster and a resolved Utility both go back to the discard pile (see reducers.ts's
 *  resolveDoorCardIfNewTile/applyFightMonster) — so genuine exhaustion should be rare, limited
 *  to the instant both piles are momentarily empty. Still returns `card: null` defensively
 *  rather than crashing, matching drawLoot's contract, since "no encounter" is a perfectly
 *  legal (if unlikely) outcome of arriving somewhere new. */
export function drawDoor(deck: DoorDeckState, rng: RngStream): { card: DoorCard | null; deck: DoorDeckState } {
  let { drawPile, discardPile } = deck;
  if (drawPile.length === 0) {
    drawPile = rng.shuffle(discardPile);
    discardPile = [];
  }
  if (drawPile.length === 0) return { card: null, deck };
  const [card, ...rest] = drawPile;
  return { card, deck: { drawPile: rest, discardPile } };
}
