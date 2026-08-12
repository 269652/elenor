import { describe, expect, it } from 'vitest';
import { applyAction } from '../reducer';
import { resolveArmyVsTerritory } from '../combat';
import { RngStream } from '../rng';
import { tierOf, tileAt } from '../selectors';
import {
  BARRACKS_TIERS,
  CAPITAL_TIERS,
  LOOT_SELL_TROOPS,
  SMITHY_CRAFT_COSTS,
  VP_CAPITAL_TIER,
  WATCHTOWER_TIERS,
} from '../constants';
import { emptyResourceBundle, hexKey, IllegalActionError, Phase } from '../types';
import type { GameState, LootCard, Player, ResourceBundle, Tile } from '../types';
import { makePlayer, makeTile } from './testUtils';

/** Hand-built GameState, same pattern as balanceRework.test.ts's fixtureState. */
function fixtureState(players: Player[], tiles: Tile[], overrides: Partial<GameState> = {}): GameState {
  const map: Record<string, Tile> = {};
  for (const t of tiles) map[hexKey(t.coord)] = t;
  return {
    gameId: 'g-lategame',
    mode: 'hotseat',
    status: 'active',
    rngSeed: 'lategame-seed',
    rngCursor: 0,
    roundNumber: 20, // well past every minRound gate — not what these tests are about
    turnOrder: players.map((p) => p.id),
    currentPlayerId: players[0].id,
    currentPhase: Phase.Build,
    map,
    roads: {},
    players,
    tileDeck: { drawPile: [], discardPile: [] },
    monsterDeck: { drawPile: [], discardPile: [] },
    lootDeck: {
      drawPiles: {
        Common: [{ id: 'loot-c1', name: 'Rusty Dagger', rarity: 'Common', combatBonus: 1 }],
        Uncommon: [],
        Rare: [],
        Legendary: [],
      },
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
    heroCoordBeforeMoveThisTurn: null,
    ...overrides,
  };
}

const RICH_WALLET: ResourceBundle = { Wood: 99, Stone: 99, Food: 99, Ore: 99, Meat: 99, Gold: 99 };

// ── CraftGear [DEFAULT — balance rework pass 4] ─────────────────────────────────────────────

describe('CraftGear — Smithy crafting', () => {
  const capital = { q: 0, r: 0 };
  const smithyCoord = { q: 1, r: 0 };

  function smithyFixture(resources: Partial<ResourceBundle> = RICH_WALLET) {
    const p1 = makePlayer({ id: 'p1', capitalTile: capital, ownedTiles: [capital, smithyCoord], resources });
    const tiles: Tile[] = [
      makeTile({ coord: capital, type: 'Plains', ownerId: 'p1' }),
      makeTile({
        coord: smithyCoord,
        type: 'Mountain',
        ownerId: 'p1',
        building: { id: 'smithy-1', type: 'Smithy', coord: smithyCoord, ownerId: 'p1' },
      }),
    ];
    const p = { ...p1, hero: { ...p1.hero, position: smithyCoord } };
    return fixtureState([p], tiles);
  }

  it('spends SMITHY_CRAFT_COSTS.Common and adds a guaranteed Common card to inventory', () => {
    const state = smithyFixture();
    const before = state.players[0].resources;
    const after = applyAction(state, { type: 'CraftGear', actorId: 'p1', coord: smithyCoord, rarity: 'Common' });
    const p = after.players[0];
    expect(p.hero.inventory).toHaveLength(1);
    expect(p.hero.inventory[0].rarity).toBe('Common');
    expect(p.resources.Ore).toBe(before.Ore - SMITHY_CRAFT_COSTS.Common.Ore!);
    expect(p.resources.Gold).toBe(before.Gold - SMITHY_CRAFT_COSTS.Common.Gold!);
  });

  it('is a FREE action — does not consume the turn\'s one Build slot', () => {
    const state = { ...smithyFixture(), hasBuiltThisTurn: true };
    const after = applyAction(state, { type: 'CraftGear', actorId: 'p1', coord: smithyCoord, rarity: 'Common' });
    expect(after.hasBuiltThisTurn).toBe(true); // unchanged, still available for a real Build action
    expect(after.players[0].hero.inventory).toHaveLength(1);
  });

  it('rejects crafting on a tile without a Smithy', () => {
    const state = smithyFixture();
    expect(() => applyAction(state, { type: 'CraftGear', actorId: 'p1', coord: capital, rarity: 'Common' })).toThrow(IllegalActionError);
  });

  it('rejects crafting when the hero is not physically standing at the Smithy', () => {
    const state = smithyFixture();
    const away = { ...state, players: [{ ...state.players[0], hero: { ...state.players[0].hero, position: capital } }] };
    expect(() => applyAction(away, { type: 'CraftGear', actorId: 'p1', coord: smithyCoord, rarity: 'Common' })).toThrow(IllegalActionError);
  });

  it('rejects an unaffordable rarity', () => {
    const state = smithyFixture({ Ore: 0, Gold: 0 });
    expect(() => applyAction(state, { type: 'CraftGear', actorId: 'p1', coord: smithyCoord, rarity: 'Legendary' })).toThrow(IllegalActionError);
  });

  it('an exhausted rarity resolves empty-handed rather than throwing — resources are still spent (§5.3)', () => {
    const state = smithyFixture();
    const before = state.players[0].resources;
    const after = applyAction(state, { type: 'CraftGear', actorId: 'p1', coord: smithyCoord, rarity: 'Uncommon' }); // drawPiles.Uncommon is empty
    expect(after.players[0].hero.inventory).toHaveLength(0);
    expect(after.players[0].resources.Ore).toBe(before.Ore - SMITHY_CRAFT_COSTS.Uncommon.Ore!);
  });
});

// ── SellLoot — gear for troops [DEFAULT — balance rework pass 4, direct request] ────────────

describe('SellLoot — CraftGear\'s inverse, gear for troops at a Barracks', () => {
  const capital = { q: 0, r: 0 };
  const barracksCoord = { q: 1, r: 0 };
  const card: LootCard = { id: 'loot-x', name: 'Old Trophy', rarity: 'Uncommon', combatBonus: 2 };

  function barracksFixture(militiaCount = 0) {
    const p1 = makePlayer({ id: 'p1', capitalTile: capital, ownedTiles: [capital, barracksCoord] });
    const tiles: Tile[] = [
      makeTile({ coord: capital, type: 'Plains', ownerId: 'p1' }),
      makeTile({
        coord: barracksCoord,
        type: 'Plains',
        ownerId: 'p1',
        militiaCount,
        building: { id: 'barracks-1', type: 'Barracks', coord: barracksCoord, ownerId: 'p1' },
      }),
    ];
    const heroWithCard = { ...p1.hero, position: barracksCoord, inventory: [card] };
    return fixtureState([{ ...p1, hero: heroWithCard }], tiles);
  }

  it('removes the card and grants LOOT_SELL_TROOPS[rarity] Soldiers to the Barracks reserve', () => {
    const state = barracksFixture(2);
    const after = applyAction(state, { type: 'SellLoot', actorId: 'p1', lootCardId: 'loot-x', coord: barracksCoord });
    const p = after.players[0];
    expect(p.hero.inventory).toHaveLength(0);
    expect(tileAt(after, barracksCoord)!.militiaCount).toBe(2 + LOOT_SELL_TROOPS.Uncommon);
  });

  it('unequips the card as part of the sale if it was equipped', () => {
    const state = barracksFixture(0);
    const withEquip = {
      ...state,
      players: [{ ...state.players[0], hero: { ...state.players[0].hero, equippedLootIds: ['loot-x'] } }],
    };
    const after = applyAction(withEquip, { type: 'SellLoot', actorId: 'p1', lootCardId: 'loot-x', coord: barracksCoord });
    expect(after.players[0].hero.equippedLootIds).not.toContain('loot-x');
  });

  it('is a FREE action — does not consume the turn\'s one Build slot', () => {
    const state = { ...barracksFixture(0), hasBuiltThisTurn: true };
    const after = applyAction(state, { type: 'SellLoot', actorId: 'p1', lootCardId: 'loot-x', coord: barracksCoord });
    expect(after.hasBuiltThisTurn).toBe(true);
  });

  it('rejects when the Barracks reserve is already at its tier cap', () => {
    const state = barracksFixture(BARRACKS_TIERS[0].reserveCap);
    expect(() => applyAction(state, { type: 'SellLoot', actorId: 'p1', lootCardId: 'loot-x', coord: barracksCoord })).toThrow(
      IllegalActionError
    );
  });

  it('rejects a card the hero does not own', () => {
    const state = barracksFixture(0);
    expect(() => applyAction(state, { type: 'SellLoot', actorId: 'p1', lootCardId: 'not-owned', coord: barracksCoord })).toThrow(
      IllegalActionError
    );
  });

  it('rejects selling into a Barracks a rival garrison currently occupies', () => {
    const state = barracksFixture(3);
    const occupied = {
      ...state,
      map: { ...state.map, [hexKey(barracksCoord)]: { ...state.map[hexKey(barracksCoord)], garrisonOwnerId: 'rival' } },
    };
    expect(() => applyAction(occupied, { type: 'SellLoot', actorId: 'p1', lootCardId: 'loot-x', coord: barracksCoord })).toThrow(
      IllegalActionError
    );
  });
});

// ── Watchtower upgrade tiers [DEFAULT — balance rework pass 4] ─────────────────────────────

describe('Watchtower upgrade tiers', () => {
  const capital = { q: 0, r: 0 };
  const wtCoord = { q: 1, r: 0 };

  function watchtowerFixture(tier?: number) {
    const p1 = makePlayer({ id: 'p1', capitalTile: capital, ownedTiles: [capital, wtCoord], resources: RICH_WALLET });
    const tiles: Tile[] = [
      makeTile({ coord: capital, type: 'Plains', ownerId: 'p1' }),
      makeTile({ coord: wtCoord, type: 'Plains', ownerId: 'p1', building: { id: 'wt-1', type: 'Watchtower', coord: wtCoord, ownerId: 'p1', tier } }),
    ];
    return fixtureState([p1], tiles);
  }

  it('upgrades from tier 1 to tier 2, spending WATCHTOWER_TIERS[1].cost', () => {
    const state = watchtowerFixture();
    const before = state.players[0].resources;
    const after = applyAction(state, { type: 'UpgradeBuilding', actorId: 'p1', coord: wtCoord });
    expect(tierOf(tileAt(after, wtCoord)!.building!)).toBe(2);
    expect(after.players[0].resources.Stone).toBe(before.Stone - WATCHTOWER_TIERS[1].cost.Stone!);
  });

  it('cannot upgrade past tier 3 (max)', () => {
    const state = watchtowerFixture(3);
    expect(() => applyAction(state, { type: 'UpgradeBuilding', actorId: 'p1', coord: wtCoord })).toThrow(IllegalActionError);
  });

  it('a tiered Watchtower actually changes the §6.3 defending-die math (combat.ts)', () => {
    // Tier 3's dieBonus/dieCap (3 / cap 8) must strictly dominate tier 1's (1 / cap 6) — sample
    // enough cursors that the two distributions can't tie by chance.
    let tier1Total = 0;
    let tier3Total = 0;
    for (let c = 0; c < 300; c += 3) {
      tier1Total += resolveArmyVsTerritory(0, 1, 1, new RngStream('wt-seed', c)).defenderRolls[0];
      tier3Total += resolveArmyVsTerritory(0, 1, 3, new RngStream('wt-seed', c)).defenderRolls[0];
    }
    expect(tier3Total).toBeGreaterThan(tier1Total);
  });
});

// ── Barracks upgrade tiers [DEFAULT — balance rework pass 4] ───────────────────────────────

describe('Barracks upgrade tiers', () => {
  const capital = { q: 0, r: 0 };
  const barracksCoord = { q: 1, r: 0 };

  function barracksFixture(tier?: number) {
    const p1 = makePlayer({ id: 'p1', capitalTile: capital, ownedTiles: [capital, barracksCoord], resources: RICH_WALLET });
    const tiles: Tile[] = [
      makeTile({ coord: capital, type: 'Plains', ownerId: 'p1' }),
      makeTile({
        coord: barracksCoord,
        type: 'Plains',
        ownerId: 'p1',
        building: { id: 'b-1', type: 'Barracks', coord: barracksCoord, ownerId: 'p1', tier },
      }),
    ];
    return fixtureState([p1], tiles);
  }

  it('upgrades from tier 1 to tier 2, spending BARRACKS_TIERS[1].cost', () => {
    const state = barracksFixture();
    const before = state.players[0].resources;
    const after = applyAction(state, { type: 'UpgradeBuilding', actorId: 'p1', coord: barracksCoord });
    expect(tierOf(tileAt(after, barracksCoord)!.building!)).toBe(2);
    expect(after.players[0].resources.Wood).toBe(before.Wood - BARRACKS_TIERS[1].cost.Wood!);
  });

  it('cannot upgrade past tier 3 (max)', () => {
    const state = barracksFixture(3);
    expect(() => applyAction(state, { type: 'UpgradeBuilding', actorId: 'p1', coord: barracksCoord })).toThrow(IllegalActionError);
  });

  it('a tier-3 Barracks recruits faster and holds a bigger reserve than tier 1 (accumulateTileProduction)', () => {
    // 6 owned tiles: soldiersPerRoundFor(6, tilesPerSoldier) — tier 1 divisor 3 -> 2/round,
    // tier 3 divisor 1 -> 6/round, and reserveCap climbs 9 -> 21 alongside it.
    const owned = [capital, barracksCoord, ...Array.from({ length: 4 }, (_, i) => ({ q: i + 2, r: 0 }))];
    function withOwnedTiles(tier?: number) {
      const p1 = makePlayer({ id: 'p1', capitalTile: capital, ownedTiles: owned, resources: { Food: 999 } });
      const tiles: Tile[] = owned.map((c) => makeTile({ coord: c, type: 'Plains', ownerId: 'p1' }));
      tiles[1] = makeTile({
        coord: barracksCoord,
        type: 'Plains',
        ownerId: 'p1',
        building: { id: 'b-1', type: 'Barracks', coord: barracksCoord, ownerId: 'p1', tier },
      });
      // accumulateTileProduction fires on ENTERING Phase.Gather (not leaving it) — start one
      // phase earlier (Fight, now that Fight/Gather swapped places — see types.ts's Phase enum)
      // so AdvancePhase below actually crosses that boundary.
      return fixtureState([p1], tiles, { currentPhase: Phase.Fight, hasMovedThisTurn: true, roundNumber: 20 });
    }
    const tier1After = applyAction(withOwnedTiles(1), { type: 'AdvancePhase', actorId: 'p1' });
    const tier3After = applyAction(withOwnedTiles(3), { type: 'AdvancePhase', actorId: 'p1' });
    const tier1Militia = tileAt(tier1After, barracksCoord)!.militiaCount ?? 0;
    const tier3Militia = tileAt(tier3After, barracksCoord)!.militiaCount ?? 0;
    expect(tier3Militia).toBeGreaterThan(tier1Militia);
  });
});

// ── Capital tier 6, "the Grand Bazaar" [DEFAULT — balance rework pass 4] ───────────────────

describe('Capital tier 6 — the Grand Bazaar wonder capstone', () => {
  const capital = { q: 0, r: 0 };

  function capitalFixture(capitalTier: number) {
    const p1 = makePlayer({ id: 'p1', capitalTile: capital, ownedTiles: [capital], capitalTier, resources: RICH_WALLET });
    const tiles: Tile[] = [
      makeTile({ coord: capital, type: 'Plains', ownerId: 'p1', building: { id: 'cap', type: 'Capital', coord: capital, ownerId: 'p1', tier: capitalTier } }),
    ];
    return fixtureState([p1], tiles);
  }

  it('a tier-5 Capital can buy tier 6, paying CAPITAL_TIERS[5].cost and gaining its HP bonus', () => {
    const state = capitalFixture(5);
    const beforeHp = state.players[0].hero.maxHp;
    const after = applyAction(state, { type: 'Build', actorId: 'p1', buildingType: 'Capital', coord: capital });
    expect(after.players[0].capitalTier).toBe(6);
    expect(after.players[0].hero.maxHp).toBe(beforeHp + CAPITAL_TIERS[5].heroMaxHpBonus);
  });

  it('a tier-6 Capital cannot upgrade further — "already at max tier (6)"', () => {
    const state = capitalFixture(6);
    expect(() => applyAction(state, { type: 'Build', actorId: 'p1', buildingType: 'Capital', coord: capital })).toThrow(/max tier \(6\)/);
  });

  it('tier 6 pays its own, larger VP_CAPITAL_TIER row', () => {
    expect(VP_CAPITAL_TIER[6]).toBeGreaterThan(VP_CAPITAL_TIER[5]);
  });
});
