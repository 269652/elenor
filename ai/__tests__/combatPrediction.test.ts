import { describe, expect, it } from 'vitest';
import { duelWinProbability, pairWinProbability, predictArmyVsTerritory, rollMeetsThresholdProbability } from '../combatPrediction';

describe('pairWinProbability (§6.3 single die-vs-die pair)', () => {
  it('is exactly 15/36 without a Watchtower — enumerated, not approximated', () => {
    expect(pairWinProbability(false)).toBeCloseTo(15 / 36, 10);
  });

  it('is lower with a Watchtower (defender die effectively +1, capped at 6)', () => {
    expect(pairWinProbability(true)).toBeLessThan(pairWinProbability(false));
  });
});

describe('predictArmyVsTerritory (§6.3 expectation)', () => {
  it('capture is impossible in one engagement if attacker has fewer units than defender', () => {
    const pred = predictArmyVsTerritory(2, 5, false);
    expect(pred.captureProbability).toBe(0);
  });

  it('capture is certain against an undefended tile', () => {
    const pred = predictArmyVsTerritory(3, 0, false);
    expect(pred.captureProbability).toBe(1);
    expect(pred.expectedAttackerRemaining).toBe(3);
  });

  it('capture probability is exactly p^defendingUnits when attacker >= defender', () => {
    const p = pairWinProbability(false);
    const pred = predictArmyVsTerritory(4, 3, false);
    expect(pred.captureProbability).toBeCloseTo(Math.pow(p, 3), 10);
  });

  it('a 0-unit attack never changes anything', () => {
    const pred = predictArmyVsTerritory(0, 4, false);
    expect(pred.captureProbability).toBe(0);
    expect(pred.expectedDefenderRemaining).toBe(4);
  });

  it('expected losses are symmetric with the win probability', () => {
    const p = pairWinProbability(false);
    const pred = predictArmyVsTerritory(5, 5, false);
    expect(pred.expectedDefenderRemaining).toBeCloseTo(5 - 5 * p, 10);
    expect(pred.expectedAttackerRemaining).toBeCloseTo(5 - 5 * (1 - p), 10);
  });
});

describe('duelWinProbability (§6.2)', () => {
  it('is below 0.5 for evenly matched heroes — ties favor the defender', () => {
    expect(duelWinProbability(5, false, 5, false)).toBeLessThan(0.5);
    expect(duelWinProbability(5, false, 5, false)).toBeCloseTo(15 / 36, 10);
  });

  it('a Warrior attacker (extra die) beats an equally-matched non-Warrior defender more often', () => {
    const withAdvantage = duelWinProbability(5, true, 5, false);
    const without = duelWinProbability(5, false, 5, false);
    expect(withAdvantage).toBeGreaterThan(without);
  });

  it('a large flat-modifier edge dominates regardless of dice', () => {
    expect(duelWinProbability(20, false, 1, false)).toBeCloseTo(1, 10);
    expect(duelWinProbability(1, false, 20, false)).toBeCloseTo(0, 10);
  });
});

describe('rollMeetsThresholdProbability (§6.1/§6.2 single roll vs threshold)', () => {
  it('is 1 when the flat modifier alone already clears the threshold', () => {
    expect(rollMeetsThresholdProbability(10, 8, false)).toBe(1);
  });

  it('is 0 when even a 6 can\'t reach the threshold', () => {
    expect(rollMeetsThresholdProbability(0, 10, false)).toBe(0);
  });

  it('matches (7-need)/6 for a plain 1d6', () => {
    // flatModifier=4, threshold=8 -> need = 4 (die must be >= 4)
    expect(rollMeetsThresholdProbability(4, 8, false)).toBeCloseTo(3 / 6, 10);
  });

  it('advantage (2d6-keep-highest) always does at least as well as a plain roll', () => {
    for (let threshold = 2; threshold <= 12; threshold++) {
      expect(rollMeetsThresholdProbability(3, threshold, true)).toBeGreaterThanOrEqual(rollMeetsThresholdProbability(3, threshold, false));
    }
  });
});
