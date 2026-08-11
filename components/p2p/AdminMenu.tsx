'use client';

/**
 * [DEFAULT — direct request: "make a menu when I press ESC where the admin can manage the
 * players... toggle Human/AI mid game; transfer hosting to another player.. kick a player"] Opened
 * by components/GameBoardApp.tsx's Escape-key listener whenever a P2P room context is present —
 * see that file for why hotseat/online never render this at all. Everyone sees the roster; the
 * three management actions (kick/AI-toggle/transfer) only render for whoever IS the host right
 * now (ctx.onKick etc. are undefined for a joiner — hooks/use-p2p-join.ts never exposes them,
 * since only the host is ever authoritative enough to act on another seat).
 */

import { BTN_DANGER, BTN_GHOST, BTN_SECONDARY, PANEL } from '@/components/uiClasses';
import type { P2PRoomContext } from './types';

export function AdminMenu({ ctx, onClose }: { ctx: P2PRoomContext; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className={`${PANEL} flex w-full max-w-md flex-col gap-3`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Manage players"
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-display text-lg font-bold text-hx-ink">👥 Manage Players</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-sm border border-hx-border px-2 py-1 text-xs text-hx-ink-faint transition hover:text-hx-ink">
            ✖
          </button>
        </div>

        {!ctx.onKick && (
          <p className="text-[11px] text-hx-ink-faint">Only the host can kick players, toggle AI control, or transfer hosting — you can still see who&rsquo;s here.</p>
        )}

        <ul className="flex flex-col gap-1.5">
          {ctx.players.map((p) => {
            const isAI = ctx.aiControlledPlayerIds.has(p.playerId);
            const isSelf = p.playerId === ctx.myPlayerId;
            return (
              <li key={p.playerId} className="flex flex-col gap-1.5 rounded-sm border border-hx-border bg-hx-panel-2 px-2.5 py-2">
                <div className="flex items-center gap-2">
                  <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: p.color }} />
                  <span className="flex-1 truncate text-sm text-hx-ink">
                    {p.name}
                    {isSelf && <span className="ml-1 text-[10px] text-hx-ink-faint">(you)</span>}
                  </span>
                  {p.isHost && <span className="font-mono text-[9px] uppercase tracking-wide text-hx-gold">host</span>}
                  {isAI && <span className="font-mono text-[9px] uppercase tracking-wide text-hx-arcane">🤖 AI</span>}
                </div>

                {ctx.onKick && !isSelf && (
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => ctx.onToggleAi?.(p.playerId, !isAI)}
                      className={`${BTN_SECONDARY} px-2 py-1 text-[11px]`}
                    >
                      {isAI ? '🧑 Switch to Human' : '🤖 Switch to AI'}
                    </button>
                    {!p.isHost && (
                      <button
                        type="button"
                        onClick={() => {
                          if (window.confirm(`Make ${p.name} the new host? You'll continue as a regular player.`)) ctx.onTransferHost?.(p.playerId);
                        }}
                        className={`${BTN_SECONDARY} px-2 py-1 text-[11px]`}
                      >
                        👑 Make Host
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm(`Remove ${p.name} from this room?`)) ctx.onKick?.(p.playerId);
                      }}
                      className={`${BTN_DANGER} px-2 py-1 text-[11px]`}
                    >
                      ⛔ Kick
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <button type="button" onClick={onClose} className={BTN_GHOST}>
          Close (Esc)
        </button>
      </div>
    </div>
  );
}
