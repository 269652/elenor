import clsx from 'clsx';
import { Phase, PHASE_LABEL, type GameState } from '@/engine';

// [DEFAULT — direct request: "swap gather and fight phase"] This array — not Phase's own
// numeric values (see types.ts) — is what actually drives the strip's visual order and the
// past/active/future calc below, so it needed its own manual swap alongside the enum's.
const PHASES_IN_ORDER = [Phase.Production, Phase.DrawAndPlaceTile, Phase.MoveHero, Phase.Fight, Phase.Gather, Phase.Build];

const SHORT_LABEL: Record<Phase, string> = {
  [Phase.Production]: 'Production',
  [Phase.DrawAndPlaceTile]: 'Draw & Place',
  [Phase.MoveHero]: 'Move',
  [Phase.Gather]: 'Gather',
  [Phase.Fight]: 'Fight',
  [Phase.Build]: 'Build',
};

// Exported so other panels (GameBoardApp's prominent "current action" callout) can label a
// phase with the same icon the tracker itself uses, rather than maintaining a second copy.
export const PHASE_ICON: Record<Phase, string> = {
  [Phase.Production]: '🌾',
  [Phase.DrawAndPlaceTile]: '🗺️',
  [Phase.MoveHero]: '👣',
  [Phase.Gather]: '🧺',
  [Phase.Fight]: '⚔️',
  [Phase.Build]: '🏛️',
};

export function PhaseTracker({ state }: { state: GameState }) {
  const activePlayer = state.players.find((p) => p.id === state.currentPlayerId);
  const currentIndex = PHASES_IN_ORDER.indexOf(state.currentPhase);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <span className="font-display text-lg font-bold" style={{ color: activePlayer?.color }}>
          {activePlayer?.name}&rsquo;s turn
        </span>
        <span className="font-mono text-[11px] tracking-wide text-hx-ink-faint">Round {state.roundNumber}</span>
      </div>
      <div className="flex gap-1" role="list" aria-label="Turn phase tracker">
        {PHASES_IN_ORDER.map((phase, i) => {
          const isActive = phase === state.currentPhase;
          const isPast = i < currentIndex;
          return (
            <div
              key={phase}
              role="listitem"
              title={PHASE_LABEL[phase]}
              className={clsx(
                'flex-1 rounded-sm border px-1 py-1.5 text-center transition-colors',
                isActive && 'border-hx-gold bg-hx-gold text-hx-bg motion-safe:animate-shimmer',
                isPast && !isActive && 'border-hx-border bg-hx-panel-2 text-hx-moss',
                !isActive && !isPast && 'border-hx-border bg-hx-panel text-hx-ink-faint'
              )}
            >
              <div className="text-[13px] leading-none">{PHASE_ICON[phase]}</div>
              <div className="mt-1 text-[9px] font-semibold uppercase tracking-wide leading-tight sm:text-[10px]">
                {SHORT_LABEL[phase]}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
