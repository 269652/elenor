import { describe, expect, it } from 'vitest';
import { applyAction, createGame, hexKey, hexNeighbors, Phase } from '@/engine';
import { decideAction } from '../decideAction';

/**
 * [DEFAULT — hero battle participation, AI layer] Focused coverage for `heroShouldJoinMarch`
 * (ai/decideAction.ts) and its `heroPairWinProbability` helper (ai/combatPrediction.ts) — the
 * heuristic that decorates an already-chosen `findBestTerritoryAttack` march with
 * `heroId`/`heroJoins: true` when it judges the hero's own §6.3 pairing a good bet. Neither
 * function is exported, so every case here drives the whole thing through the public
 * `decideAction` entry point against a hand-built fixture, same style as
 * ai/__tests__/territoryMinimax.test.ts's `makeAttackScenario` and the "roads a Food tile"
 * fixture in ai/__tests__/decideAction.test.ts.
 *
 * Every fixture is engineered so `findBestTerritoryAttack` picks exactly ONE march — attacker
 * militia parked on p1's Capital, an adjacent tile owned by p2 with a small (beatable) garrison
 * — mirroring territoryMinimax.test.ts's own "5 vs 1, undefended" case, which is already proven
 * to return a non-null, favorable attack. What varies per test is only the hero's own state
 * (position, HP, capitalTier/secondHero, stats, pendingDoorMonster) — i.e. exactly the inputs
 * heroShouldJoinMarch's four gates read.
 */

const PLAYERS = [
  { id: 'p1', name: 'Alice', color: '#f00' },
  { id: 'p2', name: 'Bob', color: '#0f0' },
];

interface MarchScenarioOptions {
  attackerMilitia?: number;
  defenderMilitia?: number;
  defenderWatchtower?: boolean;
  /** undefined (default) leaves the target owned by p2 with a garrison, i.e. contested; false
   *  builds a neutral, empty, unowned tile instead — an uncontested occupation. */
  contested?: boolean;
  heroLevel?: number;
  heroAttack?: number;
  heroHp?: number;
  heroMaxHp?: number;
  /** false parks the hero somewhere far away instead of on fromCoord (p1's Capital). */
  heroAtFromCoord?: boolean;
  capitalTier?: number;
  pendingDoorMonsterForHero?: boolean;
}

function makeMarchScenario(opts: MarchScenarioOptions = {}) {
  const state = structuredClone(createGame('hero-join-g', PLAYERS, 'hero-join-seed', 'hotseat'));
  const p1 = state.players.find((p) => p.id === 'p1')!;
  const p2 = state.players.find((p) => p.id === 'p2')!;

  state.currentPlayerId = 'p1';
  state.currentPhase = Phase.Build;
  // Skips the whole Build-slot search (LevelUpHero / findBestBuildCandidate) — only the free
  // Phase-5 march logic under test should be able to fire.
  state.hasBuiltThisTurn = true;

  // Ample wallet so considerStarvationTrade/considerBarracksTrade never preempt the march, and
  // zero Wood so considerBuildRoad (which runs before phase dispatch) can never fire either.
  p1.resources.Food = 999;
  p1.resources.Meat = 999;
  p1.resources.Wood = 0;

  const fromCoord = p1.capitalTile;
  state.map[hexKey(fromCoord)].militiaCount = opts.attackerMilitia ?? 5;

  const targetCoord = hexNeighbors(fromCoord)[0];
  const contested = opts.contested ?? true;
  state.map[hexKey(targetCoord)] = {
    coord: targetCoord,
    type: 'Plains',
    ownerId: contested ? 'p2' : null,
    building: contested && opts.defenderWatchtower ? { id: 'wt', type: 'Watchtower', coord: targetCoord, ownerId: 'p2' } : null,
    monsterDenCardId: null,
    stockpile: { Wood: 0, Stone: 0, Food: 0, Ore: 0, Meat: 0, Gold: 0 },
    militiaCount: contested ? (opts.defenderMilitia ?? 1) : 0,
  };
  if (contested) p2.ownedTiles.push(targetCoord);

  p1.capitalTier = opts.capitalTier ?? 2; // avoid the stricter solo-early HP floor by default
  p1.hero.level = opts.heroLevel ?? 3;
  p1.hero.attack = opts.heroAttack ?? 2;
  p1.hero.maxHp = opts.heroMaxHp ?? 20;
  p1.hero.hp = opts.heroHp ?? p1.hero.maxHp;
  p1.hero.position = opts.heroAtFromCoord === false ? { q: 99, r: 99 } : fromCoord;

  if (opts.pendingDoorMonsterForHero) {
    state.pendingDoorMonster = { heroId: p1.hero.id, coord: { q: 50, r: 50 }, monsterCardId: 'door-card-1' };
  }

  return { state, fromCoord, targetCoord, heroId: p1.hero.id };
}

/** Narrows decideAction's return down to the MoveSoldiers case, failing loudly (with the actual
 *  action) if the fixture didn't drive it into a march at all — every case below is engineered
 *  to reach considerTerritoryMarch, so anything else means the fixture, not the heuristic, broke. */
function expectMoveSoldiers(action: ReturnType<typeof decideAction>) {
  expect(action.type, `expected a MoveSoldiers action, got ${JSON.stringify(action)}`).toBe('MoveSoldiers');
  return action as Extract<ReturnType<typeof decideAction>, { type: 'MoveSoldiers' }>;
}

describe('heroShouldJoinMarch (via decideAction): gates that must block joining', () => {
  it('does not join when the hero is not physically standing on fromCoord', () => {
    const { state } = makeMarchScenario({ heroAtFromCoord: false });
    const action = expectMoveSoldiers(decideAction(state, 'p1'));
    expect(action.heroJoins).toBeFalsy();
    expect(action.heroId).toBeUndefined();
  });

  it('does not join when the hero is at 0 HP', () => {
    const { state } = makeMarchScenario({ heroHp: 0 });
    const action = expectMoveSoldiers(decideAction(state, 'p1'));
    expect(action.heroJoins).toBeFalsy();
  });

  it('does not join when HP is below the tightened solo-early floor (0.75), even though it clears the normal 0.5 floor', () => {
    // capitalTier 1 (the setup default), no secondHero: the stricter early-game floor applies.
    const { state } = makeMarchScenario({ capitalTier: 1, heroMaxHp: 20, heroHp: 12 }); // 0.6 fraction
    const action = expectMoveSoldiers(decideAction(state, 'p1'));
    expect(action.heroJoins).toBeFalsy();
  });

  it('the same 0.6 HP fraction DOES clear the ordinary 0.5 floor once past the solo-early window (capitalTier > 1)', () => {
    const { state, heroId } = makeMarchScenario({ capitalTier: 2, heroMaxHp: 20, heroHp: 12 }); // same 0.6 fraction
    const action = expectMoveSoldiers(decideAction(state, 'p1'));
    expect(action.heroJoins).toBe(true);
    expect(action.heroId).toBe(heroId);
  });

  it('does not join while the hero is mid a mandatory Door-card fight', () => {
    const { state } = makeMarchScenario({ pendingDoorMonsterForHero: true });
    const action = expectMoveSoldiers(decideAction(state, 'p1'));
    expect(action.heroJoins).toBeFalsy();
  });

  it('does not join an uncontested march — there is no pairing to join', () => {
    const { state } = makeMarchScenario({ contested: false });
    const action = expectMoveSoldiers(decideAction(state, 'p1'));
    expect(action.heroJoins).toBeFalsy();
    expect(action.heroId).toBeUndefined();
  });

  it('does not join a weak pairing (flat modifier 1, Watchtower-boosted defender die -> ~44.4% win rate, below the 0.55 bar)', () => {
    // Flat modifier can't go below 1 (hero.level alone is always >= 1), and even the minimum
    // flat modifier against a plain d6 already clears 0.55 (21/36 ~= 0.583) — so this needs the
    // defending Watchtower's +1-capped-at-6 die to push the estimate under the bar and actually
    // exercise the "declines a mediocre trade" branch, not just the floor/position gates above.
    const { state } = makeMarchScenario({ heroLevel: 1, heroAttack: 0, defenderWatchtower: true });
    const action = expectMoveSoldiers(decideAction(state, 'p1'));
    expect(action.heroJoins).toBeFalsy();
  });
});

describe('heroShouldJoinMarch (via decideAction): joins a clearly safe, favorable fight', () => {
  it('sets heroId/heroJoins on the chosen march when all gates pass', () => {
    const { state, fromCoord, heroId } = makeMarchScenario({});
    const action = expectMoveSoldiers(decideAction(state, 'p1'));

    expect(action.heroJoins).toBe(true);
    expect(action.heroId).toBe(heroId);
    expect(hexKey(action.fromCoord)).toBe(hexKey(fromCoord));
  });

  it('never proposes an illegal action: applying the join decision does not throw, and the hero stays put', () => {
    const { state, heroId } = makeMarchScenario({});
    const action = expectMoveSoldiers(decideAction(state, 'p1'));
    expect(action.heroJoins).toBe(true);

    const before = state.players.find((p) => p.id === 'p1')!.hero;
    let after: ReturnType<typeof applyAction>;
    expect(() => {
      after = applyAction(state, action);
    }).not.toThrow();

    const combatEvent = after!.eventLog.find((e) => e.type === 'CombatResolved');
    expect(combatEvent).toBeDefined();
    const payload = combatEvent!.payload as { attackerHeroOutcome: 'won' | 'lost' | null };
    // The hero must have actually been offered into the fight — an outcome of null here (which
    // combat.ts only ever produces when the army's own dice already fill every pairing slot
    // before the hero's die ranks in) would mean this fixture's numbers accidentally starved the
    // hero of a pairing rather than exercising the join path end to end.
    expect(payload.attackerHeroOutcome).not.toBeNull();

    const afterHero = after!.players.find((p) => p.id === 'p1')!.hero;
    // Win, lose, or (at 0 HP) permadeath-respawn to the Capital — MoveSoldiers itself never
    // relocates a surviving hero away from where it started.
    if (afterHero.id === heroId && afterHero.hp > 0) {
      expect(afterHero.position).toEqual(before.position);
    }
  });

  it('a hero the AI declines to join is never referenced by the proposed action at all', () => {
    const { state } = makeMarchScenario({ heroAtFromCoord: false });
    const action = expectMoveSoldiers(decideAction(state, 'p1'));
    expect(action.heroId).toBeUndefined();
    expect(action.heroJoins).toBeUndefined();
    // Applying it must still succeed — an absent heroJoins flag is exactly the pre-existing,
    // hero-untouched code path.
    expect(() => applyAction(state, action)).not.toThrow();
  });
});
