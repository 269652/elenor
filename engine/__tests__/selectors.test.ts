import { describe, expect, it } from 'vitest';
import { checkWinConditions, computeVictoryPoints, maxTierFor, nextUpgradeFor, produceAmountForTier, tierOf } from '../selectors';
import { BUILDING_DEFINITIONS, WIN_HERO_LEVEL_THRESHOLD, WIN_MIN_ROUND, WIN_VP_THRESHOLD } from '../constants';
import type { GameState } from '../types';
import { Phase } from '../types';
import { makeHero, makePlayer, makeTile } from './testUtils';

describe('§10 Victory Point Scoring', () => {
  it('sums owned tiles, capital tier, hero level milestones, and Legendary loot', () => {
    const player = makePlayer({
      ownedTiles: [{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 2, r: 0 }], // 3 tiles = +3
      capitalTier: 1, // +1 — the free starting Town; see VP_CAPITAL_TIER[1] (territory rework: 2 -> 1)
      hero: makeHero({ level: 5, inventory: [{ id: 'leg1', name: 'x', rarity: 'Legendary', combatBonus: 5 }] }), // level 5 -> +2, legendary -> +2
    });
    // 3 (tiles) + 1 (capital tier 1) + 1 (level>=3) + 2 (level>=5) + 2 (legendary loot) = 9
    expect(computeVictoryPoints(player)).toBe(9);
  });

  it('milestones stack cumulatively (a level 10 hero counts all four thresholds)', () => {
    const player = makePlayer({ ownedTiles: [{ q: 0, r: 0 }], hero: makeHero({ level: 10 }) });
    // 1 (tile) + 1 + 2 + 3 + 5 (all milestones) = 12
    expect(computeVictoryPoints(player)).toBe(12);
  });
});

/** Shared with the WIN_MIN_ROUND block below. Defaults roundNumber to WIN_MIN_ROUND because
 *  [DEFAULT — balance rework] no threshold win may trigger before then (see constants.ts) —
 *  tests about WHICH condition fires need to be past that floor, and the tests about the floor
 *  itself pass an explicit roundNumber override. */
function fixtureState(players: ReturnType<typeof makePlayer>[], overrides: Partial<GameState> = {}): GameState {
  return {
    gameId: 'g1',
    mode: 'hotseat',
    status: 'active',
    roads: {},
    rngSeed: 'seed',
    rngCursor: 0,
    roundNumber: WIN_MIN_ROUND,
    turnOrder: players.map((p) => p.id),
    currentPlayerId: players[0].id,
    currentPhase: Phase.Build,
    map: Object.fromEntries(players.flatMap((p) => p.ownedTiles.map((c) => [`${c.q},${c.r}`, makeTile({ coord: c, ownerId: p.id })]))),
    players,
    tileDeck: { drawPile: [], discardPile: [] },
    monsterDeck: { drawPile: [], discardPile: [] },
    lootDeck: { drawPiles: { Common: [], Uncommon: [], Rare: [], Legendary: [] }, discardPiles: { Common: [], Uncommon: [], Rare: [], Legendary: [] } },
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

describe('§11 Win condition trigger check', () => {
  it('no winner when nobody has crossed a threshold', () => {
    const players = [makePlayer({ id: 'p1', ownedTiles: [{ q: 0, r: 0 }] }), makePlayer({ id: 'p2', ownedTiles: [{ q: 5, r: 5 }] })];
    expect(checkWinConditions(fixtureState(players))).toBeNull();
  });

  it('a single player crossing VP threshold wins outright', () => {
    const tiles = Array.from({ length: WIN_VP_THRESHOLD }, (_, i) => ({ q: i, r: 0 }));
    const p1 = makePlayer({ id: 'p1', ownedTiles: tiles });
    // p2 needs enough tiles to hold p1 UNDER the 60% Domination share (30/51 = 0.588), or p1
    // would trigger both conditions at once and this test would silently be asserting the
    // multi-trigger tie-break instead of a clean VictoryPoints win. p2's 21 tiles are still
    // well short of WIN_VP_THRESHOLD, so p2 triggers nothing.
    const p2 = makePlayer({ id: 'p2', ownedTiles: Array.from({ length: 21 }, (_, i) => ({ q: i, r: 100 })) });
    const result = checkWinConditions(fixtureState([p1, p2]));
    expect(result).toEqual({ winnerId: 'p1', winCondition: 'VictoryPoints' });
  });

  it('does NOT trigger Domination on a barely-developed board just because one player owns most of the (tiny) map', () => {
    // Regression: a fresh 2-player game where p1 has placed one extra tile already clears a
    // naive 60% share (2 of 3 total tiles) despite the board having no meaningful territory
    // yet — caught by AI-vs-AI integration testing, see WIN_DOMINATION_MIN_TILES_PER_PLAYER.
    const p1 = makePlayer({ id: 'p1', ownedTiles: [{ q: 0, r: 0 }, { q: 1, r: 0 }] });
    const p2 = makePlayer({ id: 'p2', ownedTiles: [{ q: 5, r: 5 }] });
    expect(checkWinConditions(fixtureState([p1, p2]))).toBeNull();
  });

  it('DOES trigger Domination once the board is developed enough for a 60% share to mean something', () => {
    const minTiles = 8 * 2; // WIN_DOMINATION_MIN_TILES_PER_PLAYER * 2 players
    const p1Tiles = Array.from({ length: Math.ceil(minTiles * 0.65) }, (_, i) => ({ q: i, r: 0 }));
    const p2Tiles = Array.from({ length: minTiles - p1Tiles.length }, (_, i) => ({ q: i, r: 5 }));
    const p1 = makePlayer({ id: 'p1', ownedTiles: p1Tiles });
    const p2 = makePlayer({ id: 'p2', ownedTiles: p2Tiles });
    const result = checkWinConditions(fixtureState([p1, p2]));
    expect(result?.winnerId).toBe('p1');
    expect(result?.winCondition).toBe('Domination');
  });

  it('eliminating the only rival always wins Domination, even on a tiny board', () => {
    const p1 = makePlayer({ id: 'p1', ownedTiles: [{ q: 0, r: 0 }] });
    const p2 = makePlayer({ id: 'p2', ownedTiles: [{ q: 1, r: 0 }], isEliminated: true });
    const result = checkWinConditions(fixtureState([p1, p2]));
    expect(result?.winnerId).toBe('p1');
    expect(result?.winCondition).toBe('Domination');
  });

  it('hero reaching Level 10 triggers HeroLevelRace', () => {
    const p1 = makePlayer({ id: 'p1', ownedTiles: [{ q: 0, r: 0 }], hero: makeHero({ level: 10 }) });
    const p2 = makePlayer({ id: 'p2', ownedTiles: [{ q: 1, r: 0 }] });
    const result = checkWinConditions(fixtureState([p1, p2]));
    expect(result?.winnerId).toBe('p1');
    expect(result?.winCondition).toBe('HeroLevelRace');
  });

  it('when two players trigger in the same round, higher VP wins the tie-break', () => {
    const bigTiles = Array.from({ length: WIN_VP_THRESHOLD }, (_, i) => ({ q: i, r: 0 }));
    const smallTiles = Array.from({ length: WIN_VP_THRESHOLD }, (_, i) => ({ q: i, r: 10 }));
    const p1 = makePlayer({ id: 'p1', ownedTiles: bigTiles, hero: makeHero({ level: 10 }) }); // extra VP from level milestones
    const p2 = makePlayer({ id: 'p2', ownedTiles: smallTiles });
    const result = checkWinConditions(fixtureState([p1, p2]));
    expect(result?.winnerId).toBe('p1'); // p1 has strictly more VP (milestones) despite both crossing WIN_VP_THRESHOLD
  });

  it('if VP is also tied, earlier turn-order position wins', () => {
    const tiles = Array.from({ length: WIN_VP_THRESHOLD }, (_, i) => ({ q: i, r: 0 }));
    const p1 = makePlayer({ id: 'p1', ownedTiles: tiles });
    const p2 = makePlayer({ id: 'p2', ownedTiles: tiles.map((t) => ({ q: t.q, r: t.r + 20 })) });
    const state = fixtureState([p1, p2]);
    state.turnOrder = ['p2', 'p1']; // p2 earlier in turn order despite identical VP
    const result = checkWinConditions(state);
    expect(result?.winnerId).toBe('p2');
  });
});

describe('§11 WIN_MIN_ROUND floor (balance rework)', () => {
  /** Enough tiles for p1 to clear WIN_VP_THRESHOLD on owned-tile VP alone, plus enough tiles
   *  for p2 to keep p1 under the 60% Domination share — so the ONLY thing under test is the
   *  VictoryPoints trigger and its round gate. */
  function vpRunawayPlayers() {
    const p1 = makePlayer({ id: 'p1', ownedTiles: Array.from({ length: WIN_VP_THRESHOLD }, (_, i) => ({ q: i, r: 0 })) });
    const p2 = makePlayer({ id: 'p2', ownedTiles: Array.from({ length: 21 }, (_, i) => ({ q: i, r: 100 })) });
    return [p1, p2];
  }

  it('a player past WIN_VP_THRESHOLD does NOT win the round before WIN_MIN_ROUND', () => {
    const state = fixtureState(vpRunawayPlayers(), { roundNumber: WIN_MIN_ROUND - 1 });
    // Sanity: the VP really is over the line — this is a round gate, not a scoring shortfall.
    expect(computeVictoryPoints(state.players[0])).toBeGreaterThanOrEqual(WIN_VP_THRESHOLD);
    expect(checkWinConditions(state)).toBeNull();
  });

  it('the same player DOES win once WIN_MIN_ROUND is reached', () => {
    const state = fixtureState(vpRunawayPlayers(), { roundNumber: WIN_MIN_ROUND });
    expect(checkWinConditions(state)).toEqual({ winnerId: 'p1', winCondition: 'VictoryPoints' });
  });

  it('stays won on every round after WIN_MIN_ROUND too (the gate is a floor, not a window)', () => {
    const state = fixtureState(vpRunawayPlayers(), { roundNumber: WIN_MIN_ROUND + 7 });
    expect(checkWinConditions(state)?.winCondition).toBe('VictoryPoints');
  });

  it('a max-level hero does NOT trigger HeroLevelRace before WIN_MIN_ROUND', () => {
    const p1 = makePlayer({ id: 'p1', ownedTiles: [{ q: 0, r: 0 }], hero: makeHero({ level: WIN_HERO_LEVEL_THRESHOLD }) });
    const p2 = makePlayer({ id: 'p2', ownedTiles: [{ q: 1, r: 0 }] });
    expect(checkWinConditions(fixtureState([p1, p2], { roundNumber: WIN_MIN_ROUND - 1 }))).toBeNull();
  });

  it('the same max-level hero DOES trigger HeroLevelRace at WIN_MIN_ROUND', () => {
    const p1 = makePlayer({ id: 'p1', ownedTiles: [{ q: 0, r: 0 }], hero: makeHero({ level: WIN_HERO_LEVEL_THRESHOLD }) });
    const p2 = makePlayer({ id: 'p2', ownedTiles: [{ q: 1, r: 0 }] });
    const result = checkWinConditions(fixtureState([p1, p2], { roundNumber: WIN_MIN_ROUND }));
    expect(result).toEqual({ winnerId: 'p1', winCondition: 'HeroLevelRace' });
  });

  it('a 60%+ tile share on a developed board is gated too', () => {
    const minTiles = 8 * 2; // WIN_DOMINATION_MIN_TILES_PER_PLAYER * 2 players
    const p1Tiles = Array.from({ length: Math.ceil(minTiles * 0.65) }, (_, i) => ({ q: i, r: 0 }));
    const p2Tiles = Array.from({ length: minTiles - p1Tiles.length }, (_, i) => ({ q: i, r: 5 }));
    const players = [makePlayer({ id: 'p1', ownedTiles: p1Tiles }), makePlayer({ id: 'p2', ownedTiles: p2Tiles })];
    expect(checkWinConditions(fixtureState(players, { roundNumber: WIN_MIN_ROUND - 1 }))).toBeNull();
    expect(checkWinConditions(fixtureState(players, { roundNumber: WIN_MIN_ROUND }))?.winCondition).toBe('Domination');
  });

  it('REGRESSION — eliminating every rival still wins immediately, exempt from WIN_MIN_ROUND', () => {
    // This exemption is deliberate (see constants.ts's WIN_MIN_ROUND and selectors.ts's
    // checkWinConditions): once nobody is left to play against, there is no mid-game left to
    // protect. Do not "fix" this by folding the elimination path back under pastMinRound.
    const p1 = makePlayer({ id: 'p1', ownedTiles: [{ q: 0, r: 0 }] });
    const p2 = makePlayer({ id: 'p2', ownedTiles: [{ q: 1, r: 0 }], isEliminated: true });
    const result = checkWinConditions(fixtureState([p1, p2], { roundNumber: 1 }));
    expect(result).toEqual({ winnerId: 'p1', winCondition: 'Domination' });
  });

  it('the elimination exemption holds in a multi-seat game with one survivor', () => {
    const p1 = makePlayer({ id: 'p1', ownedTiles: [{ q: 0, r: 0 }] });
    const p2 = makePlayer({ id: 'p2', ownedTiles: [{ q: 1, r: 0 }], isEliminated: true });
    const p3 = makePlayer({ id: 'p3', ownedTiles: [{ q: 2, r: 0 }], isEliminated: true });
    expect(checkWinConditions(fixtureState([p1, p2, p3], { roundNumber: 2 }))?.winnerId).toBe('p1');
  });

  it('one surviving player among several still-active rivals is NOT an elimination win', () => {
    const p1 = makePlayer({ id: 'p1', ownedTiles: [{ q: 0, r: 0 }] });
    const p2 = makePlayer({ id: 'p2', ownedTiles: [{ q: 1, r: 0 }], isEliminated: true });
    const p3 = makePlayer({ id: 'p3', ownedTiles: [{ q: 2, r: 0 }] });
    expect(checkWinConditions(fixtureState([p1, p2, p3], { roundNumber: 2 }))).toBeNull();
  });
});

describe('Building tier helpers (balance rework)', () => {
  const cowStable = BUILDING_DEFINITIONS.CowStable;
  const farm = BUILDING_DEFINITIONS.Farm;
  const quarry = BUILDING_DEFINITIONS.Quarry;
  const sawmill = BUILDING_DEFINITIONS.Sawmill;
  const watchtower = BUILDING_DEFINITIONS.Watchtower; // no producesResource/produceAmount at all

  describe('maxTierFor', () => {
    it('is 1 + the number of upgrade entries', () => {
      expect(maxTierFor(cowStable)).toBe(1 + cowStable.upgrades!.length);
      expect(maxTierFor(cowStable)).toBe(5);
      expect(maxTierFor(farm)).toBe(3);
      expect(maxTierFor(quarry)).toBe(3);
    });

    it('is 1 for a definition with no upgrades at all', () => {
      expect(sawmill.upgrades).toBeUndefined();
      expect(maxTierFor(sawmill)).toBe(1);
      expect(maxTierFor(watchtower)).toBe(1);
    });
  });

  describe('tierOf', () => {
    it('treats an absent tier as tier 1 (buildings are stored tier-less until first upgrade)', () => {
      expect(tierOf({})).toBe(1);
      expect(tierOf({ tier: undefined })).toBe(1);
    });

    it('returns the stored tier once one is set', () => {
      expect(tierOf({ tier: 2 })).toBe(2);
      expect(tierOf({ tier: 5 })).toBe(5);
    });
  });

  describe('produceAmountForTier', () => {
    it('walks CowStable 1 -> 5 as 1, 2, 3, 4, 5 Meat per round', () => {
      expect([1, 2, 3, 4, 5].map((t) => produceAmountForTier(cowStable, t))).toEqual([1, 2, 3, 4, 5]);
    });

    it('walks Farm and Quarry 1 -> 3 as 1, 2, 3', () => {
      expect([1, 2, 3].map((t) => produceAmountForTier(farm, t))).toEqual([1, 2, 3]);
      expect([1, 2, 3].map((t) => produceAmountForTier(quarry, t))).toEqual([1, 2, 3]);
    });

    it('clamps a tier above max to the max tier rate instead of returning undefined', () => {
      expect(produceAmountForTier(cowStable, 6)).toBe(5);
      expect(produceAmountForTier(cowStable, 99)).toBe(5);
      expect(produceAmountForTier(farm, 4)).toBe(3);
    });

    it('falls back to the base rate at or below tier 1, and for un-upgradable definitions', () => {
      expect(produceAmountForTier(cowStable, 0)).toBe(cowStable.produceAmount);
      expect(produceAmountForTier(cowStable, -3)).toBe(cowStable.produceAmount);
      expect(produceAmountForTier(sawmill, 1)).toBe(1);
      expect(produceAmountForTier(sawmill, 4)).toBe(1); // no upgrades — tier is irrelevant
    });

    it('returns 0 (never NaN/undefined) for a building that produces nothing', () => {
      expect(watchtower.produceAmount).toBeUndefined();
      expect(produceAmountForTier(watchtower, 1)).toBe(0);
      expect(produceAmountForTier(watchtower, 3)).toBe(0);
    });
  });

  describe('nextUpgradeFor', () => {
    it('returns each successive upgrade entry in order', () => {
      expect(nextUpgradeFor(cowStable, 1)).toEqual(cowStable.upgrades![0]);
      expect(nextUpgradeFor(cowStable, 2)).toEqual(cowStable.upgrades![1]);
      expect(nextUpgradeFor(cowStable, 3)).toEqual(cowStable.upgrades![2]);
      expect(nextUpgradeFor(cowStable, 4)).toEqual(cowStable.upgrades![3]);
      expect(nextUpgradeFor(farm, 2)).toEqual(farm.upgrades![1]);
    });

    it('returns null at max tier', () => {
      expect(nextUpgradeFor(cowStable, maxTierFor(cowStable))).toBeNull();
      expect(nextUpgradeFor(farm, 3)).toBeNull();
      expect(nextUpgradeFor(quarry, 3)).toBeNull();
    });

    it('returns null past max tier too, not an out-of-range entry', () => {
      expect(nextUpgradeFor(cowStable, 9)).toBeNull();
      expect(nextUpgradeFor(farm, 10)).toBeNull();
    });

    it('returns null for a definition with no upgrades at all', () => {
      expect(nextUpgradeFor(sawmill, 1)).toBeNull();
      expect(nextUpgradeFor(watchtower, 1)).toBeNull();
    });

    it("each entry's produceAmount matches produceAmountForTier at the tier it unlocks", () => {
      for (const def of [cowStable, farm, quarry]) {
        for (let tier = 1; tier < maxTierFor(def); tier++) {
          expect(nextUpgradeFor(def, tier)!.produceAmount).toBe(produceAmountForTier(def, tier + 1));
        }
      }
    });
  });
});
