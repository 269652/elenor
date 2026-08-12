import { describe, expect, it } from 'vitest';
import { applyAction } from '../reducer';
import { heroBattleDamage, resolveArmyVsTerritory, type HeroRollBreakdown } from '../combat';
import { RngStream } from '../rng';
import { CAPITAL_TIERS, HERO_BATTLE_DAMAGE_FLOOR, HERO_BATTLE_XP_ON_WIN } from '../constants';
import { hexKey, IllegalActionError, Phase } from '../types';
import type { GameState, HexCoord, Player, PlayerId, Tile } from '../types';
import { findCursorForDie, makeHero, makePlayer, makeTile } from './testUtils';

/**
 * [DEFAULT — hero battle participation, direct request: "Heroes should be able to partake in
 * battles in a senseful manner... find a fair equation between risk and the hero. If the hero
 * dies a new one is spawned without any of the items or skills of the last one."]
 *
 * Two layers, tested separately:
 *  - combat.ts: resolveArmyVsTerritory's hero-die extension is pure math — a hero's precomputed
 *    roll (HeroRollBreakdown.total, from rollHeroAttack) merges into the sorted dice array as one
 *    extra, uncounted entry. Deterministic via a fixed hero total + findCursorForDie for the lone
 *    troop's roll, no brute force needed.
 *  - reducers.ts: applyMoveSoldiers wires that into a real MoveSoldiers action — validation,
 *    HP/XP application, and permadeath respawn. The exact win/lose branch a given rngCursor lands
 *    on isn't predicted by hand here; instead assertions read the CombatResolved event's own
 *    attackerHeroOutcome/defenderHeroOutcome and check the state change implied by THAT outcome
 *    actually happened — still exercises the full wiring, just branch-agnostically. Permadeath
 *    itself still needs a guaranteed loss, found by a small brute-force search.
 */

const SEED = 'hero-battle-seed';

function heroRoll(total: number): HeroRollBreakdown {
  return { dieRoll: 1, level: 1, attack: 1, gearBonus: 0, total };
}

// ── combat.ts — pure resolveArmyVsTerritory extension ──────────────────────────────────────

describe('resolveArmyVsTerritory: hero battle die', () => {
  it('an attacking hero who wins their pairing kills the paired defender troop, costs no HP, and is not counted as a Soldier', () => {
    const cursor = findCursorForDie(SEED, 3); // the lone defending troop's roll
    const rng = new RngStream(SEED, cursor);
    const outcome = resolveArmyVsTerritory(0, 1, 0, rng, { heroId: 'h1', roll: heroRoll(10) }, null);

    expect(outcome.attackerHeroOutcome).toBe('won');
    expect(outcome.attackerHeroDamage).toBe(0);
    expect(outcome.defenderLosses).toBe(1); // the troop the hero's die beat
    expect(outcome.attackerLosses).toBe(0); // hero isn't a counted unit
    expect(outcome.defenderRemaining).toBe(0);
    expect(outcome.tileCaptured).toBe(true);
  });

  it('an attacking hero who loses their pairing takes margin-scaled HP damage instead of costing a Soldier', () => {
    const cursor = findCursorForDie(SEED, 6); // the lone defending troop rolls the max
    const rng = new RngStream(SEED, cursor);
    const outcome = resolveArmyVsTerritory(0, 1, 0, rng, { heroId: 'h1', roll: heroRoll(3) }, null);

    expect(outcome.attackerHeroOutcome).toBe('lost');
    expect(outcome.attackerHeroDamage).toBe(heroBattleDamage(3, 6)); // max(FLOOR, 6-3) = 3
    expect(outcome.attackerLosses).toBe(0); // still not a troop loss
    expect(outcome.defenderLosses).toBe(0); // the troop won, it doesn't die
  });

  it('a tied roll favors the defender (§6.3) and still floors hero damage even at zero margin', () => {
    const cursor = findCursorForDie(SEED, 5);
    const rng = new RngStream(SEED, cursor);
    const outcome = resolveArmyVsTerritory(0, 1, 0, rng, { heroId: 'h1', roll: heroRoll(5) }, null);

    expect(outcome.attackerHeroOutcome).toBe('lost');
    expect(outcome.attackerHeroDamage).toBe(HERO_BATTLE_DAMAGE_FLOOR);
  });

  it('a defending hero participates symmetrically', () => {
    const cursor = findCursorForDie(SEED, 2); // the lone attacking troop's roll
    const rng = new RngStream(SEED, cursor);
    const outcome = resolveArmyVsTerritory(1, 0, 0, rng, null, { heroId: 'd1', roll: heroRoll(9) });

    expect(outcome.defenderHeroOutcome).toBe('won');
    expect(outcome.defenderHeroDamage).toBe(0);
    expect(outcome.attackerLosses).toBe(1);
    expect(outcome.defenderLosses).toBe(0);
    // Not asserting tileCaptured here: with 0 starting defenders it's trivially true regardless
    // of the hero's own duel — that flag is about troop count, orthogonal to what's under test.
  });

  it('a hero does not get a pairing when their own side already has a higher-ranked die filling the only slot', () => {
    const cursor = findCursorForDie(SEED, 6); // the attacker's ONE real troop rolls the max
    const rng = new RngStream(SEED, cursor);
    // attackingUnits=1 (troop) + hero(total=1) vs defendingUnits=1: pairs=1, and the troop (6)
    // outranks the hero (1) within the attacker's own sorted array, so it claims the only slot.
    const outcome = resolveArmyVsTerritory(1, 1, 0, rng, { heroId: 'h1', roll: heroRoll(1) }, null);

    expect(outcome.attackerHeroOutcome).toBeNull();
    expect(outcome.attackerHeroDamage).toBe(0);
  });

  it('omitting both hero params (undefined) behaves identically to explicit nulls and to the pre-existing signature', () => {
    const cursor = findCursorForDie(SEED, 4);
    const withoutArgs = resolveArmyVsTerritory(3, 2, 0, new RngStream(SEED, cursor));
    const withNulls = resolveArmyVsTerritory(3, 2, 0, new RngStream(SEED, cursor), null, null);

    expect(withoutArgs).toEqual(withNulls);
    expect(withoutArgs.attackerHeroOutcome).toBeNull();
    expect(withoutArgs.defenderHeroOutcome).toBeNull();
    expect(withoutArgs.attackerHeroDamage).toBe(0);
    expect(withoutArgs.defenderHeroDamage).toBe(0);
  });
});

// ── reducers.ts — applyMoveSoldiers wiring ──────────────────────────────────────────────────

const P1_CAPITAL: HexCoord = { q: 0, r: 0 };
const P1_BORDER: HexCoord = { q: 1, r: 0 };
const P2_BORDER: HexCoord = { q: 2, r: 0 };
const P2_CAPITAL: HexCoord = { q: 3, r: 0 };

function fixtureState(players: Player[], tiles: Tile[], overrides: Partial<GameState> = {}): GameState {
  const map: Record<string, Tile> = {};
  for (const t of tiles) map[hexKey(t.coord)] = t;
  return {
    gameId: 'g-hero-battle',
    mode: 'hotseat',
    status: 'active',
    rngSeed: SEED,
    rngCursor: 0,
    roundNumber: 5,
    turnOrder: players.map((p) => p.id),
    currentPlayerId: players[0].id,
    currentPhase: Phase.Build,
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
    heroCoordBeforeMoveThisTurn: null,
    ...overrides,
  };
}

interface FixtureOptions {
  p1BorderMilitia?: number;
  p2BorderMilitia?: number;
  attackerHeroHp?: number;
  attackerHeroAtBorder?: boolean;
  defenderHeroAtBorder?: boolean;
  defenderHeroHp?: number;
  defenderHeroLevel?: number;
  defenderHeroAttack?: number;
  rngCursor?: number;
}

function heroBattleFixture(opts: FixtureOptions = {}): GameState {
  const p1Hero = makeHero({
    id: 'p1-hero-1',
    ownerId: 'p1',
    position: opts.attackerHeroAtBorder ? P1_BORDER : P1_CAPITAL,
    hp: opts.attackerHeroHp ?? 20,
    maxHp: 20,
    level: 3,
    attack: 2,
  });
  const p2Hero = makeHero({
    id: 'p2-hero-1',
    ownerId: 'p2',
    position: opts.defenderHeroAtBorder ? P2_BORDER : P2_CAPITAL,
    hp: opts.defenderHeroHp ?? 20,
    maxHp: 20,
    level: opts.defenderHeroLevel ?? 3,
    attack: opts.defenderHeroAttack ?? 2,
  });
  const p1 = makePlayer({
    id: 'p1',
    capitalTile: P1_CAPITAL,
    ownedTiles: [P1_CAPITAL, P1_BORDER],
    resources: { Food: 200, Meat: 0 },
    hero: p1Hero,
    capitalTier: 1,
  });
  const p2 = makePlayer({
    id: 'p2',
    capitalTile: P2_CAPITAL,
    ownedTiles: [P2_BORDER, P2_CAPITAL],
    resources: { Food: 200, Meat: 0 },
    hero: p2Hero,
    capitalTier: 1,
  });
  const tiles: Tile[] = [
    makeTile({ coord: P1_CAPITAL, type: 'Plains', ownerId: 'p1', militiaCount: 0 }),
    makeTile({ coord: P1_BORDER, type: 'Plains', ownerId: 'p1', militiaCount: opts.p1BorderMilitia ?? 5 }),
    makeTile({ coord: P2_BORDER, type: 'Plains', ownerId: 'p2', militiaCount: opts.p2BorderMilitia ?? 3 }),
    makeTile({ coord: P2_CAPITAL, type: 'Plains', ownerId: 'p2', militiaCount: 0 }),
  ];
  return fixtureState([p1, p2], tiles, {
    turnOrder: ['p1', 'p2'],
    currentPlayerId: 'p1',
    rngCursor: opts.rngCursor ?? 0,
  });
}

function playerIn(state: GameState, id: PlayerId): Player {
  return state.players.find((p) => p.id === id)!;
}

function eventsOfType(state: GameState, type: string) {
  return state.eventLog.filter((e) => e.type === type);
}

const ATTACK_ACTION = {
  type: 'MoveSoldiers' as const,
  actorId: 'p1',
  fromCoord: P1_BORDER,
  toCoord: P2_BORDER,
  count: 3,
  heroId: 'p1-hero-1',
  heroJoins: true,
};

describe('applyMoveSoldiers: heroJoins backward compatibility', () => {
  it('omitting heroJoins leaves the hero completely untouched, same as before this feature existed', () => {
    const state = heroBattleFixture({ attackerHeroAtBorder: true });
    const before = playerIn(state, 'p1').hero;
    const after = applyAction(state, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P1_BORDER, toCoord: P2_BORDER, count: 3 });
    const afterHero = playerIn(after, 'p1').hero;

    expect(afterHero.hp).toBe(before.hp);
    expect(afterHero.xp).toBe(before.xp);
    expect(afterHero.position).toEqual(before.position);
    expect(eventsOfType(after, 'HeroDamaged')).toHaveLength(0);
    expect(eventsOfType(after, 'HeroDied')).toHaveLength(0);
  });
});

describe('applyMoveSoldiers: heroJoins validation', () => {
  it('rejects a hero that is not physically standing on fromCoord', () => {
    const state = heroBattleFixture({ attackerHeroAtBorder: false }); // hero is home at the Capital
    expect(() => applyAction(state, ATTACK_ACTION)).toThrow(IllegalActionError);
  });
});

describe('applyMoveSoldiers: an attacking hero joining a contested march', () => {
  it("the hero's own pairing outcome (from the CombatResolved event) matches the HP/XP change actually applied", () => {
    const state = heroBattleFixture({ attackerHeroAtBorder: true, attackerHeroHp: 20 });
    const before = playerIn(state, 'p1').hero;
    const after = applyAction(state, ATTACK_ACTION);
    const payload = eventsOfType(after, 'CombatResolved')[0].payload as { attackerHeroOutcome: 'won' | 'lost' | null; attackerHeroDamage: number };
    const afterHero = playerIn(after, 'p1').hero;

    if (payload.attackerHeroOutcome === 'won') {
      expect(afterHero.xp).toBe(before.xp + HERO_BATTLE_XP_ON_WIN);
      expect(afterHero.hp).toBe(before.hp);
    } else if (payload.attackerHeroOutcome === 'lost') {
      expect(afterHero.hp).toBe(before.hp - payload.attackerHeroDamage);
      expect(afterHero.xp).toBe(before.xp);
    } else {
      // No pairing slot reached the hero — untouched.
      expect(afterHero.hp).toBe(before.hp);
      expect(afterHero.xp).toBe(before.xp);
    }
    // Never moved by MoveSoldiers — that's still MoveHeroAction's job (Phase 2).
    if (afterHero.hp > 0) expect(afterHero.position).toEqual(before.position);
  });

  it('a hero brought to exactly lethal HP is permanently replaced: fresh level 1, no gear/XP/level carried over, sent home to the Capital', () => {
    // Brute-force search for a cursor whose attacker-hero pairing is a LOSS — HP=1 makes any
    // non-zero damage (the floor guarantees >=HERO_BATTLE_DAMAGE_FLOOR) lethal regardless of margin.
    let after: GameState | null = null;
    for (let c = 0; c < 5000; c++) {
      const candidate = applyAction(heroBattleFixture({ attackerHeroAtBorder: true, attackerHeroHp: 1, rngCursor: c }), ATTACK_ACTION);
      const payload = eventsOfType(candidate, 'CombatResolved')[0].payload as { attackerHeroOutcome: string | null };
      if (payload.attackerHeroOutcome === 'lost') {
        after = candidate;
        break;
      }
    }
    expect(after).not.toBeNull();
    const dead = playerIn(after!, 'p1');

    expect(eventsOfType(after!, 'HeroDied')).toHaveLength(1);
    expect(dead.hero.id).toBe('p1-hero-1'); // same slot id, brand new body
    expect(dead.hero.level).toBe(1);
    expect(dead.hero.xp).toBe(0);
    expect(dead.hero.inventory).toEqual([]);
    expect(dead.hero.equippedLootIds).toEqual([]);
    expect(dead.hero.activeCurses).toEqual([]);
    expect(dead.hero.hp).toBe(dead.hero.maxHp); // spawns at full fresh HP
    expect(dead.hero.position).toEqual(P1_CAPITAL); // sent home, not left on the battlefield
  });
});

describe('applyMoveSoldiers: a defending hero participates automatically, no flag needed', () => {
  it('a defending hero standing on the attacked tile can win, lose, or die exactly like an attacking one', () => {
    // A level-1/attack-1 hero (min roll 1+1+1=3) can lose to a max troop roll (6) — level 3's
    // min roll (6) cannot, since a tie already favors the defender (§6.3); see the comment on the
    // combat.ts-level "defending hero participates symmetrically" test above for why.
    let after: GameState | null = null;
    for (let c = 0; c < 5000; c++) {
      const candidate = applyAction(
        heroBattleFixture({ defenderHeroAtBorder: true, defenderHeroHp: 1, defenderHeroLevel: 1, defenderHeroAttack: 1, rngCursor: c }),
        { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P1_BORDER, toCoord: P2_BORDER, count: 3 } // no heroJoins — defender needs none
      );
      const payload = eventsOfType(candidate, 'CombatResolved')[0].payload as { defenderHeroOutcome: string | null };
      if (payload.defenderHeroOutcome === 'lost') {
        after = candidate;
        break;
      }
    }
    expect(after).not.toBeNull();
    const dead = playerIn(after!, 'p2');

    expect(eventsOfType(after!, 'HeroDied')).toHaveLength(1);
    expect(dead.hero.level).toBe(1);
    expect(dead.hero.hp).toBe(dead.hero.maxHp);
    expect(dead.hero.position).toEqual(P2_CAPITAL);
  });

  it('a hero standing anywhere else on the defending side does not participate', () => {
    const state = heroBattleFixture({ defenderHeroAtBorder: false });
    const before = playerIn(state, 'p2').hero;
    const after = applyAction(state, { type: 'MoveSoldiers', actorId: 'p1', fromCoord: P1_BORDER, toCoord: P2_BORDER, count: 3 });
    const afterHero = playerIn(after, 'p2').hero;
    const payload = eventsOfType(after, 'CombatResolved')[0].payload as { defenderHeroOutcome: string | null };

    expect(payload.defenderHeroOutcome).toBeNull();
    expect(afterHero.hp).toBe(before.hp);
    expect(afterHero.xp).toBe(before.xp);
  });
});

// [DEFAULT — second hero removed] This file previously also covered freshHeroState via the
// Town-tier-4 second-hero unlock (a shared factory fix that surfaced a gap where that unlock
// hardcoded hp:10/attack:1 with none of setup.ts's class/Town-tier bonuses). The second-hero
// feature itself was removed rather than kept working — see git history for both.
describe('applyBuild: Capital tier upgrades still bump the hero\'s maxHp correctly', () => {
  it('bumps hero.maxHp/hp by the new tier\'s heroMaxHpBonus', () => {
    const capitalTile: HexCoord = { q: 0, r: 0 };
    const dummyOwnedTiles: HexCoord[] = Array.from({ length: 10 }, (_, i) => ({ q: 50 + i, r: 50 }));
    const p1 = makePlayer(
      {
        id: 'p1',
        capitalTile,
        ownedTiles: [capitalTile, ...dummyOwnedTiles],
        capitalTier: 3,
        resources: { Ore: 20, Gold: 20 },
      },
      'Warrior'
    );
    const tiles: Tile[] = [
      makeTile({
        coord: capitalTile,
        type: 'Plains',
        ownerId: 'p1',
        building: { id: 'cap', type: 'Capital', coord: capitalTile, ownerId: 'p1', tier: 3 },
      }),
    ];
    const state = fixtureState([p1], tiles);
    const before = playerIn(state, 'p1');
    const after = applyAction(state, { type: 'Build', actorId: 'p1', buildingType: 'Capital', coord: capitalTile });
    const player = playerIn(after, 'p1');
    const tier4Bonus = CAPITAL_TIERS[3].heroMaxHpBonus;

    expect(player.capitalTier).toBe(4);
    expect(player.hero.maxHp).toBe(before.hero.maxHp + tier4Bonus);
    expect(player.hero.hp).toBe(before.hero.hp + tier4Bonus);
  });
});

