import { describe, expect, it } from 'vitest';
import { createGame, hexNeighbors, hexKey } from '@/engine';
import { findBestTerritoryAttack } from '../territoryMinimax';

const PLAYERS = [
  { id: 'p1', name: 'Alice', color: '#f00' },
  { id: 'p2', name: 'Bob', color: '#0f0' },
];

/** Builds a state where p1 has a Barracks with `attackerMilitia` units, adjacent to a rival
 *  tile with `defenderMilitia` units (optionally Watchtower-fortified). */
function makeAttackScenario(attackerMilitia: number, defenderMilitia: number, defenderWatchtower: boolean) {
  const state = structuredClone(createGame('g', PLAYERS, 'minimax-seed', 'hotseat'));
  const p1 = state.players.find((p) => p.id === 'p1')!;
  const p2 = state.players.find((p) => p.id === 'p2')!;

  const barracksCoord = p1.capitalTile;
  state.map[hexKey(barracksCoord)].building = { id: 'b1', type: 'Barracks', coord: barracksCoord, ownerId: 'p1' };
  state.map[hexKey(barracksCoord)].militiaCount = attackerMilitia;

  const targetCoord = hexNeighbors(barracksCoord)[0];
  state.map[hexKey(targetCoord)] = {
    coord: targetCoord,
    type: 'Plains',
    ownerId: 'p2',
    building: defenderWatchtower ? { id: 'wt', type: 'Watchtower', coord: targetCoord, ownerId: 'p2' } : null,
    monsterDenCardId: null,
    stockpile: { Wood: 0, Stone: 0, Food: 0, Ore: 0, Meat: 0, Gold: 0 },
    militiaCount: defenderMilitia,
  };
  p2.ownedTiles.push(targetCoord);

  return state;
}

describe('findBestTerritoryAttack', () => {
  it('returns null when the player has no Barracks at all', () => {
    const state = createGame('g0', PLAYERS, 'minimax-seed-0', 'hotseat');
    expect(findBestTerritoryAttack(state, 'p1')).toBeNull();
  });

  it('returns null when the Barracks has no militia', () => {
    const state = makeAttackScenario(0, 2, false);
    expect(findBestTerritoryAttack(state, 'p1')).toBeNull();
  });

  it('recommends attacking an overwhelmingly favorable target (5 vs 1, undefended)', () => {
    const state = makeAttackScenario(5, 1, false);
    const result = findBestTerritoryAttack(state, 'p1');
    expect(result).not.toBeNull();
    expect(result!.attackingUnits).toBeGreaterThan(0);
  });

  it('declines a clearly bad trade (1 vs 5, Watchtower-fortified)', () => {
    const state = makeAttackScenario(1, 5, true);
    expect(findBestTerritoryAttack(state, 'p1')).toBeNull();
  });

  it('never recommends more units than are actually available at the Barracks', () => {
    const state = makeAttackScenario(4, 1, false);
    const result = findBestTerritoryAttack(state, 'p1');
    expect(result).not.toBeNull();
    expect(result!.attackingUnits).toBeLessThanOrEqual(4);
  });

  it('the recommended target is always a tile the player does not own', () => {
    const state = makeAttackScenario(5, 1, false);
    const result = findBestTerritoryAttack(state, 'p1');
    expect(result).not.toBeNull();
    const tile = state.map[hexKey(result!.targetCoord)];
    expect(tile.ownerId).not.toBe('p1');
  });
});
