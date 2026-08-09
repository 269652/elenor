'use client';

/**
 * [DEFAULT — Munchkin exploration layer, UI] Visible Door/Treasure deck piles plus the two draw
 * animations: a Door card flying out and flipping face-up when GameState.eventLog gets a fresh
 * 'DoorCardDrawn' event (see engine/reducers.ts's resolveDoorCardIfNewTile for the exact payload
 * shape), and a Treasure card doing the same whenever a hero's `inventory` gains a new LootCard
 * off the back of a qualifying event (a won HeroVsMonster/TameVolcano fight, a Ruins loot, or a
 * FreeTreasure Utility card).
 *
 * Why diff `inventory` instead of trusting the event payload for the Treasure reveal: none of
 * CombatResolved / RuinsLooted / DoorCardDrawn carry the actual drawn LootCard on the wire (only
 * RuinsLooted even carries a lootCardId, and that's just the id) — the reducer only tells us
 * "you won" or "you looted," never "here is the card." Comparing each hero's inventory array
 * before/after the triggering event recovers the exact card (name/rarity/bonus) for the reveal
 * without touching engine/reducers.ts to add it there. Gated behind specific event types (rather
 * than diffing on every render) so a Hero-vs-Hero loot STEAL — which also changes two heroes'
 * inventories, but pulls from a rival, not the Treasure deck — never misfires this animation.
 *
 * Card-flip accessibility note: the flip's `animate-card-flip` class is applied UNCONDITIONALLY
 * (not behind motion-safe:), with `motion-reduce:` only compressing its duration to ~instant.
 * Every other animation token in this file follows the established fade/pop convention (skip the
 * animation entirely under reduced motion, resting state is already correct) — but a face-flip is
 * a binary reveal, not a decorative embellishment: if `motion-safe:animate-card-flip` were simply
 * omitted under reduced motion, the front face would never rotate into view and the card's content
 * would never actually be shown. Playing the animation at ~0 duration keeps the guarantee ("the
 * content is always revealed") while still fully respecting prefers-reduced-motion (no perceptible
 * motion plays).
 */

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import clsx from 'clsx';
import {
  buildUtilityCatalog,
  getMonsterById,
  type Action,
  type GameState,
  type HeroState,
  type HexKey,
  type LootCard,
  type LootRarity,
  type MonsterCard,
  type Player,
  type UtilityCard,
} from '@/engine';
import { BTN_DANGER, PANEL } from '@/components/uiClasses';

// ── Utility catalog lookup ──────────────────────────────────────────────────────────────────
// Mirrors engine/catalogs.ts's own getMonsterById memoization pattern — buildUtilityCatalog()
// is a stable, deterministic list (see catalogs.ts), so building the id map once and reusing it
// is safe and avoids re-walking ~35 templates on every card reveal.
let utilityByIdCache: Map<string, UtilityCard> | null = null;
function getUtilityById(id: string): UtilityCard | undefined {
  if (!utilityByIdCache) utilityByIdCache = new Map(buildUtilityCatalog().map((u) => [u.id, u]));
  return utilityByIdCache.get(id);
}

function safeGetMonster(id: string): MonsterCard | undefined {
  try {
    return getMonsterById(id);
  } catch {
    return undefined;
  }
}

const UTILITY_EFFECT_BLURB: Record<UtilityCard['effectKind'], (amount: number | undefined) => string> = {
  GainWood: (n) => `+${n ?? 1} Wood`,
  GainStone: (n) => `+${n ?? 1} Stone`,
  GainFood: (n) => `+${n ?? 1} Food`,
  GainOre: (n) => `+${n ?? 1} Ore`,
  GainMeat: (n) => `+${n ?? 1} Meat`,
  GainGold: (n) => `+${n ?? 1} Gold`,
  HealHp: (n) => `Heals ${n ?? 1} HP`,
  DamageHp: (n) => `${n ?? 1} HP damage`,
  GainXp: (n) => `+${n ?? 1} XP`,
  FreeTreasure: () => 'Draws a free Treasure card — no fight',
  Nothing: () => 'Nothing happens — just flavor',
};

const RARITY_COLOR: Record<LootRarity, string> = {
  Common: 'text-hx-ink-dim',
  Uncommon: 'text-hx-moss',
  Rare: 'text-hx-arcane',
  Legendary: 'text-hx-gold-bright',
};

/** 1-10 monster level compressed into a 1-5 skull threat readout — same five-tier feel as the
 *  Loot rarity ladder (types.ts's LOOT_RARITY_BONUS), just for the thing you're about to fight
 *  instead of what you'd win. */
function threatSkulls(level: number): number {
  return Math.min(5, Math.max(1, Math.ceil(level / 2)));
}

type Reveal =
  | { deck: 'door'; kind: 'Monster'; name: string; level: number; specialAbility?: string }
  | { deck: 'door'; kind: 'Utility'; name: string; flavor: string; effectKind: UtilityCard['effectKind']; amount?: number }
  | { deck: 'treasure'; card: LootCard };

function heroesOf(player: Player): HeroState[] {
  return [player.hero];
}

// ── Pending mandatory Door-monster fight ────────────────────────────────────────────────────

/** True while `state.pendingDoorMonster` belongs to one of THIS player's heroes — the engine's
 *  requireNoPendingDoorMonster (reducers.ts) blocks AdvancePhase out of Phase 4 and blocks EndTurn
 *  outright while this holds, so the UI needs the identical check to warn before a click bounces. */
export function isDoorMonsterPendingFor(state: GameState, player: Player): boolean {
  const pending = state.pendingDoorMonster;
  if (!pending) return false;
  return pending.heroId === player.hero.id;
}

/** [DEFAULT — Munchkin exploration layer, UI] The mandatory-encounter callout for the Fight
 *  phase panel (item 4 of the task) — a hero can't leave Phase 4 or end their turn with this
 *  unresolved (see requireNoPendingDoorMonster), so it needs to read as unmissable, not as one
 *  more option among the Ruins/Volcano/duel buttons already in that panel. */
export function PendingDoorMonsterBanner({
  state,
  player,
  dispatch,
  canAct,
}: {
  state: GameState;
  player: Player;
  dispatch: (action: Action) => boolean | Promise<boolean>;
  canAct: boolean;
}) {
  const pending = state.pendingDoorMonster;
  if (!pending || !isDoorMonsterPendingFor(state, player)) return null;

  const monster = safeGetMonster(pending.monsterCardId);
  const heroId = pending.heroId === player.hero.id ? undefined : pending.heroId;

  return (
    <div className="flex flex-col gap-2 rounded-sm border-2 border-hx-blood bg-hx-blood/20 p-3 shadow-[0_0_18px_-4px_rgba(178,58,58,0.9)] motion-safe:animate-shimmer">
      <div className="flex items-center gap-2">
        <span className="text-xl motion-safe:animate-pop" aria-hidden="true">
          🚪👹
        </span>
        <div className="flex flex-col">
          <span className="font-mono text-[10px] font-bold uppercase tracking-wide text-hx-blood">⚠ Mandatory encounter</span>
          <span className="font-display text-sm font-bold text-hx-ink">
            {monster ? monster.name : 'A monster'} came through the door{monster ? ` — Level ${monster.level}` : ''}
          </span>
        </div>
      </div>
      <p className="text-[11px] text-hx-ink-dim">
        You can&rsquo;t advance past this phase — or end your turn — until this fight is resolved. It doesn&rsquo;t count against your one
        Fight-phase action.
      </p>
      <button
        type="button"
        disabled={!canAct}
        onClick={() =>
          void dispatch({
            type: 'Fight',
            actorId: player.id,
            combatType: 'HeroVsMonster',
            coord: pending.coord,
            monsterCardId: pending.monsterCardId,
            heroId,
          })
        }
        className={clsx(BTN_DANGER, 'border-hx-blood bg-hx-blood/40 text-center text-sm font-bold hover:bg-hx-blood/55')}
      >
        ⚔️ Fight {monster ? monster.name : 'the Monster'}!
      </button>
    </div>
  );
}

// ── Deck piles + draw animations ────────────────────────────────────────────────────────────

interface DoorCardDrawnPayload {
  heroId?: unknown;
  coord?: unknown;
  kind?: unknown;
  monsterId?: unknown;
  monsterName?: unknown;
  utilityId?: unknown;
  utilityName?: unknown;
  effectKind?: unknown;
}

function totalLootRemaining(state: GameState): number {
  return Object.values(state.lootDeck.drawPiles).reduce((sum, pile) => sum + pile.length, 0);
}

interface QueuedReveal {
  /** Globally unique for the life of the game — see the two branches below for where each comes
   *  from. Needed because `queue` can go straight from one reveal to the next (dismiss just drops
   *  index 0) with no intervening render where RevealOverlay is absent, so React relies entirely
   *  on this key — not a remount-from-nothing — to know a genuinely new card replaced the old
   *  one and its deal/flip CSS animations should restart. */
  seq: string;
  reveal: Reveal;
}

export function DoorCardPanel({ state }: { state: GameState }) {
  const [queue, setQueue] = useState<QueuedReveal[]>([]);
  // The previous render's `state` prop, per React's documented "adjusting state when a prop
  // changes" pattern (https://react.dev/reference/react/useState#storing-information-from-previous-renders)
  // — comparing against it and conditionally calling setState directly in the render body (below)
  // is the blessed alternative to an effect here: eventLog growth only ever happens because THIS
  // component just got new props, there's no actual external system to subscribe to, so an effect
  // would just be reproducing "if a prop changed, derive some state" one render late (and trips
  // react-hooks/set-state-in-effect for exactly that reason).
  const [lastSeenState, setLastSeenState] = useState(state);

  if (state !== lastSeenState) {
    if (state.eventLog.length < lastSeenState.eventLog.length) {
      // A shorter log than last time means a new game replaced this one (eventLog is append-only
      // within a single game — see types.ts) — resync rather than let slice() see a stale,
      // too-large starting index.
      setLastSeenState(state);
    } else {
      const newEvents = state.eventLog.slice(lastSeenState.eventLog.length);
      const reveals: QueuedReveal[] = [];
      let sawTreasureEvent = false;

      for (const evt of newEvents) {
        if (evt.type === 'DoorCardDrawn') {
          // evt.seq (GameEvent's own append-only sequence tick — see types.ts) is already a
          // stable, globally-unique id for this exact draw; no separate counter needed.
          const seq = `door-${evt.seq}`;
          const payload = evt.payload as DoorCardDrawnPayload;
          if (payload.kind === 'Monster') {
            const monsterId = typeof payload.monsterId === 'string' ? payload.monsterId : undefined;
            const catalogCard = monsterId ? safeGetMonster(monsterId) : undefined;
            const name = typeof payload.monsterName === 'string' ? payload.monsterName : catalogCard?.name ?? 'Unknown foe';
            reveals.push({ seq, reveal: { deck: 'door', kind: 'Monster', name, level: catalogCard?.level ?? 1, specialAbility: catalogCard?.specialAbility } });
          } else if (payload.kind === 'Utility') {
            const utilityId = typeof payload.utilityId === 'string' ? payload.utilityId : undefined;
            const catalogCard = utilityId ? getUtilityById(utilityId) : undefined;
            const effectKind = (typeof payload.effectKind === 'string' ? payload.effectKind : catalogCard?.effectKind ?? 'Nothing') as UtilityCard['effectKind'];
            const name = typeof payload.utilityName === 'string' ? payload.utilityName : catalogCard?.name ?? 'Something';
            reveals.push({ seq, reveal: { deck: 'door', kind: 'Utility', name, flavor: catalogCard?.flavor ?? '', effectKind, amount: catalogCard?.amount } });
          }
        }

        if (evt.type === 'CombatResolved' && evt.payload.win === true && (evt.payload.combatType === 'HeroVsMonster' || evt.payload.combatType === 'TameVolcano')) {
          sawTreasureEvent = true;
        }
        if (evt.type === 'RuinsLooted' && !!evt.payload.lootCardId) {
          sawTreasureEvent = true;
        }
      }

      // A FreeTreasure Utility card ALSO draws from the Loot deck (applyUtilityEffect in
      // reducers.ts) — chain straight into the Treasure diff below for it too.
      const sawFreeTreasure = reveals.some((r) => r.reveal.deck === 'door' && r.reveal.kind === 'Utility' && r.reveal.effectKind === 'FreeTreasure');
      if (sawTreasureEvent || sawFreeTreasure) {
        for (const player of state.players) {
          const prevPlayer = lastSeenState.players.find((p) => p.id === player.id);
          if (!prevPlayer) continue;
          for (const hero of heroesOf(player)) {
            const prevHero = heroesOf(prevPlayer).find((h) => h.id === hero.id);
            const prevIds = new Set((prevHero?.inventory ?? []).map((c) => c.id));
            for (const card of hero.inventory) {
              // LootCard ids are catalog-static and, once drawn into a hero's inventory, never
              // returned to a deck/reshuffled (see types.ts's HeroState.inventory) — so a given
              // card.id is drawn at most once per game, making it a safe, already-unique key.
              if (!prevIds.has(card.id)) reveals.push({ seq: `treasure-${card.id}`, reveal: { deck: 'treasure', card } });
            }
          }
        }
      }

      if (reveals.length > 0) setQueue((q) => [...q, ...reveals]);
      setLastSeenState(state);
    }
  }

  // The pile "in-progress" glow: true for exactly as long as this deck has a reveal showing or
  // waiting behind it — fully derived from `queue`, no separate on/off timer needed.
  const doorPulsing = queue.some((q) => q.reveal.deck === 'door');
  const treasurePulsing = queue.some((q) => q.reveal.deck === 'treasure');

  // Show one reveal at a time — the head of the queue — so a fast run of AI turns doesn't stack
  // overlapping flips; each gets its own moment before the next one appears.
  const active = queue.length > 0 ? queue[0] : null;
  const dismiss = useCallback(() => setQueue((q) => q.slice(1)), []);
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(dismiss, 3400);
    return () => clearTimeout(t);
  }, [active, dismiss]);

  return (
    <div className={PANEL}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-display text-sm font-bold text-hx-ink">🗃️ Decks</h3>
        <span className="font-mono text-[10px] uppercase tracking-wide text-hx-ink-faint">first visit draws a card</span>
      </div>
      <div className="relative mt-2.5 flex items-center gap-6 pb-1">
        <DeckPile label="Door" icon="🚪" tone="arcane" remaining={state.doorDeck.drawPile.length} pulsing={doorPulsing} />
        <DeckPile label="Treasure" icon="💎" tone="gold" remaining={totalLootRemaining(state)} pulsing={treasurePulsing} />

        {active && <RevealOverlay key={active.seq} reveal={active.reveal} onDismiss={dismiss} />}
      </div>
    </div>
  );
}

function DeckPile({
  label,
  icon,
  tone,
  remaining,
  pulsing,
}: {
  label: string;
  icon: string;
  tone: 'arcane' | 'gold';
  remaining: number;
  pulsing: boolean;
}) {
  const toneBorder = tone === 'arcane' ? 'border-hx-arcane/70' : 'border-hx-gold/70';
  const badgeBorder = tone === 'arcane' ? 'border-hx-arcane' : 'border-hx-gold';
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative h-16 w-12">
        {/* Two ghost cards peeking out behind the top one, for a stacked-pile read. */}
        <div className="absolute -right-1.5 -top-1.5 h-16 w-12 rounded-sm border border-hx-border bg-hx-panel-2/50" />
        <div className="absolute -right-0.5 -top-0.5 h-16 w-12 rounded-sm border border-hx-border bg-hx-panel-2/75" />
        <div
          className={clsx(
            'absolute inset-0 flex items-center justify-center rounded-sm border-2 bg-hx-panel-2 shadow-[0_2px_8px_-2px_rgba(0,0,0,0.65)]',
            toneBorder,
            pulsing && 'motion-safe:animate-shimmer'
          )}
        >
          <span className="text-xl" aria-hidden="true">
            {icon}
          </span>
        </div>
        <span
          className={clsx(
            'absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full border bg-hx-bg px-1 font-mono text-[9px] text-hx-ink-dim',
            badgeBorder
          )}
          title={`${remaining} cards left in the ${label} deck`}
        >
          {remaining}
        </span>
      </div>
      <span className="font-mono text-[9px] uppercase tracking-wide text-hx-ink-faint">{label}</span>
    </div>
  );
}

function RevealOverlay({ reveal, onDismiss }: { reveal: Reveal; onDismiss: () => void }) {
  const fromX = reveal.deck === 'door' ? '-56px' : '56px';
  const tone =
    reveal.deck === 'treasure'
      ? RARITY_COLOR[reveal.card.rarity]
      : reveal.kind === 'Monster'
        ? 'text-hx-blood'
        : 'text-hx-moss';
  const borderTone =
    reveal.deck === 'treasure'
      ? reveal.card.rarity === 'Legendary'
        ? 'border-hx-gold-bright'
        : reveal.card.rarity === 'Rare'
          ? 'border-hx-arcane'
          : reveal.card.rarity === 'Uncommon'
            ? 'border-hx-moss'
            : 'border-hx-border-strong'
      : reveal.kind === 'Monster'
        ? 'border-hx-blood'
        : 'border-hx-moss';

  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center" style={{ perspective: '1000px' }}>
      <button
        type="button"
        onClick={onDismiss}
        className="pointer-events-auto absolute -inset-4 cursor-pointer rounded-sm bg-hx-bg/55 backdrop-blur-[1px]"
        aria-label="Dismiss card reveal"
      />
      <div
        className="motion-safe:animate-card-deal pointer-events-auto relative z-10"
        style={{ '--deal-from-x': fromX, '--deal-from-y': '6px' } as CSSProperties}
      >
        <div className="relative h-44 w-32" style={{ transformStyle: 'preserve-3d' }} onClick={onDismiss}>
          {/* Back face — the "?" card back, facing the viewer at rest. Rotates AWAY
              (0deg -> 180deg, hx-card-flip's normal direction) to reveal what's behind it. */}
          <div
            className={clsx(
              'animate-card-flip motion-reduce:[animation-duration:1ms] absolute inset-0 flex flex-col items-center justify-center gap-1 rounded-md border-2 bg-hx-panel p-2 text-center shadow-[0_8px_24px_-6px_rgba(0,0,0,0.8)]',
              borderTone
            )}
            style={{ backfaceVisibility: 'hidden' }}
          >
            <span className="text-3xl" aria-hidden="true">
              {reveal.deck === 'door' ? '🚪' : '💎'}
            </span>
            <span className="font-mono text-[9px] uppercase tracking-widest text-hx-ink-faint">
              {reveal.deck === 'door' ? 'Door' : 'Treasure'}
            </span>
          </div>

          {/* Front face — the actual card content. Runs the SAME hx-card-flip keyframe in
              reverse (180deg -> 0deg): starts turned away (hidden behind the back face) and
              rotates in to face the viewer exactly as the back face rotates out. */}
          <div
            className={clsx(
              'animate-card-flip [animation-direction:reverse] motion-reduce:[animation-duration:1ms] absolute inset-0 flex flex-col items-center justify-center gap-1 rounded-md border-2 bg-hx-panel-2 p-2 text-center shadow-[0_8px_24px_-6px_rgba(0,0,0,0.8)]',
              borderTone
            )}
            style={{ backfaceVisibility: 'hidden' }}
          >
            <RevealFace reveal={reveal} tone={tone} />
          </div>
        </div>
        <p className="mt-2 text-center text-[10px] text-hx-ink-faint motion-safe:animate-fade-up motion-safe:[animation-delay:900ms]">
          tap to dismiss
        </p>
      </div>
    </div>
  );
}

function RevealFace({ reveal, tone }: { reveal: Reveal; tone: string }) {
  if (reveal.deck === 'treasure') {
    const { card } = reveal;
    return (
      <>
        <span className={clsx('font-mono text-[9px] font-bold uppercase tracking-wide', tone)}>{card.rarity} Treasure</span>
        <span className="font-display text-xs font-bold leading-tight text-hx-ink">{card.name}</span>
        <span className="text-[10px] text-hx-gold">+{card.combatBonus} combat</span>
        {card.specialAbility && <p className="text-[8.5px] italic leading-tight text-hx-ink-dim">{card.specialAbility}</p>}
      </>
    );
  }

  if (reveal.kind === 'Monster') {
    return (
      <>
        <span className={clsx('font-mono text-[9px] font-bold uppercase tracking-wide', tone)}>Monster · Lv {reveal.level}</span>
        <span className="font-display text-xs font-bold leading-tight text-hx-ink">{reveal.name}</span>
        <span aria-hidden="true">{'💀'.repeat(threatSkulls(reveal.level))}</span>
        {reveal.specialAbility && <p className="text-[8.5px] italic leading-tight text-hx-ink-dim">{reveal.specialAbility}</p>}
      </>
    );
  }

  return (
    <>
      <span className={clsx('font-mono text-[9px] font-bold uppercase tracking-wide', tone)}>Utility</span>
      <span className="font-display text-xs font-bold leading-tight text-hx-ink">{reveal.name}</span>
      {reveal.flavor && <p className="text-[8.5px] italic leading-tight text-hx-ink-dim">{reveal.flavor}</p>}
      <span className="text-[10px] text-hx-gold">{UTILITY_EFFECT_BLURB[reveal.effectKind](reveal.amount)}</span>
    </>
  );
}

// Exported for GameBoardApp's board-level "unvisited" highlight (item 5) so the visited-check
// lives next to the rest of the Munchkin-layer UI logic instead of being reimplemented there.
// Only meaningful during Phase.MoveHero — the caller is expected to pass THAT phase's set of
// reachable-this-turn hexes (already-placed tiles only; walking onto empty space isn't a thing).
export function unvisitedHighlightKeys(state: GameState, hero: HeroState, highlightCoords: Set<string>): Set<string> {
  const set = new Set<string>();
  for (const key of highlightCoords) {
    if (state.map[key as HexKey] && !hero.visitedTiles.includes(key as HexKey)) {
      set.add(key);
    }
  }
  return set;
}
