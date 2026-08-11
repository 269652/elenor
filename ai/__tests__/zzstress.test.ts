import { describe, it, expect } from 'vitest';
import { applyAction, createGame, checkMovePath, hexNeighbors, movementRangeFor, hexKey, Phase } from '@/engine';
import { decideAction } from '@/ai/decideAction';

// Simple xorshift PRNG for reproducible "human" randomness in the test itself.
function mkRng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

describe('mixed human+AI stress', () => {
  it('human takes a random legal move mid-turn, then AI resumes — never illegal', () => {
    const players = [
      { id: 'p1', name: 'A', color: '#f00' },
      { id: 'p2', name: 'B', color: '#0f0' },
      { id: 'p3', name: 'C', color: '#00f' },
    ];
    const failures: string[] = [];
    let totalGames = 0;

    for (let seedNum = 0; seedNum < 60; seedNum++) {
      const seed = `mixed-seed-${seedNum}`;
      const rng = mkRng(seedNum + 1);
      let state = createGame(`game-${seed}`, players, seed, 'hotseat');
      totalGames++;
      let actionsThisTurn = 0;
      let lastPlayer = state.currentPlayerId;

      for (let i = 0; i < 4000 && !state.winnerId; i++) {
        if (state.currentPlayerId !== lastPlayer) { actionsThisTurn = 0; lastPlayer = state.currentPlayerId; }
        actionsThisTurn++;

        let action;
        // 15% of the time in MoveHero phase, simulate a human moving somewhere RANDOM (not
        // decideMove's chosen best) instead of letting the AI choose — mimics a human manually
        // steering the hero before handing off to autoplay for the rest of the turn.
        if (state.currentPhase === Phase.MoveHero && !state.hasMovedThisTurn && rng() < 0.15) {
          const player = state.players.find((p) => p.id === state.currentPlayerId)!;
          const hero = player.hero;
          const range = movementRangeFor(hero);
          // BFS reachable hexes, same shape as decideMove's own findReachableHexes
          const visited = new Set<string>([hexKey(hero.position)]);
          let frontier: { coord: typeof hero.position; path: typeof hero.position[] }[] = [{ coord: hero.position, path: [] }];
          const all: typeof frontier = [];
          for (let step = 0; step < range && frontier.length > 0; step++) {
            const next: typeof frontier = [];
            for (const { coord, path } of frontier) {
              for (const n of hexNeighbors(coord)) {
                const key = hexKey(n);
                if (visited.has(key)) continue;
                const candidatePath = [...path, n];
                if (!checkMovePath(state, player, hero, candidatePath).legal) continue;
                visited.add(key);
                all.push({ coord: n, path: candidatePath });
                next.push({ coord: n, path: candidatePath });
              }
            }
            frontier = next;
          }
          if (all.length > 0) {
            const pick = all[Math.floor(rng() * all.length)];
            action = { type: 'MoveHero' as const, actorId: player.id, path: pick.path };
          }
        }

        if (!action) action = decideAction(state, state.currentPlayerId);

        try {
          state = applyAction(state, action);
        } catch (err) {
          failures.push(`seed=${seed} action=${i} phase=${state.currentPhase} actionsThisTurn=${actionsThisTurn} proposed=${JSON.stringify(action)} err=${(err as Error).message}`);
          break;
        }
        if (actionsThisTurn > 100) {
          failures.push(`seed=${seed} action=${i} STUCK phase=${state.currentPhase} actionsThisTurn=${actionsThisTurn}`);
          break;
        }
      }
    }

    if (failures.length > 0) {
      console.log('FAILURES:', failures.length, 'of', totalGames);
      console.log(failures.slice(0, 30).join('\n'));
    } else {
      console.log('No failures across', totalGames, 'mixed games');
    }
    expect(failures.length).toBe(0);
  }, 300000);
});
