import { describe, expect, it } from 'vitest';
import { applyAction } from '../reducer';
import { drawDoor } from '../decks';
import { buildMonsterCatalog } from '../catalogs';
import { RngStream } from '../rng';
import { lootRarityForMonsterLevel } from '../constants';
import { hexKey, IllegalActionError, Phase } from '../types';
import type {
  BadStuffCard,
  DoorCard,
  DoorDeckState,
  GameState,
  HeroState,
  HexCoord,
  LootCard,
  LootDeckState,
  LootRarity,
  MonsterCard,
  Player,
  Tile,
  UtilityCard,
  UtilityEffectKind,
} from '../types';
import { makeHero, makePlayer, makeTile } from './testUtils';

/**
 * [Munchkin exploration layer] Dedicated engine-rule coverage for the Door deck: the first-visit
 * trigger (applyMoveHero -> resolveDoorCardIfNewTile), the Monster/Utility split, the mandatory
 * pending-fight gate on AdvancePhase/EndTurn, the dual Ruins-Den-vs-Door source handling inside
 * applyFightMonster, per-hero visitedTiles independence, and doorDeck reshuffle/exhaustion.
 *
 * Existing coverage (ai/__tests__/decideAction.test.ts, ai/__tests__/munchkinLayer.test.ts) only
 * exercises this through AI play — real, but incidental. This file targets the reducer rules
 * directly with hand-built, deterministic fixtures (same fixtureState pattern as
 * territory.test.ts / roads.test.ts), rather than relying on shuffle outcomes.
 *
 * A Monster DoorCard's `monster` MUST be a real catalog entry: applyFightMonster resolves the
 * fight via `getMonsterById(action.monsterCardId)`, which looks the id up in the static catalog
 * (catalogs.ts), NOT from whatever object happens to be sitting in the deck. A hand-built Monster
 * card with a made-up id would make that lookup throw. Utility cards have no such lookup —
 * applyUtilityEffect operates on the DoorCard's own embedded object — so those are synthesized
 * freely below.
 */

// ── Fixture plumbing ──────────────────────────────────────────────────────────────────────────

/** Hand-built GameState, same pattern as territory.test.ts / roads.test.ts's fixtureState. */
function fixtureState(players: Player[], tiles: Tile[], overrides: Partial<GameState> = {}): GameState {
  const map: Record<string, Tile> = {};
  for (const t of tiles) map[hexKey(t.coord)] = t;
  return {
    gameId: 'g-door',
    mode: 'hotseat',
    status: 'active',
    rngSeed: 'door-seed',
    rngCursor: 0,
    roundNumber: 5,
    turnOrder: players.map((p) => p.id),
    currentPlayerId: players[0].id,
    currentPhase: Phase.MoveHero,
    map,
    roads: {},
    players,
    tileDeck: { drawPile: [], discardPile: [] },
    monsterDeck: { drawPile: [], discardPile: [] },
    lootDeck: {
      drawPiles: { Common: [], Uncommon: [], Rare: [], Legendary: [] },
      discardPiles: { Common: [], Uncommon: [], Rare: [], Legendary: [] },
    },
    badStuffDeck: { drawPile: [], discardPile: [] },
    doorDeck: { drawPile: [], discardPile: [] },
    pendingDoorMonster: null,
    eventLog: [],
    winnerId: null,
    winCondition: null,
    pendingTileDraw: null,
    hasPlacedTileThisTurn: false,
    hasFoughtThisTurn: false,
    hasBuiltThisTurn: false,
    hasMovedThisTurn: false,
    ...overrides,
  };
}

function eventsOfType(state: GameState, type: string) {
  return state.eventLog.filter((e) => e.type === type);
}

function playerIn(state: GameState, id: string): Player {
  return state.players.find((p) => p.id === id)!;
}

// ── Real catalog monsters (Monster DoorCards must resolve via getMonsterById) ──────────────────

const MONSTER_CATALOG = buildMonsterCatalog();
/** Any real monster — used where the specific level doesn't matter. */
const SOME_MONSTER: MonsterCard = MONSTER_CATALOG[0];
/** The catalog's highest-level entry — pairs with a stock (level 1, attack 1) hero to guarantee
 *  a LOSS regardless of the die roll (max total 6+1+1+0=8 can never clear a level>=6 threshold,
 *  and every current template past level 5 exists purely to guard against this catalog someday
 *  losing its top end). Picked dynamically, not by name, so it stays correct if the catalog's
 *  content is expanded elsewhere. */
const APEX_MONSTER: MonsterCard = MONSTER_CATALOG.reduce((max, m) => (m.level > max.level ? m : max), MONSTER_CATALOG[0]);

function monsterDoorCard(monster: MonsterCard): DoorCard {
  return { kind: 'Monster', monster };
}

function utilityDoorCard(effectKind: UtilityEffectKind, amount?: number, id = `test-utility-${effectKind}`): DoorCard {
  const utility: UtilityCard = { id, name: `Test ${effectKind}`, flavor: 'test flavor text', effectKind, amount };
  return { kind: 'Utility', utility };
}

function lootDeckWith(rarity: LootRarity, cards: LootCard[]): LootDeckState {
  const rarities: LootRarity[] = ['Common', 'Uncommon', 'Rare', 'Legendary'];
  const drawPiles = {} as Record<LootRarity, LootCard[]>;
  const discardPiles = {} as Record<LootRarity, LootCard[]>;
  for (const r of rarities) {
    drawPiles[r] = r === rarity ? cards : [];
    discardPiles[r] = [];
  }
  return { drawPiles, discardPiles };
}

const TEST_LOOT_COMMON: LootCard = { id: 'test-loot-common', name: 'Test Trinket', rarity: 'Common', combatBonus: 1 };
const TEST_BADSTUFF: BadStuffCard = { id: 'test-badstuff', name: 'Test Mishap', effectDescription: 'nothing special' };

// ── Coordinates ──────────────────────────────────────────────────────────────────────────────

const SPAWN: HexCoord = { q: 0, r: 0 };
const NEW_TILE: HexCoord = { q: 1, r: 0 }; // adjacent to SPAWN
const FAR_NEW_TILE: HexCoord = { q: 2, r: 0 }; // adjacent to NEW_TILE, 2 hexes from SPAWN

/** Single player, single hero, standing at SPAWN with SPAWN already visited — the common case
 *  for every Phase-2 MoveHero test in groups 1-3 and 7. */
function moveFixture(opts: {
  heroOverrides?: Partial<HeroState>;
  doorDeck?: DoorDeckState;
  extraTiles?: Tile[];
  lootDeck?: LootDeckState;
  state?: Partial<GameState>;
} = {}): GameState {
  const hero = makeHero({ ownerId: 'p1', position: SPAWN, visitedTiles: [hexKey(SPAWN)], ...opts.heroOverrides });
  const p1 = makePlayer({ id: 'p1', capitalTile: SPAWN, ownedTiles: [SPAWN], hero });
  const tiles: Tile[] = [
    makeTile({ coord: SPAWN, type: 'Plains', ownerId: 'p1' }),
    makeTile({ coord: NEW_TILE, type: 'Forest', ownerId: null }),
    makeTile({ coord: FAR_NEW_TILE, type: 'Forest', ownerId: null }),
    ...(opts.extraTiles ?? []),
  ];
  return fixtureState([p1], tiles, {
    currentPhase: Phase.MoveHero,
    doorDeck: opts.doorDeck ?? { drawPile: [], discardPile: [] },
    lootDeck: opts.lootDeck ?? {
      drawPiles: { Common: [], Uncommon: [], Rare: [], Legendary: [] },
      discardPiles: { Common: [], Uncommon: [], Rare: [], Legendary: [] },
    },
    ...opts.state,
  });
}

function moveOnto(state: GameState, coord: HexCoord) {
  return applyAction(state, { type: 'MoveHero', actorId: 'p1', path: [coord] });
}

// ── 1. New tile draws exactly one card; revisiting draws nothing ───────────────────────────────

describe('resolveDoorCardIfNewTile: the first-visit trigger', () => {
  it('moving onto a NEW tile draws exactly one Door card and records it as visited', () => {
    const doorDeck: DoorDeckState = { drawPile: [utilityDoorCard('Nothing')], discardPile: [] };
    const state = moveFixture({ doorDeck });
    const after = moveOnto(state, NEW_TILE);

    expect(after.players[0].hero.visitedTiles).toContain(hexKey(NEW_TILE));
    expect(after.doorDeck.drawPile).toHaveLength(0); // the one card was drawn
    expect(after.doorDeck.discardPile).toHaveLength(1); // Utility resolves+discards immediately
    expect(eventsOfType(after, 'DoorCardDrawn')).toHaveLength(1);
  });

  it('moving onto an ALREADY-visited tile draws nothing', () => {
    const doorDeck: DoorDeckState = { drawPile: [utilityDoorCard('Nothing', undefined, 'untouched-card')], discardPile: [] };
    const state = moveFixture({
      heroOverrides: { visitedTiles: [hexKey(SPAWN), hexKey(NEW_TILE)] }, // NEW_TILE already visited
      doorDeck,
    });
    const after = moveOnto(state, NEW_TILE);

    expect(after.players[0].hero.visitedTiles).toEqual([hexKey(SPAWN), hexKey(NEW_TILE)]); // unchanged
    expect(after.doorDeck.drawPile).toHaveLength(1); // the card is still sitting there, untouched
    expect(after.doorDeck.drawPile[0]).toEqual(doorDeck.drawPile[0]);
    expect(after.doorDeck.discardPile).toHaveLength(0);
    expect(eventsOfType(after, 'DoorCardDrawn')).toHaveLength(0);
    expect(eventsOfType(after, 'HeroMoved')).toHaveLength(1); // the move itself still happened
  });

  it('only the FINAL destination of a multi-hex path triggers a draw', () => {
    // SPAWN -> NEW_TILE -> FAR_NEW_TILE, both new, cost 2 (fits the level-1 movementRange of 2).
    const doorDeck: DoorDeckState = { drawPile: [utilityDoorCard('Nothing')], discardPile: [] };
    const state = moveFixture({ doorDeck });
    const after = applyAction(state, { type: 'MoveHero', actorId: 'p1', path: [NEW_TILE, FAR_NEW_TILE] });

    const hero = after.players[0].hero;
    expect(hero.position).toEqual(FAR_NEW_TILE);
    expect(hero.visitedTiles).toContain(hexKey(FAR_NEW_TILE));
    expect(hero.visitedTiles).not.toContain(hexKey(NEW_TILE)); // passed through, never "entered"
    expect(after.doorDeck.drawPile).toHaveLength(0); // exactly one card consumed, not two
    expect(eventsOfType(after, 'DoorCardDrawn')).toHaveLength(1);
  });
});

// ── 2. Monster draw ──────────────────────────────────────────────────────────────────────────

describe('resolveDoorCardIfNewTile: a Monster draw', () => {
  it('sets pendingDoorMonster with the right heroId/coord/monsterCardId and removes it from the drawPile', () => {
    const doorDeck: DoorDeckState = { drawPile: [monsterDoorCard(SOME_MONSTER)], discardPile: [] };
    const state = moveFixture({ doorDeck });
    const after = moveOnto(state, NEW_TILE);

    expect(after.pendingDoorMonster).toEqual({
      heroId: after.players[0].hero.id,
      coord: NEW_TILE,
      monsterCardId: SOME_MONSTER.id,
    });
    expect(after.doorDeck.drawPile).toHaveLength(0);
    // Unlike Utility, a drawn Monster is NOT discarded yet — it's "in play" as a pending
    // encounter until fought (see applyFightMonster).
    expect(after.doorDeck.discardPile).toHaveLength(0);

    const drawn = eventsOfType(after, 'DoorCardDrawn');
    expect(drawn).toHaveLength(1);
    expect(drawn[0].payload).toMatchObject({ kind: 'Monster', monsterId: SOME_MONSTER.id });
  });
});

// ── 3. Utility draws ─────────────────────────────────────────────────────────────────────────

describe('resolveDoorCardIfNewTile: a Utility draw resolves immediately', () => {
  it('GainFood adds to the hero\'s carried resources', () => {
    const doorDeck: DoorDeckState = { drawPile: [utilityDoorCard('GainFood', 2)], discardPile: [] };
    const state = moveFixture({ doorDeck });
    const after = moveOnto(state, NEW_TILE);

    expect(after.players[0].hero.carriedResources.Food).toBe(2);
    expect(after.pendingDoorMonster).toBeNull();
    expect(after.doorDeck.discardPile).toHaveLength(1);
    expect(after.doorDeck.drawPile).toHaveLength(0);
    const drawn = eventsOfType(after, 'DoorCardDrawn');
    expect(drawn[0].payload).toMatchObject({ kind: 'Utility', effectKind: 'GainFood' });
  });

  it('HealHp raises hp, capped at maxHp', () => {
    const doorDeck: DoorDeckState = { drawPile: [utilityDoorCard('HealHp', 3)], discardPile: [] };
    const state = moveFixture({ doorDeck, heroOverrides: { hp: 5, maxHp: 10 } });
    const after = moveOnto(state, NEW_TILE);

    expect(after.players[0].hero.hp).toBe(8);
    expect(after.pendingDoorMonster).toBeNull();
    expect(after.doorDeck.discardPile).toHaveLength(1);
  });

  it('FreeTreasure draws a Common Loot card into the hero\'s inventory, no fight involved', () => {
    const doorDeck: DoorDeckState = { drawPile: [utilityDoorCard('FreeTreasure')], discardPile: [] };
    const state = moveFixture({ doorDeck, lootDeck: lootDeckWith('Common', [TEST_LOOT_COMMON]) });
    const after = moveOnto(state, NEW_TILE);

    expect(after.players[0].hero.inventory).toEqual([TEST_LOOT_COMMON]);
    expect(after.lootDeck.drawPiles.Common).toHaveLength(0);
    expect(after.pendingDoorMonster).toBeNull();
    expect(after.doorDeck.discardPile).toHaveLength(1);
    expect(eventsOfType(after, 'CombatResolved')).toHaveLength(0); // definitely not a fight
  });

  it('a lethal DamageHp hazard downs the hero back to their Capital, same as combat', () => {
    // The hero's position is already set to `destination` (NEW_TILE) before the Door card is
    // drawn (see applyMoveHero). A DamageHp hazard that drops hp to <=0 routes through the same
    // applyHeroDamage as a lost fight — full heal, teleport home — so it should override that
    // just-set position within the same action, not leave the hero stranded at 0 hp on the tile
    // they were exploring.
    const doorDeck: DoorDeckState = { drawPile: [utilityDoorCard('DamageHp', 5)], discardPile: [] };
    const state = moveFixture({ doorDeck, heroOverrides: { hp: 3, maxHp: 10 } });
    const after = moveOnto(state, NEW_TILE);

    const hero = after.players[0].hero;
    expect(hero.hp).toBe(hero.maxHp); // downed and fully healed
    expect(hero.position).toEqual(SPAWN); // sent home, not left on NEW_TILE
    expect(hero.visitedTiles).toContain(hexKey(NEW_TILE)); // still counts as having been there
  });

  it('Nothing is a pure flavor whiff — no state change beyond the discard/visited bookkeeping', () => {
    const doorDeck: DoorDeckState = { drawPile: [utilityDoorCard('Nothing')], discardPile: [] };
    const state = moveFixture({ doorDeck, heroOverrides: { hp: 7 } });
    const after = moveOnto(state, NEW_TILE);

    expect(after.players[0].hero.hp).toBe(7);
    expect(after.players[0].hero.carriedResources).toEqual(state.players[0].hero.carriedResources);
    expect(after.doorDeck.discardPile).toHaveLength(1);
    expect(after.pendingDoorMonster).toBeNull();
  });
});

// ── 4. The mandatory-fight gate ──────────────────────────────────────────────────────────────

/** A single-player state with a pendingDoorMonster already sitting on the hero, ready to fight
 *  or to try (and fail) to skip past. `winGuaranteed`/`loseGuaranteed` tune the hero's stats so
 *  the die roll (1-6) can't flip the outcome either way. */
function pendingFightState(opts: {
  outcome: 'win' | 'lose';
  currentPhase?: Phase;
  hasFoughtThisTurn?: boolean;
  monsterDeck?: GameState['monsterDeck'];
  lootDeck?: LootDeckState;
  badStuffDeck?: GameState['badStuffDeck'];
}): { state: GameState; monster: MonsterCard; heroId: string } {
  const monster = opts.outcome === 'win' ? SOME_MONSTER : APEX_MONSTER;
  const heroStats = opts.outcome === 'win' ? { level: 3, attack: 50 } : { level: 1, attack: 1 };
  // Sanity-check the guarantee at fixture-build time, so a bad assumption fails loudly here
  // rather than producing a confusing assertion failure deep in a test.
  const worstCaseTotal = 6 + heroStats.level + heroStats.attack; // die max(6) + level + attack + gear(0)
  const bestCaseTotal = 1 + heroStats.level + heroStats.attack;
  const threshold = monster.level + 3; // MONSTER_THRESHOLD_OFFSET
  if (opts.outcome === 'win') expect(bestCaseTotal).toBeGreaterThanOrEqual(threshold);
  else expect(worstCaseTotal).toBeLessThan(threshold);

  const hero = makeHero({
    ownerId: 'p1',
    position: NEW_TILE,
    visitedTiles: [hexKey(SPAWN), hexKey(NEW_TILE)],
    hp: 20,
    maxHp: 20,
    ...heroStats,
  });
  const p1 = makePlayer({ id: 'p1', capitalTile: SPAWN, ownedTiles: [SPAWN], hero });
  const tiles: Tile[] = [makeTile({ coord: SPAWN, type: 'Plains', ownerId: 'p1' }), makeTile({ coord: NEW_TILE, type: 'Forest', ownerId: null })];
  const state = fixtureState([p1], tiles, {
    currentPhase: opts.currentPhase ?? Phase.Fight,
    hasFoughtThisTurn: opts.hasFoughtThisTurn ?? false,
    pendingDoorMonster: { heroId: hero.id, coord: NEW_TILE, monsterCardId: monster.id },
    monsterDeck: opts.monsterDeck ?? { drawPile: [], discardPile: [] },
    lootDeck: opts.lootDeck ?? lootDeckWith(lootRarityForMonsterLevel(monster.level), [{ ...TEST_LOOT_COMMON, rarity: lootRarityForMonsterLevel(monster.level) }]),
    badStuffDeck: opts.badStuffDeck ?? { drawPile: [TEST_BADSTUFF], discardPile: [] },
  });
  return { state, monster, heroId: hero.id };
}

function fightDoorMonster(state: GameState, monster: MonsterCard, heroId: string) {
  return applyAction(state, { type: 'Fight', actorId: 'p1', heroId, combatType: 'HeroVsMonster', coord: NEW_TILE, monsterCardId: monster.id });
}

describe('The mandatory Door-monster fight gate', () => {
  it('applyAdvancePhase refuses to leave Phase 4 while a Door monster is pending', () => {
    const { state } = pendingFightState({ outcome: 'win', currentPhase: Phase.Fight });
    expect(() => applyAction(state, { type: 'AdvancePhase', actorId: 'p1' })).toThrow(IllegalActionError);
    expect(() => applyAction(state, { type: 'AdvancePhase', actorId: 'p1' })).toThrow(/door monster/i);
  });

  it.each([Phase.Production, Phase.DrawAndPlaceTile, Phase.MoveHero, Phase.Gather, Phase.Fight, Phase.Build])(
    'EndTurn refuses to end the turn from ANY phase (phase %i) while it is pending',
    (phase) => {
      const { state } = pendingFightState({ outcome: 'win', currentPhase: phase });
      expect(() => applyAction(state, { type: 'EndTurn', actorId: 'p1' })).toThrow(IllegalActionError);
      expect(() => applyAction(state, { type: 'EndTurn', actorId: 'p1' })).toThrow(/door monster/i);
    }
  );

  it('AdvancePhase stepping past Build (which also ends the turn) is blocked the same way', () => {
    const { state } = pendingFightState({ outcome: 'win', currentPhase: Phase.Build });
    expect(() => applyAction(state, { type: 'AdvancePhase', actorId: 'p1' })).toThrow(IllegalActionError);
  });

  it('resolving it with a WIN clears pendingDoorMonster, then AdvancePhase/EndTurn work normally', () => {
    const { state, monster, heroId } = pendingFightState({ outcome: 'win' });
    const resolved = fightDoorMonster(state, monster, heroId);
    expect(resolved.pendingDoorMonster).toBeNull();

    const advanced = applyAction(resolved, { type: 'AdvancePhase', actorId: 'p1' });
    expect(advanced.currentPhase).toBe(Phase.Build);

    const ended = applyAction(resolved, { type: 'EndTurn', actorId: 'p1' });
    expect(ended.eventLog.some((e) => e.type === 'TurnEnded')).toBe(true);
  });

  it('resolving it with a LOSS also clears pendingDoorMonster, then AdvancePhase/EndTurn work normally', () => {
    const { state, monster, heroId } = pendingFightState({ outcome: 'lose' });
    const resolved = fightDoorMonster(state, monster, heroId);
    expect(resolved.pendingDoorMonster).toBeNull();

    const advanced = applyAction(resolved, { type: 'AdvancePhase', actorId: 'p1' });
    expect(advanced.currentPhase).toBe(Phase.Build);

    const ended = applyAction(resolved, { type: 'EndTurn', actorId: 'p1' });
    expect(ended.eventLog.some((e) => e.type === 'TurnEnded')).toBe(true);
  });
});

// ── 5. applyFightMonster's dual-source handling ─────────────────────────────────────────────

describe('Fight: Door-sourced HeroVsMonster is a distinct source from a Ruins Den', () => {
  it('is exempt from hasFoughtThisTurn — a hero who already fought this turn can still resolve it', () => {
    const { state, monster, heroId } = pendingFightState({ outcome: 'win', hasFoughtThisTurn: true });
    const resolved = fightDoorMonster(state, monster, heroId);
    expect(resolved.pendingDoorMonster).toBeNull();
    expect(resolved.hasFoughtThisTurn).toBe(true); // was already true, stays true
    expect(eventsOfType(resolved, 'CombatResolved')).toHaveLength(1);
  });

  it('rejects a monsterCardId matching NEITHER a Ruins Den here NOR the pending Door monster', () => {
    const { state, heroId } = pendingFightState({ outcome: 'win' });
    // A real, different catalog monster — not the one that's pending, and this tile isn't Ruins.
    const otherMonster = MONSTER_CATALOG.find((m) => m.id !== SOME_MONSTER.id)!;
    expect(() =>
      applyAction(state, { type: 'Fight', actorId: 'p1', heroId, combatType: 'HeroVsMonster', coord: NEW_TILE, monsterCardId: otherMonster.id })
    ).toThrow(IllegalActionError);
    expect(() =>
      applyAction(state, { type: 'Fight', actorId: 'p1', heroId, combatType: 'HeroVsMonster', coord: NEW_TILE, monsterCardId: otherMonster.id })
    ).toThrow(/does not match/i);
  });

  it('a WIN draws Treasure and discards the monster to doorDeck — monsterDeck is untouched', () => {
    const { state, monster, heroId } = pendingFightState({ outcome: 'win' });
    const rarity = lootRarityForMonsterLevel(monster.level);
    const before = state.players[0].hero.xp;

    const resolved = fightDoorMonster(state, monster, heroId);
    const hero = resolved.players[0].hero;

    expect(hero.inventory).toHaveLength(1);
    expect(hero.inventory[0].rarity).toBe(rarity);
    expect(resolved.lootDeck.drawPiles[rarity]).toHaveLength(0); // the seeded card was drawn
    expect(hero.xp).toBe(before + monster.level); // win XP = monster level

    expect(resolved.monsterDeck).toEqual({ drawPile: [], discardPile: [] }); // never touched
    expect(resolved.doorDeck.discardPile).toEqual([{ kind: 'Monster', monster }]);
    expect(resolved.doorDeck.drawPile).toHaveLength(0);

    const combat = eventsOfType(resolved, 'CombatResolved');
    expect(combat[0].payload).toMatchObject({ win: true, source: 'Door', monsterId: monster.id });
  });

  it('a LOSS also clears pendingDoorMonster — a Door encounter never persists like a Ruins Den does', () => {
    const { state, monster, heroId } = pendingFightState({ outcome: 'lose' });
    const before = state.players[0].hero;

    const resolved = fightDoorMonster(state, monster, heroId);
    const hero = resolved.players[0].hero;

    expect(resolved.pendingDoorMonster).toBeNull();
    expect(hero.hp).toBe(before.hp - monster.level); // MONSTER_HP_DAMAGE_EQUALS_LEVEL
    expect(hero.activeCurses).toHaveLength(1);
    expect(hero.activeCurses[0]).toEqual(TEST_BADSTUFF);

    expect(resolved.monsterDeck).toEqual({ drawPile: [], discardPile: [] }); // untouched either way
    expect(resolved.doorDeck.discardPile).toEqual([{ kind: 'Monster', monster }]);

    const combat = eventsOfType(resolved, 'CombatResolved');
    expect(combat[0].payload).toMatchObject({ win: false, source: 'Door' });
  });
});

// ── 6. Deck reshuffle and genuine exhaustion ────────────────────────────────────────────────

describe('drawDoor: reshuffle and exhaustion (decks.ts, direct)', () => {
  it('reshuffles the discard pile into the draw pile once the draw pile runs dry', () => {
    const cardA = monsterDoorCard(SOME_MONSTER);
    const cardB = utilityDoorCard('Nothing', undefined, 'card-b');
    const cardC = utilityDoorCard('GainGold', 1, 'card-c');
    const deck: DoorDeckState = { drawPile: [], discardPile: [cardA, cardB, cardC] };
    const rng = new RngStream('reshuffle-seed', 0);

    const { card, deck: nextDeck } = drawDoor(deck, rng);

    expect(card).not.toBeNull();
    expect([cardA, cardB, cardC]).toContainEqual(card);
    expect(nextDeck.discardPile).toEqual([]); // fully moved into the draw pile before the draw
    expect(nextDeck.drawPile).toHaveLength(2); // one of the three was drawn back out
    const remaining = [cardA, cardB, cardC].filter((c) => c !== card);
    expect(nextDeck.drawPile).toEqual(expect.arrayContaining(remaining));
  });

  it('returns card: null and leaves the deck untouched when genuinely exhausted (both piles empty)', () => {
    const deck: DoorDeckState = { drawPile: [], discardPile: [] };
    const rng = new RngStream('exhausted-seed', 0);
    const { card, deck: nextDeck } = drawDoor(deck, rng);
    expect(card).toBeNull();
    expect(nextDeck).toEqual({ drawPile: [], discardPile: [] });
  });
});

describe('resolveDoorCardIfNewTile: exhaustion and reshuffle through the real turn flow', () => {
  it('a genuinely exhausted door deck (both piles empty) is "no encounter" — does not throw', () => {
    const state = moveFixture({ doorDeck: { drawPile: [], discardPile: [] } });
    const after = moveOnto(state, NEW_TILE);

    expect(after.players[0].hero.visitedTiles).toContain(hexKey(NEW_TILE)); // still marked visited
    expect(after.pendingDoorMonster).toBeNull();
    expect(after.doorDeck).toEqual({ drawPile: [], discardPile: [] });
    expect(eventsOfType(after, 'DoorCardDrawn')).toHaveLength(0);
    expect(eventsOfType(after, 'HeroMoved')).toHaveLength(1);
  });

  it('drawing continues to work after a reshuffle triggered by a real move', () => {
    const doorDeck: DoorDeckState = {
      drawPile: [],
      discardPile: [utilityDoorCard('Nothing', undefined, 'd1'), utilityDoorCard('Nothing', undefined, 'd2')],
    };
    const state = moveFixture({ doorDeck });
    const after = moveOnto(state, NEW_TILE);

    // One card was drawn out of the reshuffled two and immediately resolved+discarded again —
    // total card count is conserved across both piles.
    expect(after.doorDeck.drawPile.length + after.doorDeck.discardPile.length).toBe(2);
    expect(after.doorDeck.discardPile).toHaveLength(1);
    expect(eventsOfType(after, 'DoorCardDrawn')).toHaveLength(1);
    expect(after.rngCursor).toBeGreaterThan(state.rngCursor); // the reshuffle itself drew rng
  });
});
