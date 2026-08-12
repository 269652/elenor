'use client';

/** [DEFAULT — autoplay, direct request: "should be like an iOS checkbox switch not checkbox"]
 *  A real `<input type="checkbox">` still drives it (visually hidden via `sr-only`, not
 *  `display:none`, so it stays keyboard-focusable and screen-reader accessible) — the pill track
 *  and sliding thumb are two sibling spans whose color/position are driven directly off the
 *  `checked` boolean via `clsx`, the same conditional-className approach used throughout this app
 *  (e.g. GameBoardApp.tsx's canAct-driven CTA border), rather than CSS `peer-checked:` — kept it
 *  simpler and sidesteps the custom-color-token specificity quirks `peer-checked:` ran into
 *  against this app's `bg-hx-*` theme tokens.
 *
 *  [DEFAULT — direct request: "add a 'Public' switch when hosting a P2P room"] Extracted out of
 *  components/GameBoardApp.tsx (where it started as a private helper for the autoplay toggle)
 *  into its own file so components/p2p/P2PApp.tsx's "Public" lobby toggle can reuse the exact
 *  same control instead of a second implementation. */
import clsx from 'clsx';

export function IosSwitch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className={clsx('inline-flex items-center gap-2 text-xs text-hx-ink-dim', disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer')}>
      <span className="relative inline-block h-5 w-9 shrink-0">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="peer absolute inset-0 z-10 m-0 cursor-pointer opacity-0"
        />
        <span
          className={clsx(
            'absolute inset-0 rounded-full transition-colors duration-200 peer-focus-visible:ring-2 peer-focus-visible:ring-hx-gold/50 peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-hx-panel',
            checked ? 'bg-hx-gold' : 'bg-hx-border-strong'
          )}
        />
        <span
          className={clsx(
            'pointer-events-none absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-hx-ink shadow-[0_1px_3px_rgba(0,0,0,0.6)] transition-transform duration-200',
            checked && 'translate-x-4'
          )}
        />
      </span>
      {label}
    </label>
  );
}
