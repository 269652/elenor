'use client';

/**
 * [DEFAULT — hero battle participation, direct request: "Heroes should be able to partake in
 * battles in a senseful manner... find a fair equation between risk and the hero. If the hero
 * dies a new one is spawned without any of the items or skills of the last one."]
 *
 * Post-battle readout for a hero that joined an Army vs Territory fight (engine/combat.ts's
 * resolveArmyVsTerritory hero-die extension, wired in engine/reducers.ts's applyMoveSoldiers) —
 * either as the attacker (heroJoins) or the defender (present automatically, no flag). Mirrors
 * DoorCardPanel.tsx's own "diff GameState across renders during render, not useEffect" pattern
 * (see its comment on why an effect would just reproduce this a render late and trips
 * react-hooks/set-state-in-effect) for the same reason: eventLog growth only ever happens
 * because this component just got new props, there's no external system to subscribe to.
 *
 * Why events AND a hero-state diff, not just one: CombatResolved's payload carries the outcome
 * ('won'/'lost') and the HP cost per SIDE, but never confirms it was THIS player's hero specifically
 * (vs. some other reason the event fired) — grantXp's win case pushes no event at all. So a
 * qualifying CombatResolved event gates "something happened to this player's hero," and comparing
 * that player's hero xp (win) or hp (loss) against the previous render's snapshot — matched by
 * hero.id, which is stable across a permadeath respawn (respawnHeroFromDeath reuses the same id) —
 * confirms it and by how much. HeroDied is the one exception: its payload already carries heroId
 * directly (and hp-diffing can't spot a death anyway, since a fresh hero spawns at full HP, not
 * lower).
 *
 * Deliberately NOT scoped to "the local player" — GameBoardApp has no such concept to hand it
 * (see OnlineGameClient.tsx: myPlayerId never reaches GameBoardApp, only isMyTurn does), and in
 * hotseat pass-and-play "whoever's turn it is" already covers both roles: the attacker sees their
 * own outcome the instant they click Attack, and a defender sees theirs the next time this
 * continuously-mounted component renders with their own turn's fresh state.
 */

import { useCallback, useEffect, useState } from 'react';
import { getMonsterById, type GameState, type HeroState, type LootCard, type Player } from '@/engine';

function heroesOf(player: Player): HeroState[] {
  return [player.hero];
}

function safeGetMonster(id: string) {
  try {
    return getMonsterById(id);
  } catch {
    return undefined;
  }
}

interface CombatResolvedPayload {
  combatType?: unknown;
  defenderId?: unknown;
  attackerHeroOutcome?: unknown;
  defenderHeroOutcome?: unknown;
  attackerHeroDamage?: unknown;
  defenderHeroDamage?: unknown;
  // [DEFAULT — UI feedback change] HeroVsMonster / TameVolcano fields — see reducers.ts's
  // applyFightMonster/applyTameVolcano, which now push these directly rather than making the UI
  // reconstruct them by diffing hero state (unreliable on a knockout: hp goes UP, not down, once
  // applyHeroDamage's clamp resets it to max and teleports the hero home).
  win?: unknown;
  monsterId?: unknown;
  source?: unknown;
  xpGained?: unknown;
  hpDamage?: unknown;
  wasKnockedOut?: unknown;
  curseCardId?: unknown;
  lootCardId?: unknown;
}

interface HeroDiedPayload {
  heroId?: unknown;
  cause?: unknown;
}

type BattleNotice =
  | { kind: 'won'; playerName: string; playerColor: string; xp: number }
  | { kind: 'hurt'; playerName: string; playerColor: string; damage: number; hp: number; maxHp: number }
  | { kind: 'died'; playerName: string; playerColor: string }
  // [DEFAULT — UI feedback change, direct request: "not obvious what happens when you fight a
  // door monster or whether you got loot or died"] HeroVsMonster/TameVolcano outcomes — same
  // banner mechanism as the Army-vs-Territory notices above, generalized to the OTHER two combat
  // types nothing was showing feedback for at all.
  | {
      kind: 'monsterWon';
      playerName: string;
      playerColor: string;
      monsterName: string;
      monsterLevel: number;
      source: 'RuinsDen' | 'Door';
      xp: number;
      loot: LootCard | null;
    }
  | {
      kind: 'monsterLost';
      playerName: string;
      playerColor: string;
      monsterName: string;
      monsterLevel: number;
      source: 'RuinsDen' | 'Door';
      damage: number;
      knockedOut: boolean;
      curseName: string | null;
      curseEffect: string | null;
    }
  | { kind: 'volcanoWon'; playerName: string; playerColor: string; loot: LootCard | null }
  | { kind: 'volcanoLost'; playerName: string; playerColor: string; damage: number; knockedOut: boolean; curseName: string | null; curseEffect: string | null };

interface QueuedNotice {
  seq: string;
  notice: BattleNotice;
}

/** Finds which of `player`'s heroes this side's outcome was about, by comparing against the
 *  previous render's snapshot of the same player (matched by hero.id, stable across respawn). */
function pickAffectedHero(
  player: Player,
  prevPlayer: Player,
  diedKeys: ReadonlySet<string>,
  wantWin: boolean
): { hero: HeroState; prevHero: HeroState; died: boolean } | null {
  for (const hero of heroesOf(player)) {
    const prevHero = heroesOf(prevPlayer).find((h) => h.id === hero.id);
    if (!prevHero) continue;
    if (diedKeys.has(`${player.id}:${hero.id}`)) return { hero, prevHero, died: true };
    if (wantWin && hero.xp > prevHero.xp) return { hero, prevHero, died: false };
    if (!wantWin && hero.hp < prevHero.hp) return { hero, prevHero, died: false };
  }
  return null;
}

export function HeroBattleBanner({ state }: { state: GameState }) {
  const [queue, setQueue] = useState<QueuedNotice[]>([]);
  // Previous render's `state` prop — see the file-level comment for why this (not an effect) is
  // the right tool here, matching DoorCardPanel.tsx's identical pattern.
  const [lastSeenState, setLastSeenState] = useState(state);

  if (state !== lastSeenState) {
    if (state.eventLog.length < lastSeenState.eventLog.length) {
      // A shorter log than last time means a new game replaced this one — resync rather than
      // let slice() see a stale, too-large starting index.
      setLastSeenState(state);
    } else {
      const newEvents = state.eventLog.slice(lastSeenState.eventLog.length);

      const diedKeys = new Set(
        newEvents
          .filter((e) => e.type === 'HeroDied' && (e.payload as HeroDiedPayload).cause === 'ArmyVsTerritory')
          .map((e) => `${e.actorId}:${(e.payload as HeroDiedPayload).heroId}`)
      );

      const notices: QueuedNotice[] = [];
      for (const evt of newEvents) {
        if (evt.type !== 'CombatResolved') continue;
        const payload = evt.payload as CombatResolvedPayload;

        // [DEFAULT — UI feedback change] HeroVsMonster (Ruins Den or Door) and TameVolcano: the
        // acting player's own hero is always the one who fought (no attacker/defender split like
        // ArmyVsTerritory below), and every number needed is now on the payload directly — see
        // applyFightMonster/applyTameVolcano in reducers.ts.
        if (payload.combatType === 'HeroVsMonster' || payload.combatType === 'TameVolcano') {
          const playerId = evt.actorId;
          if (playerId === 'system') continue;
          const player = state.players.find((p) => p.id === playerId);
          if (!player) continue;
          const hero = player.hero;
          const win = payload.win === true;
          const seq = `battle-${evt.seq}`;

          const lootCardId = typeof payload.lootCardId === 'string' ? payload.lootCardId : null;
          const loot = lootCardId ? hero.inventory.find((c) => c.id === lootCardId) ?? null : null;
          const curseCardId = typeof payload.curseCardId === 'string' ? payload.curseCardId : null;
          const curse = curseCardId ? hero.activeCurses.find((c) => c.id === curseCardId) ?? null : null;
          const damage = typeof payload.hpDamage === 'number' ? payload.hpDamage : 0;
          const knockedOut = payload.wasKnockedOut === true;

          if (payload.combatType === 'HeroVsMonster') {
            const monsterId = typeof payload.monsterId === 'string' ? payload.monsterId : undefined;
            const monster = monsterId ? safeGetMonster(monsterId) : undefined;
            const monsterName = monster?.name ?? 'the monster';
            const monsterLevel = monster?.level ?? 1;
            const source = payload.source === 'Door' ? 'Door' : 'RuinsDen';
            if (win) {
              const xp = typeof payload.xpGained === 'number' ? payload.xpGained : 0;
              notices.push({ seq, notice: { kind: 'monsterWon', playerName: player.name, playerColor: player.color, monsterName, monsterLevel, source, xp, loot } });
            } else {
              notices.push({
                seq,
                notice: {
                  kind: 'monsterLost',
                  playerName: player.name,
                  playerColor: player.color,
                  monsterName,
                  monsterLevel,
                  source,
                  damage,
                  knockedOut,
                  curseName: curse?.name ?? null,
                  curseEffect: curse?.effectDescription ?? null,
                },
              });
            }
          } else {
            // TameVolcano
            if (win) {
              notices.push({ seq, notice: { kind: 'volcanoWon', playerName: player.name, playerColor: player.color, loot } });
            } else {
              notices.push({
                seq,
                notice: {
                  kind: 'volcanoLost',
                  playerName: player.name,
                  playerColor: player.color,
                  damage,
                  knockedOut,
                  curseName: curse?.name ?? null,
                  curseEffect: curse?.effectDescription ?? null,
                },
              });
            }
          }
          continue;
        }

        if (payload.combatType !== 'ArmyVsTerritory') continue;

        const sides = [
          { side: 'attacker', playerId: evt.actorId, outcome: payload.attackerHeroOutcome, damage: payload.attackerHeroDamage },
          { side: 'defender', playerId: payload.defenderId, outcome: payload.defenderHeroOutcome, damage: payload.defenderHeroDamage },
        ] as const;

        for (const s of sides) {
          if (s.outcome !== 'won' && s.outcome !== 'lost') continue;
          const playerId = typeof s.playerId === 'string' ? s.playerId : undefined;
          if (!playerId) continue;
          const player = state.players.find((p) => p.id === playerId);
          const prevPlayer = lastSeenState.players.find((p) => p.id === playerId);
          if (!player || !prevPlayer) continue;

          const found = pickAffectedHero(player, prevPlayer, diedKeys, s.outcome === 'won');
          if (!found) continue;
          const seq = `battle-${evt.seq}-${s.side}`;

          if (found.died) {
            notices.push({ seq, notice: { kind: 'died', playerName: player.name, playerColor: player.color } });
          } else if (s.outcome === 'won') {
            notices.push({
              seq,
              notice: { kind: 'won', playerName: player.name, playerColor: player.color, xp: found.hero.xp - found.prevHero.xp },
            });
          } else {
            const damage = typeof s.damage === 'number' ? s.damage : found.prevHero.hp - found.hero.hp;
            notices.push({
              seq,
              notice: {
                kind: 'hurt',
                playerName: player.name,
                playerColor: player.color,
                damage,
                hp: found.hero.hp,
                maxHp: found.hero.maxHp,
              },
            });
          }
        }
      }

      if (notices.length > 0) setQueue((q) => [...q, ...notices]);
      setLastSeenState(state);
    }
  }

  // One at a time, same as DoorCardPanel's reveal queue — a fast run of AI turns shouldn't stack
  // overlapping banners. A death is grave enough to need an explicit dismissal; a win or a
  // scrape auto-clears so it doesn't linger and clutter the sidebar.
  const active = queue.length > 0 ? queue[0] : null;
  const dismiss = useCallback(() => setQueue((q) => q.slice(1)), []);
  useEffect(() => {
    if (!active || active.notice.kind === 'died') return;
    const t = setTimeout(dismiss, 4200);
    return () => clearTimeout(t);
  }, [active, dismiss]);

  if (!active) return null;
  const { notice } = active;

  if (notice.kind === 'died') {
    return (
      <div className="flex items-start gap-2 rounded-sm border-2 border-hx-blood bg-hx-blood/25 px-3 py-2 text-xs text-hx-ink shadow-[0_0_18px_-4px_rgba(178,58,58,0.9)] motion-safe:animate-shimmer">
        <span className="text-lg" aria-hidden="true">💀</span>
        <div className="flex flex-1 flex-col gap-0.5">
          <span className="font-display text-sm font-bold text-hx-blood">
            <span style={{ color: notice.playerColor }}>{notice.playerName}</span>&rsquo;s hero has fallen — permanently
          </span>
          <span className="text-[11px] text-hx-ink-dim">
            Lost in the field to Army vs Territory combat. A fresh level-1 hero has taken their place — no gear, XP, levels, or curses carried over.
          </span>
        </div>
        <button type="button" onClick={dismiss} className="shrink-0 text-hx-ink-faint transition hover:text-hx-ink" aria-label="Dismiss">
          ✖
        </button>
      </div>
    );
  }

  if (notice.kind === 'won') {
    return (
      <div className="flex items-center gap-2 rounded-sm border border-hx-moss/60 bg-hx-moss/15 px-2.5 py-1.5 text-xs text-hx-ink">
        <span aria-hidden="true">🗡️</span>
        <span className="flex-1">
          <span style={{ color: notice.playerColor }}>{notice.playerName}</span>&rsquo;s hero won its clash — +{notice.xp} XP
        </span>
        <button type="button" onClick={dismiss} className="shrink-0 text-hx-ink-faint transition hover:text-hx-ink" aria-label="Dismiss">
          ✖
        </button>
      </div>
    );
  }

  // [DEFAULT — UI feedback change] HeroVsMonster win — "not obvious whether you got loot" is
  // exactly what this closes: XP, source (door vs. den), and the drawn Loot card's name/rarity
  // all in one line.
  if (notice.kind === 'monsterWon') {
    return (
      <div className="flex items-center gap-2 rounded-sm border border-hx-moss/60 bg-hx-moss/15 px-2.5 py-1.5 text-xs text-hx-ink">
        <span aria-hidden="true">{notice.source === 'Door' ? '🚪⚔️' : '⚔️'}</span>
        <span className="flex-1">
          <span style={{ color: notice.playerColor }}>{notice.playerName}</span>&rsquo;s hero defeated {notice.monsterName} (Lv {notice.monsterLevel}) — +
          {notice.xp} XP
          {notice.loot && (
            <>
              , found <strong className="text-hx-gold">{notice.loot.rarity} {notice.loot.name}</strong>
            </>
          )}
        </span>
        <button type="button" onClick={dismiss} className="shrink-0 text-hx-ink-faint transition hover:text-hx-ink" aria-label="Dismiss">
          ✖
        </button>
      </div>
    );
  }

  // HeroVsMonster loss — either a straight HP hit, or a full knockout (healed to max, hauled
  // home), plus whichever Bad Stuff curse got drawn.
  if (notice.kind === 'monsterLost') {
    return (
      <div className="flex items-start gap-2 rounded-sm border border-hx-copper/60 bg-hx-copper/15 px-2.5 py-1.5 text-xs text-hx-ink">
        <span aria-hidden="true">{notice.source === 'Door' ? '🚪🩸' : '🩸'}</span>
        <span className="flex-1">
          <span style={{ color: notice.playerColor }}>{notice.playerName}</span>&rsquo;s hero was bested by {notice.monsterName} (Lv {notice.monsterLevel}) —{' '}
          {notice.knockedOut ? (
            <>knocked out and dragged home, full HP restored</>
          ) : (
            <>took {notice.damage} HP damage</>
          )}
          {notice.curseName && (
            <span className="block text-[10px] text-hx-blood">
              Cursed: <strong>{notice.curseName}</strong>
              {notice.curseEffect && <> — {notice.curseEffect}</>}
            </span>
          )}
        </span>
        <button type="button" onClick={dismiss} className="shrink-0 text-hx-ink-faint transition hover:text-hx-ink" aria-label="Dismiss">
          ✖
        </button>
      </div>
    );
  }

  if (notice.kind === 'volcanoWon') {
    return (
      <div className="flex items-center gap-2 rounded-sm border border-hx-gold/60 bg-hx-gold/15 px-2.5 py-1.5 text-xs text-hx-ink">
        <span aria-hidden="true">🌋</span>
        <span className="flex-1">
          <span style={{ color: notice.playerColor }}>{notice.playerName}</span>&rsquo;s hero tamed the Volcano! +5 Gold
          {notice.loot && (
            <>
              , found <strong className="text-hx-gold">Legendary {notice.loot.name}</strong>
            </>
          )}
        </span>
        <button type="button" onClick={dismiss} className="shrink-0 text-hx-ink-faint transition hover:text-hx-ink" aria-label="Dismiss">
          ✖
        </button>
      </div>
    );
  }

  if (notice.kind === 'volcanoLost') {
    return (
      <div className="flex items-start gap-2 rounded-sm border border-hx-copper/60 bg-hx-copper/15 px-2.5 py-1.5 text-xs text-hx-ink">
        <span aria-hidden="true">🌋🩸</span>
        <span className="flex-1">
          <span style={{ color: notice.playerColor }}>{notice.playerName}</span>&rsquo;s hero failed to tame the Volcano —{' '}
          {notice.knockedOut ? (
            <>knocked out and dragged home, full HP restored</>
          ) : (
            <>took {notice.damage} HP damage</>
          )}
          {notice.curseName && (
            <span className="block text-[10px] text-hx-blood">
              Cursed: <strong>{notice.curseName}</strong>
              {notice.curseEffect && <> — {notice.curseEffect}</>}
            </span>
          )}
        </span>
        <button type="button" onClick={dismiss} className="shrink-0 text-hx-ink-faint transition hover:text-hx-ink" aria-label="Dismiss">
          ✖
        </button>
      </div>
    );
  }

  // Only 'hurt' (Army vs Territory scrape) remains.
  return (
    <div className="flex items-center gap-2 rounded-sm border border-hx-copper/60 bg-hx-copper/15 px-2.5 py-1.5 text-xs text-hx-ink">
      <span aria-hidden="true">🩸</span>
      <span className="flex-1">
        <span style={{ color: notice.playerColor }}>{notice.playerName}</span>&rsquo;s hero took {notice.damage} HP in the clash ({notice.hp}/{notice.maxHp} HP left)
      </span>
      <button type="button" onClick={dismiss} className="shrink-0 text-hx-ink-faint transition hover:text-hx-ink" aria-label="Dismiss">
        ✖
      </button>
    </div>
  );
}
