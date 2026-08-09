/**
 * Deterministic, counter-based PRNG.
 *
 * The reducer must be a pure function of (state, action) — see docs/data-model.md's "Replay
 * parity" note — so there is no module-level `Math.random()` anywhere in this engine. Instead
 * every draw is `hash(rngSeed, cursor)`, and `GameState.rngCursor` is the only persisted
 * mutable piece, advanced by however many draws an action consumed. Same seed + same cursor
 * always produces the same value, on any machine, forever.
 */

function hashSeedToInt(seed: string): number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

/** Murmur3-style finalizer to mix two 32-bit ints into one well-distributed 32-bit int. */
function mix(a: number, b: number): number {
  let h = (a ^ Math.imul(b, 0x9e3779b1)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Deterministic float in [0, 1) for a given seed + draw index. */
export function randomAt(seed: string, cursor: number): number {
  return mix(hashSeedToInt(seed), cursor) / 4294967296;
}

/** A 1-6 die roll for a given seed + draw index. */
export function rollDieAt(seed: string, cursor: number): number {
  return 1 + Math.floor(randomAt(seed, cursor) * 6);
}

/**
 * Stateful helper scoped to a single reducer call. Wraps `randomAt`/`rollDieAt` so calling
 * code can draw as many values as it needs (e.g. shuffling a fresh deck) without manually
 * threading a cursor through every function call. Never persisted — callers read
 * `stream.cursor` once at the end and write it back to `GameState.rngCursor`.
 */
export class RngStream {
  cursor: number;
  private readonly seed: string;

  constructor(seed: string, startCursor: number) {
    this.seed = seed;
    this.cursor = startCursor;
  }

  next(): number {
    const value = randomAt(this.seed, this.cursor);
    this.cursor += 1;
    return value;
  }

  rollDie(): number {
    return 1 + Math.floor(this.next() * 6);
  }

  /** Warrior's extra-combat-die perk: 2d6, keep the higher single die. */
  rollDieWithAdvantage(hasAdvantage: boolean): number {
    if (!hasAdvantage) return this.rollDie();
    return Math.max(this.rollDie(), this.rollDie());
  }

  /** Uniform int in [0, maxExclusive). */
  nextInt(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  /** Fisher-Yates shuffle, drawing one random value per swap. Returns a new array. */
  shuffle<T>(items: readonly T[]): T[] {
    const arr = items.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.nextInt(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}
