/**
 * Shared Tailwind className strings for the "Illuminated Atlas" visual language (see
 * app/globals.css's @theme hx-* tokens for the underlying palette/type). Every interactive
 * component should import its buttons/panels from here rather than hand-rolling similar-but-
 * not-identical classNames — that's what keeps the whole HUD reading as one system.
 *
 * A leaf module on purpose: components/GameBoardApp.tsx imports HeroPanel/ResourceBar/
 * BuildMenu/TradePanel, so those files importing back from GameBoardApp would be a circular
 * import. Import from here instead.
 */

/** Every interactive button gets a tactile press/lift — motion-safe: so
 *  prefers-reduced-motion drops it automatically. Disabled buttons opt out via
 *  disabled:translate-y-0 disabled:hover:translate-y-0 so they never look "liftable." */
const LIFT = 'motion-safe:transition-transform motion-safe:duration-150 motion-safe:hover:-translate-y-0.5 motion-safe:active:translate-y-0 disabled:hover:translate-y-0';

export const BTN_PRIMARY =
  `rounded-sm border border-hx-gold bg-hx-gold px-3 py-2 text-sm font-semibold text-hx-bg shadow-[0_0_14px_-4px_rgba(217,164,65,0.8)] transition hover:bg-hx-gold-bright disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none ${LIFT}`;

export const BTN_SECONDARY =
  `rounded-sm border border-hx-border bg-hx-panel-2 px-2 py-1.5 text-left text-xs text-hx-ink transition hover:border-hx-gold/50 hover:bg-hx-panel disabled:cursor-not-allowed disabled:opacity-40 ${LIFT}`;

export const BTN_DANGER =
  `rounded-sm border border-hx-blood/70 bg-hx-blood/20 px-2 py-1.5 text-xs text-hx-ink transition hover:bg-hx-blood/35 disabled:cursor-not-allowed disabled:opacity-40 ${LIFT}`;

export const BTN_GHOST =
  `rounded-sm border border-hx-border bg-transparent px-3 py-2 text-xs text-hx-ink-faint transition hover:border-hx-border-strong hover:text-hx-ink disabled:cursor-not-allowed disabled:opacity-40 ${LIFT}`;

/** Same size/weight as BTN_PRIMARY (a real, full-height CTA, not an afterthought) but in the
 *  arcane purple accent instead of gold — for a second first-class option that shouldn't compete
 *  with or be mistaken for the primary one. Translucent rather than solid-filled, so it still
 *  reads as visually subordinate to BTN_PRIMARY at a glance. */
export const BTN_ARCANE =
  `rounded-sm border border-hx-arcane bg-hx-arcane/15 px-3 py-2 text-sm font-semibold text-hx-ink shadow-[0_0_14px_-4px_rgba(140,108,208,0.6)] transition hover:border-hx-arcane hover:bg-hx-arcane/25 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none ${LIFT}`;

/** A small pill-style variant of BTN_SECONDARY — for compact inline actions (equip/unequip,
 *  deposit) inside a denser layout like HeroPanel's loot list. */
export const BTN_PILL =
  `rounded-sm border border-hx-border bg-hx-panel-2 px-1.5 py-0.5 text-[10px] text-hx-ink transition hover:border-hx-gold/50 hover:bg-hx-panel disabled:cursor-not-allowed disabled:opacity-40 ${LIFT}`;

export const PANEL = 'rounded-sm border border-hx-border bg-hx-panel p-3 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.5)]';

export const INPUT = 'rounded-sm border border-hx-border bg-hx-bg px-1.5 py-1 text-xs text-hx-ink';
