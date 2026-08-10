import { describe, expect, it } from 'vitest';
import { resolveArmyVsTerritory, resolveHeroVsHero, resolveHeroVsMonster } from '../combat';
import { RngStream } from '../rng';
import type { MonsterCard } from '../types';
import { findCursorForAdvantageMax, findCursorForDie, makeHero, makePlayer } from './testUtils';

describe('§6.1 Hero vs Monster — worked examples reproduced exactly', () => {
  it('Worked Example 1 (win): Level 4, attack 1, +2 gear, Monster Level 5, roll 5 -> total 12 >= 8', () => {
    const seed = 'combat-ex-1';
    const cursor = findCursorForDie(seed, 5);
    const hero = makeHero({ level: 4, attack: 1, inventory: [{ id: 'l1', name: 'Test Uncommon', rarity: 'Uncommon', combatBonus: 2 }], equippedLootIds: ['l1'] });
    const player = makePlayer({ hero }, 'Farmer'); // non-Warrior, no extra die
    const monster: MonsterCard = { id: 'm1', name: 'Test Monster', level: 5, lootRarityOnWin: 'Rare' };

    const outcome = resolveHeroVsMonster(hero, player, monster, new RngStream(seed, cursor));

    expect(outcome.roll.dieRoll).toBe(5);
    expect(outcome.threshold).toBe(8);
    expect(outcome.roll.total).toBe(12);
    expect(outcome.win).toBe(true);
    expect(outcome.xpGained).toBe(5);
    expect(outcome.hpDamage).toBe(0);
  });

  it('Worked Example 2 (loss): Level 2, attack 1, no gear, Monster Level 7, roll 3 -> total 6 < 10', () => {
    const seed = 'combat-ex-2';
    const cursor = findCursorForDie(seed, 3);
    const hero = makeHero({ level: 2, attack: 1 });
    const player = makePlayer({ hero }, 'Farmer');
    const monster: MonsterCard = { id: 'm2', name: 'Test Monster', level: 7, lootRarityOnWin: 'Rare' };

    const outcome = resolveHeroVsMonster(hero, player, monster, new RngStream(seed, cursor));

    expect(outcome.threshold).toBe(10);
    expect(outcome.roll.total).toBe(6);
    expect(outcome.win).toBe(false);
    expect(outcome.xpGained).toBe(0);
    expect(outcome.hpDamage).toBe(7);
  });

  it('Worked Example 3 (Warrior extra die): Level 3 Warrior, attack 3, Monster Level 4, advantage roll 5 -> total 11 >= 7', () => {
    const seed = 'combat-ex-3';
    const cursor = findCursorForAdvantageMax(seed, 5);
    const hero = makeHero({ level: 3, attack: 3 });
    const player = makePlayer({ hero }, 'Warrior');
    const monster: MonsterCard = { id: 'm3', name: 'Test Monster', level: 4, lootRarityOnWin: 'Uncommon' };

    const outcome = resolveHeroVsMonster(hero, player, monster, new RngStream(seed, cursor));

    expect(outcome.roll.dieRoll).toBe(5);
    expect(outcome.threshold).toBe(7);
    expect(outcome.roll.total).toBe(11);
    expect(outcome.win).toBe(true);
  });

  it('a non-Warrior never benefits from advantage (die always a single 1d6 draw)', () => {
    const seed = 'no-advantage-check';
    for (let c = 0; c < 50; c++) {
      const hero = makeHero({ level: 1, attack: 1 });
      const player = makePlayer({ hero }, 'Mage');
      const monster: MonsterCard = { id: 'm', name: 'x', level: 1, lootRarityOnWin: 'Common' };
      const stream = new RngStream(seed, c);
      const outcome = resolveHeroVsMonster(hero, player, monster, stream);
      expect(outcome.roll.dieRoll).toBeGreaterThanOrEqual(1);
      expect(outcome.roll.dieRoll).toBeLessThanOrEqual(6);
      // A single-die roll only ever advances the cursor by 1.
      expect(stream.cursor).toBe(c + 1);
    }
  });
});

describe('§6.2 Hero vs Hero — worked example reproduced, and tie favors defender', () => {
  it('Worked Example: attacker 2+5+1+3=11, defender 6+4+1+1=12 -> defender wins', () => {
    const seed = 'pvp-ex';
    // Need consecutive draws: attacker die=2 then defender die=6, at the SAME cursor start.
    let cursor = 0;
    // brute force a cursor c where die(c)=2 and die(c+1)=6
    for (; ; cursor++) {
      const s = new RngStream(seed, cursor);
      const d1 = s.rollDieWithAdvantage(false);
      const d2 = s.rollDieWithAdvantage(false);
      if (d1 === 2 && d2 === 6) break;
      if (cursor > 200_000) throw new Error('search exhausted');
    }

    const attackerHero = makeHero({ level: 5, attack: 1, inventory: [{ id: 'r1', name: 'Rare Thing', rarity: 'Rare', combatBonus: 3 }], equippedLootIds: ['r1'] });
    const attackerPlayer = makePlayer({ id: 'attacker', hero: attackerHero }, 'Farmer');
    const defenderHero = makeHero({ level: 4, attack: 1, inventory: [{ id: 'c1', name: 'Common Thing', rarity: 'Common', combatBonus: 1 }], equippedLootIds: ['c1'] });
    const defenderPlayer = makePlayer({ id: 'defender', hero: defenderHero }, 'Farmer');

    const outcome = resolveHeroVsHero(attackerHero, attackerPlayer, defenderHero, defenderPlayer, new RngStream(seed, cursor));

    expect(outcome.attackerRoll.total).toBe(11);
    expect(outcome.defenderRoll.total).toBe(12);
    expect(outcome.attackerWins).toBe(false);
  });

  it('a tie always favors the defender (never the attacker)', () => {
    // Identical heroes/players => identical roll formula minus the die; force equal dice.
    const seed = 'pvp-tie';
    let cursor = 0;
    for (; ; cursor++) {
      const s = new RngStream(seed, cursor);
      const d1 = s.rollDieWithAdvantage(false);
      const d2 = s.rollDieWithAdvantage(false);
      if (d1 === d2) break;
    }
    const a = makeHero({ level: 3, attack: 1 });
    const b = makeHero({ level: 3, attack: 1 });
    const ap = makePlayer({ id: 'a', hero: a }, 'Farmer');
    const dp = makePlayer({ id: 'd', hero: b }, 'Farmer');
    const outcome = resolveHeroVsHero(a, ap, b, dp, new RngStream(seed, cursor));
    expect(outcome.attackerRoll.total).toBe(outcome.defenderRoll.total);
    expect(outcome.attackerWins).toBe(false);
  });
});

describe('§6.3 Army vs Territory — structural invariants across many random rolls', () => {
  it('losses + remaining always equal the committed unit count, on both sides', () => {
    for (let c = 0; c < 300; c += 3) {
      const outcome = resolveArmyVsTerritory(4, 3, 0, new RngStream('army-seed', c));
      expect(outcome.attackerLosses + outcome.attackerRemaining).toBe(4);
      expect(outcome.defenderLosses + outcome.defenderRemaining).toBe(3);
    }
  });

  it('tileCaptured is true iff defenderRemaining <= 0', () => {
    for (let c = 0; c < 300; c += 3) {
      const outcome = resolveArmyVsTerritory(5, 5, 0, new RngStream('capture-seed', c));
      expect(outcome.tileCaptured).toBe(outcome.defenderRemaining <= 0);
    }
  });

  it('Watchtower bonus never pushes a defending die above the cap of 6', () => {
    for (let c = 0; c < 300; c += 3) {
      const outcome = resolveArmyVsTerritory(3, 3, 1, new RngStream('watchtower-seed', c));
      for (const roll of outcome.defenderRolls) expect(roll).toBeLessThanOrEqual(6);
    }
  });

  it('an attacker with 0 defenders present always captures immediately', () => {
    const outcome = resolveArmyVsTerritory(1, 0, 0, new RngStream('empty-defense', 0));
    expect(outcome.tileCaptured).toBe(true);
    expect(outcome.defenderRemaining).toBe(0);
  });
});
