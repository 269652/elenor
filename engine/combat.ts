/**
 * Pure dice/outcome math for the three Fight-phase combat types (§6) plus Volcano taming.
 * These functions only compute outcomes — they never touch decks or GameState directly, so
 * they're trivial to unit test. reducers.ts is responsible for applying the outcome (HP loss,
 * XP gain, deck draws, tile ownership flips) to state.
 */

import { HERO_BATTLE_DAMAGE_FLOOR, MONSTER_THRESHOLD_OFFSET, VOLCANO_MONSTER_LEVEL, WATCHTOWER_DIE_BONUS, WATCHTOWER_DIE_CAP } from './constants';
import { gearBonus, hasExtraCombatDie } from './selectors';
import type { RngStream } from './rng';
import type { HeroState, MonsterCard, Player } from './types';

export interface HeroRollBreakdown {
  dieRoll: number;
  level: number;
  attack: number;
  gearBonus: number;
  total: number;
}

/** §6.1/§6.2 die-roll clause: 1d6, or 2d6-keep-highest with the Warrior perk. */
export function rollHeroAttack(hero: HeroState, player: Player, rng: RngStream): HeroRollBreakdown {
  const dieRoll = rng.rollDieWithAdvantage(hasExtraCombatDie(player));
  const gear = gearBonus(hero);
  return {
    dieRoll,
    level: hero.level,
    attack: hero.attack,
    gearBonus: gear,
    total: dieRoll + hero.level + hero.attack + gear,
  };
}

export interface HeroVsMonsterOutcome {
  roll: HeroRollBreakdown;
  threshold: number;
  win: boolean;
  xpGained: number;
  hpDamage: number;
  monster: MonsterCard;
}

/** §6.1 Hero vs Monster. */
export function resolveHeroVsMonster(hero: HeroState, player: Player, monster: MonsterCard, rng: RngStream): HeroVsMonsterOutcome {
  const roll = rollHeroAttack(hero, player, rng);
  const threshold = monster.level + MONSTER_THRESHOLD_OFFSET;
  const win = roll.total >= threshold;
  return {
    roll,
    threshold,
    win,
    xpGained: win ? monster.level : 0,
    hpDamage: win ? 0 : monster.level,
    monster,
  };
}

/** §6.1 Volcano special case: same formula, monster.level fixed at 10, distinct rewards. */
export function resolveTameVolcano(hero: HeroState, player: Player, rng: RngStream): HeroVsMonsterOutcome {
  const fakeMonster: MonsterCard = {
    id: 'volcano-tame',
    name: 'The Volcano Itself',
    level: VOLCANO_MONSTER_LEVEL,
    lootRarityOnWin: 'Legendary',
  };
  return resolveHeroVsMonster(hero, player, fakeMonster, rng);
}

export interface HeroVsHeroOutcome {
  attackerRoll: HeroRollBreakdown;
  defenderRoll: HeroRollBreakdown;
  attackerWins: boolean;
}

/** §6.2 Hero vs Hero — higher total wins, ties favor the defender. */
export function resolveHeroVsHero(
  attackerHero: HeroState,
  attackerPlayer: Player,
  defenderHero: HeroState,
  defenderPlayer: Player,
  rng: RngStream
): HeroVsHeroOutcome {
  const attackerRoll = rollHeroAttack(attackerHero, attackerPlayer, rng);
  const defenderRoll = rollHeroAttack(defenderHero, defenderPlayer, rng);
  return {
    attackerRoll,
    defenderRoll,
    attackerWins: attackerRoll.total > defenderRoll.total,
  };
}

/** [DEFAULT — hero battle participation] One side's hero joining an Army vs Territory roll-off,
 *  pre-rolled via rollHeroAttack so this file's only concern is where that number ranks — not how
 *  it was computed. `roll` is kept (not just the total) so reducers.ts can report the breakdown
 *  in its CombatResolved event the same way it already does for the other Fight-phase combats. */
export interface HeroBattleDie {
  heroId: string;
  roll: HeroRollBreakdown;
}

export interface ArmyVsTerritoryOutcome {
  attackerRolls: number[];
  defenderRolls: number[];
  attackerLosses: number;
  defenderLosses: number;
  attackerRemaining: number;
  defenderRemaining: number;
  tileCaptured: boolean;
  /** [DEFAULT — hero battle participation] null when that side had no hero in the fight, OR had
   *  one but the army's own dice already filled every pairing slot before the hero's die ranked
   *  high enough to claim one (a big-enough army can fight a whole skirmish without ever putting
   *  its hero at risk). Otherwise 'won'/'lost' — the hero isn't a counted unit, so this pairing
   *  never touches attackerLosses/defenderLosses; a loss is paid in HP instead, see *HeroDamage. */
  attackerHeroOutcome: 'won' | 'lost' | null;
  defenderHeroOutcome: 'won' | 'lost' | null;
  /** HP the losing hero takes for THIS pairing — 0 unless that side's *HeroOutcome is 'lost'. */
  attackerHeroDamage: number;
  defenderHeroDamage: number;
}

/** Margin-scaled HP cost for a hero losing their battle pairing — see HERO_BATTLE_DAMAGE_FLOOR's
 *  doc comment in constants.ts for why it's shaped this way. */
export function heroBattleDamage(losingRoll: number, winningRoll: number): number {
  return Math.max(HERO_BATTLE_DAMAGE_FLOOR, winningRoll - losingRoll);
}

interface DieEntry {
  value: number;
  isHero: boolean;
}

function buildDieEntries(unitCount: number, hero: HeroBattleDie | null, rollUnit: () => number): DieEntry[] {
  const entries: DieEntry[] = Array.from({ length: unitCount }, () => ({ value: rollUnit(), isHero: false }));
  if (hero) entries.push({ value: hero.roll.total, isHero: true });
  return entries.sort((a, b) => b.value - a.value);
}

/** §6.3 Army vs Territory — Risk-style paired dice comparison. `attackerHero`/`defenderHero` are
 *  optional (default null) so every pre-existing call site — AI prediction, other tests — is
 *  unaffected; a joining hero's die is merged into their side's sorted array as one extra entry
 *  rather than replacing a troop's, so it can only ever ADD a pairing (when the other side still
 *  has spare, otherwise-unpaired dice) or contest a slot on genuinely comparable terms. */
export function resolveArmyVsTerritory(
  attackingUnits: number,
  defendingUnits: number,
  defenderHasWatchtower: boolean,
  rng: RngStream,
  attackerHero: HeroBattleDie | null = null,
  defenderHero: HeroBattleDie | null = null
): ArmyVsTerritoryOutcome {
  const attackerEntries = buildDieEntries(attackingUnits, attackerHero, () => rng.rollDie());
  const defenderEntries = buildDieEntries(defendingUnits, defenderHero, () => {
    const base = rng.rollDie();
    return defenderHasWatchtower ? Math.min(base + WATCHTOWER_DIE_BONUS, WATCHTOWER_DIE_CAP) : base;
  });

  const pairs = Math.min(attackerEntries.length, defenderEntries.length);
  let attackerLosses = 0;
  let defenderLosses = 0;
  let attackerHeroOutcome: 'won' | 'lost' | null = null;
  let defenderHeroOutcome: 'won' | 'lost' | null = null;
  let attackerHeroDamage = 0;
  let defenderHeroDamage = 0;

  for (let i = 0; i < pairs; i++) {
    const a = attackerEntries[i];
    const d = defenderEntries[i];
    if (a.value > d.value) {
      // Attacker's die wins this pairing (ties favor the defender, §6.3).
      if (d.isHero) {
        defenderHeroOutcome = 'lost';
        defenderHeroDamage = heroBattleDamage(d.value, a.value);
      } else {
        defenderLosses += 1;
      }
      if (a.isHero) attackerHeroOutcome = 'won';
    } else {
      if (a.isHero) {
        attackerHeroOutcome = 'lost';
        attackerHeroDamage = heroBattleDamage(a.value, d.value);
      } else {
        attackerLosses += 1;
      }
      if (d.isHero) defenderHeroOutcome = 'won';
    }
  }

  const attackerRemaining = attackingUnits - attackerLosses;
  const defenderRemaining = defendingUnits - defenderLosses;

  return {
    attackerRolls: attackerEntries.map((e) => e.value),
    defenderRolls: defenderEntries.map((e) => e.value),
    attackerLosses,
    defenderLosses,
    attackerRemaining,
    defenderRemaining,
    tileCaptured: defenderRemaining <= 0,
    attackerHeroOutcome,
    defenderHeroOutcome,
    attackerHeroDamage,
    defenderHeroDamage,
  };
}
