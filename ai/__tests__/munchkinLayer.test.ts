/**
 * Regression guard for the Munchkin (hero / monster / loot / leveling) half of the game.
 *
 * This exists because that entire half was once silently, completely inert: a measured all-AI
 * sweep resolved ZERO monster fights, granted ZERO XP, and ended every game with every single
 * Ruins tile still guarded and every hero still level 1. Nothing threw and no test failed — the
 * content was simply never reached, because scoreDestination only ever sees hexes inside the
 * hero's 2-hex movement range and no term pointed toward a Monster Den beyond it.
 *
 * A unit test can't catch that class of failure: every individual rule worked correctly in
 * isolation. Only playing real games and asserting the systems actually ENGAGE can. Assertions
 * are aggregated across several seeds rather than per-seed, because whether one particular map
 * puts a reachable Den near a hero is genuinely luck — the claim being defended is "this half of
 * the game happens," not "it happens on every map."
 */
import { describe, expect, it } from 'vitest';
import { applyAction, createGame, type GameState } from '@/engine';
import { decideAction } from '../decideAction';

const PLAYERS = [
  { id: 'p1', name: 'Alice', color: '#f00' },
  { id: 'p2', name: 'Bob', color: '#0f0' },
  { id: 'p3', name: 'Cara', color: '#00f' },
];

const SEEDS = ['munchkin-a', 'munchkin-b', 'munchkin-c', 'munchkin-d', 'munchkin-e'];

interface GameOutcome {
  monsterFights: number;
  monsterWins: number;
  levelUps: number;
  lootCards: number;
  ruinsCleared: number;
  ruinsOnMap: number;
  maxHeroLevel: number;
}

function playGame(seed: string, maxActions = 6000): GameOutcome {
  let state: GameState = createGame(`munchkin-${seed}`, PLAYERS, seed, 'hotseat');
  for (let i = 0; i < maxActions && !state.winnerId; i++) {
    const action = decideAction(state, state.currentPlayerId);
    // The engine is the authority on legality; an AI proposing something illegal is covered by
    // decideAction.test.ts's dedicated never-illegal test, so here we just keep play moving.
    try {
      state = applyAction(state, action);
    } catch {
      state = applyAction(state, { type: 'AdvancePhase', actorId: state.currentPlayerId });
    }
  }

  const combats = state.eventLog.filter((e) => e.type === 'CombatResolved' && e.payload.combatType === 'HeroVsMonster');
  const ruins = Object.values(state.map).filter((t) => t.type === 'Ruins');
  return {
    monsterFights: combats.length,
    monsterWins: combats.filter((e) => e.payload.win === true).length,
    levelUps: state.eventLog.filter((e) => e.type === 'HeroLeveledUp').length,
    lootCards: state.players.reduce((sum, p) => sum + p.hero.inventory.length, 0),
    ruinsCleared: ruins.filter((t) => !t.monsterDenCardId).length,
    ruinsOnMap: ruins.length,
    maxHeroLevel: Math.max(...state.players.map((p) => p.hero.level)),
  };
}

describe('Munchkin layer actually gets played', () => {
  // NB: (s) => playGame(s), not the point-free SEEDS.map(playGame) — Array.map passes the index
  // as the second argument, which would land in maxActions and cap the first game at 0 actions.
  const outcomes = SEEDS.map((s) => playGame(s));
  const total = (pick: (o: GameOutcome) => number) => outcomes.reduce((sum, o) => sum + pick(o), 0);

  it('heroes seek out and fight Monster Dens instead of hauling cargo all game', () => {
    // Pre-fix this was 0 across every seed. Deliberately well below what the sweep actually
    // produces (roughly 15) so ordinary map/seed variance can't make it flaky, while still
    // failing loudly if heroes stop questing altogether.
    expect(total((o) => o.monsterFights)).toBeGreaterThanOrEqual(6);
    expect(outcomes.filter((o) => o.monsterFights > 0).length).toBeGreaterThanOrEqual(3);
  });

  it('heroes win fights, take loot, and clear the Dens they beat', () => {
    expect(total((o) => o.monsterWins)).toBeGreaterThanOrEqual(4);
    expect(total((o) => o.lootCards)).toBeGreaterThanOrEqual(4);
    expect(total((o) => o.ruinsCleared)).toBeGreaterThanOrEqual(4);
  });

  it('heroes convert XP into actual levels — the progression loop closes', () => {
    // The specific failure this guards: heroes DID bank XP and earn level-ups, then could never
    // pay for them, because LEVEL_UP_COST demanded Gold (Desert-only, 6% of the deck) and later
    // because army upkeep drained Food to zero every round. Earning a level is worthless if the
    // game never lets you spend it, so assert on levels applied, not XP accumulated.
    expect(total((o) => o.levelUps)).toBeGreaterThanOrEqual(2);
    expect(Math.max(...outcomes.map((o) => o.maxHeroLevel))).toBeGreaterThanOrEqual(2);
  });

  it('places enough Ruins for the Den content to exist at all', () => {
    // Guards TILE_DECK_COMPOSITION.Ruins: Dens are the only source of hero XP and loot outside a
    // Hunting Lodge, so if this share is ever tuned back down the layer starves regardless of
    // how well the AI plays.
    expect(Math.min(...outcomes.map((o) => o.ruinsOnMap))).toBeGreaterThanOrEqual(3);
  });
});
