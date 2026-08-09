/**
 * Deterministic, closed-form combat prediction — the math the AI reasons over when deciding
 * whether to attack, kept separate from engine/combat.ts (which resolves REAL dice via the
 * shared RngStream when an action actually commits). Minimax needs to compare many candidate
 * moves cheaply and reproducibly; sampling real random rolls for each candidate would be both
 * noisy (different candidates could get "lucky"/"unlucky" samples) and would burn RNG cursor
 * positions for hypothetical futures that never happen. So instead: exact probability theory
 * over the same §6.3 rules (docs/rules-reference.md) the real reducer uses.
 */

/**
 * P(attacker's single d6 beats defender's single d6), ties favor the defender — exactly
 * mirrors engine/combat.ts's resolveArmyVsTerritory pairing rule. Computed by full enumeration
 * of all 36 (attackerDie, defenderDie) outcomes rather than approximated, so it's exact, not a
 * heuristic guess.
 */
export function pairWinProbability(defenderHasWatchtower: boolean): number {
  let attackerWins = 0;
  for (let a = 1; a <= 6; a++) {
    for (let d = 1; d <= 6; d++) {
      const defenderRoll = defenderHasWatchtower ? Math.min(d + 1, 6) : d;
      if (a > defenderRoll) attackerWins++;
    }
  }
  return attackerWins / 36;
}

export interface BattlePrediction {
  expectedAttackerRemaining: number;
  expectedDefenderRemaining: number;
  /** Exact probability the defender's garrison is fully destroyed by this single engagement
   *  (§6.3 is one simultaneous round, not iterated combat to the last unit) — see the file
   *  header's derivation: only possible when attackingUnits >= defendingUnits, in which case
   *  every defending unit is paired and must independently lose its own pair. */
  captureProbability: number;
}

/**
 * §6.3 Army vs Territory, in expectation. Every defending unit is paired (attacker >= defender
 * case) or every attacking unit is paired (attacker < defender case); pairs beyond
 * min(attacker, defender) never fight and never lose. Capture requires literally every
 * defending unit to lose its pair, i.e. p^defendingUnits when the attacker fields enough units
 * to pair against all of them — not "expected defender count reaches zero," which never
 * happens in a single-round model except in the trivial defendingUnits=0 case.
 */
export function predictArmyVsTerritory(attackingUnits: number, defendingUnits: number, defenderHasWatchtower: boolean): BattlePrediction {
  if (attackingUnits <= 0) {
    return { expectedAttackerRemaining: 0, expectedDefenderRemaining: defendingUnits, captureProbability: defendingUnits === 0 ? 1 : 0 };
  }
  if (defendingUnits === 0) {
    return { expectedAttackerRemaining: attackingUnits, expectedDefenderRemaining: 0, captureProbability: 1 };
  }

  const p = pairWinProbability(defenderHasWatchtower);
  const pairs = Math.min(attackingUnits, defendingUnits);
  const expectedDefenderLosses = pairs * p;
  const expectedAttackerLosses = pairs * (1 - p);
  const captureProbability = attackingUnits >= defendingUnits ? Math.pow(p, defendingUnits) : 0;

  return {
    expectedAttackerRemaining: Math.max(0, attackingUnits - expectedAttackerLosses),
    expectedDefenderRemaining: Math.max(0, defendingUnits - expectedDefenderLosses),
    captureProbability,
  };
}

function dieDistribution(hasAdvantage: boolean): number[] {
  const dist = [0, 0, 0, 0, 0, 0, 0]; // index 0 unused; faces 1-6
  if (!hasAdvantage) {
    for (let face = 1; face <= 6; face++) dist[face] = 1 / 6;
  } else {
    for (let a = 1; a <= 6; a++) {
      for (let b = 1; b <= 6; b++) dist[Math.max(a, b)] += 1 / 36;
    }
  }
  return dist;
}

/** §6.2 Hero vs Hero — exact P(attackerTotal > defenderTotal), ties correctly resolved in the
 *  defender's favor (strict inequality for the attacker). Each side's die distribution
 *  accounts for the Warrior 2d6-keep-highest perk independently. */
export function duelWinProbability(attackerFlatMod: number, attackerHasAdvantage: boolean, defenderFlatMod: number, defenderHasAdvantage: boolean): number {
  const attackerDist = dieDistribution(attackerHasAdvantage);
  const defenderDist = dieDistribution(defenderHasAdvantage);
  let p = 0;
  for (let a = 1; a <= 6; a++) {
    for (let d = 1; d <= 6; d++) {
      if (a + attackerFlatMod > d + defenderFlatMod) p += attackerDist[a] * defenderDist[d];
    }
  }
  return p;
}

/** [DEFAULT — hero battle participation] §6.3 Army vs Territory — P(a JOINING hero's own paired
 *  die beats a plain defending troop's die), ties favoring the defender exactly like every other
 *  §6.3 comparison (see engine/combat.ts's resolveArmyVsTerritory and this file's own
 *  pairWinProbability, which this generalizes with a flat modifier on one side). `heroFlatMod` is
 *  level + attack + gearBonus, added to the hero's die the same way engine/combat.ts's
 *  rollHeroAttack computes a hero's total; `hasAdvantage` mirrors the Warrior 2d6-keep-highest
 *  perk, same convention as duelWinProbability. The opposing troop rolls a plain d6, boosted +1
 *  (capped at 6) by a defending Watchtower — the same distribution resolveArmyVsTerritory's
 *  defenderEntries use.
 *
 *  Deliberately NOT a prediction of the full §6.3 ranked-pairing outcome — which pairing slot a
 *  joining hero's die actually lands in depends on how it ranks against the REST of its own side's
 *  sorted dice (buildDieEntries re-sorts hero + troops together) and on both armies' sizes, which
 *  is a full re-derivation of combat.ts's ranking logic. This answers the narrower, cheaper
 *  question decideAction.ts's hero-join heuristic actually needs: "if this hero's die does get
 *  compared against an ordinary troop's, is that a good trade?" — enough to tell a sensible bet
 *  from a reckless one without duplicating that ranking logic in the AI layer. */
export function heroPairWinProbability(heroFlatMod: number, hasAdvantage: boolean, defenderHasWatchtower: boolean): number {
  const heroDist = dieDistribution(hasAdvantage);
  let winProbability = 0;
  for (let heroDie = 1; heroDie <= 6; heroDie++) {
    const heroTotal = heroDie + heroFlatMod;
    for (let troopDie = 1; troopDie <= 6; troopDie++) {
      const troopRoll = defenderHasWatchtower ? Math.min(troopDie + 1, 6) : troopDie;
      if (heroTotal > troopRoll) winProbability += heroDist[heroDie] * (1 / 6);
    }
  }
  return winProbability;
}

/** P(attackTotal >= threshold) for a §6.1 Hero vs Monster / §6.2 Hero vs Hero roll, given the
 *  flat modifier (level + attack + gearBonus) already summed and whether the hero has the
 *  Warrior extra-die perk (2d6-keep-highest). Used by decideAction.ts to gauge whether a fight
 *  is worth the HP risk — same exact-enumeration approach as pairWinProbability, just over a
 *  d6 (or max of two d6) instead of a die-vs-die comparison. */
export function rollMeetsThresholdProbability(flatModifier: number, threshold: number, hasAdvantage: boolean): number {
  const need = threshold - flatModifier; // die must be >= need to succeed
  if (need <= 1) return 1;
  if (need > 6) return 0;
  if (!hasAdvantage) return (7 - need) / 6;
  // 2d6-keep-highest: P(max(d1,d2) >= need) = 1 - P(both < need) = 1 - ((need-1)/6)^2
  return 1 - Math.pow((need - 1) / 6, 2);
}
