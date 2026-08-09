import { describe, expect, it } from 'vitest';
import { lootRarityForMonsterLevel, tileDeckSize, TILE_DECK_COMPOSITION, xpToReachNextLevel } from '../constants';

describe('§8.1 XP formula — cumulative table matches docs/rules-reference.md exactly', () => {
  const cumulative: Record<number, number> = { 2: 3, 3: 9, 4: 18, 5: 30, 6: 45, 7: 63, 8: 84, 9: 108, 10: 135 };

  it('per-level cost is currentLevel * 3', () => {
    expect(xpToReachNextLevel(1)).toBe(3);
    expect(xpToReachNextLevel(9)).toBe(27);
  });

  it('cumulative XP to reach each level matches the doc table', () => {
    for (let level = 1; level < 10; level++) {
      let total = 0;
      for (let l = 1; l <= level; l++) total += xpToReachNextLevel(l);
      expect(total).toBe(cumulative[level + 1]);
    }
  });
});

describe('§6.1 Monster Level -> Loot Rarity brackets', () => {
  it.each([
    [1, 'Common'],
    [2, 'Common'],
    [3, 'Uncommon'],
    [4, 'Uncommon'],
    [5, 'Rare'],
    [6, 'Rare'],
    [7, 'Rare'],
    [8, 'Legendary'],
    [9, 'Legendary'],
    [10, 'Legendary'],
  ] as const)('level %i -> %s', (level, expected) => {
    expect(lootRarityForMonsterLevel(level)).toBe(expected);
  });
});

describe('§3.3 tile deck', () => {
  it('deck size formula: 100 @ 2p, 180 @ 6p', () => {
    expect(tileDeckSize(2)).toBe(100);
    expect(tileDeckSize(6)).toBe(180);
    expect(tileDeckSize(4)).toBe(140);
  });

  it('composition percentages sum to 100', () => {
    const total = Object.values(TILE_DECK_COMPOSITION).reduce((a, b) => a + b, 0);
    expect(total).toBe(100);
  });
});
