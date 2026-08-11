import { RESOURCE_TYPES, type Player } from '@/engine';
import { RESOURCE_COLOR, RESOURCE_ICON } from '@/components/board/tileTheme';
import { PANEL } from '@/components/uiClasses';

/** The player's banked "wallet" — resources deposited at the Capital, spendable anywhere.
 *  Distinct from what the hero is physically carrying (see HeroPanel's carry bar), which is
 *  only spendable on the tile the hero is standing on. */
export function ResourceBar({ player }: { player: Player }) {
  return (
    // [DEFAULT — direct request: "remove 'Hometown stock' label to save space"] The label row
    // is gone; the pills below are still individually titled per-resource and the whole strip
    // now reads compactly enough (icon + number) that the header added little beyond height.
    <div className={`${PANEL} flex flex-col gap-1.5`}>
      <div className="flex flex-wrap items-center gap-1.5" aria-label="Banked resources">
        {RESOURCE_TYPES.map((r) => (
          <div
            key={r}
            className="flex items-center gap-1 rounded-sm border border-hx-border bg-hx-panel-2 px-1.5 py-1 font-mono text-sm"
            title={r}
          >
            <span aria-hidden style={{ filter: 'saturate(1.2)' }}>
              {RESOURCE_ICON[r]}
            </span>
            <span className="font-semibold tabular-nums" style={{ color: RESOURCE_COLOR[r] }}>
              {player.resources[r]}
            </span>
          </div>
        ))}
        <div
          className="ml-1 flex items-center gap-1 border-l border-hx-border pl-2 font-mono text-xs text-hx-ink-faint"
          title="Bank trade ratio"
        >
          <span aria-hidden>🏦</span>
          <span className="tabular-nums">
            {player.bankTradeRatio[0]}:{player.bankTradeRatio[1]}
          </span>
        </div>
      </div>
    </div>
  );
}
