'use client';

/**
 * [DEFAULT — direct request: "make a menu when I press ESC where the admin can manage the
 * players... toggle Human/AI mid game; transfer hosting to another player.. kick a player" +
 * follow-up: "The Escape Menu where you can change players from AI to Human mid game should
 * also be implemented in hotseat mode"] Opened by components/GameBoardApp.tsx's Escape-key
 * listener whenever EITHER a P2P room context or a hotseat admin context is present.
 *
 * [DEFAULT — moved out of components/p2p/] Originally lived under components/p2p/ since it
 * started as a P2P-only feature — moved here (and its own AdminMenuContext defined independently
 * of components/p2p/types.ts's P2PRoomContext) once hotseat needed it too, since hotseat has no
 * business importing anything from the P2P transport layer just to toggle a seat's AI status.
 * P2PRoomContext still satisfies this narrower interface structurally (TypeScript doesn't need
 * an explicit `extends` for that), so components/p2p/P2PApp.tsx passes its own ctx object here
 * completely unchanged.
 *
 * Everyone who opens this sees the roster; kick/transfer are P2P-host-only (ctx.onKick/
 * onTransferHost are undefined for a hotseat context, and for a P2P joiner — hooks/
 * use-p2p-join.ts never exposes them, since only the host is ever authoritative enough to act on
 * another seat). AI-toggle, by contrast, is available in BOTH hotseat (ctx.onToggleAi always set
 * there — see components/HotseatApp.tsx) and P2P-hosting — it's the one action that isn't
 * inherently a "host" privilege, it's just "can this device actually control seats," which is
 * true for hotseat's single shared device the same way it's true for a P2P host.
 */

import { BTN_DANGER, BTN_GHOST, BTN_SECONDARY, PANEL } from '@/components/uiClasses';
import type { PlayerId } from '@/engine';

export interface AdminMenuPlayer {
  playerId: PlayerId;
  name: string;
  color: string;
  isHost: boolean;
}

export interface AdminMenuContext {
  myPlayerId: PlayerId;
  players: AdminMenuPlayer[];
  aiControlledPlayerIds: ReadonlySet<PlayerId>;
  /** Available in hotseat and for a P2P host; undefined for a P2P joiner (read-only roster). */
  onToggleAi?: (playerId: PlayerId, isAI: boolean) => void;
  /** P2P-host-only — undefined in hotseat (no concept of removing a seat from a shared local
   *  device) and for a P2P joiner. */
  onKick?: (playerId: PlayerId) => void;
  /** P2P-host-only — undefined in hotseat (no "host" to hand off) and for a P2P joiner. */
  onTransferHost?: (playerId: PlayerId) => void;
}

export function AdminMenu({ ctx, onClose }: { ctx: AdminMenuContext; onClose: () => void }) {
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

        {/* [DEFAULT — direct request: "should also be implemented in hotseat mode"] Genuinely
            read-only only when NEITHER action is available — a P2P joiner (has neither). Hotseat
            has onToggleAi but not onKick, so this note correctly stays hidden there instead of
            claiming "only the host can..." right above a toggle button that actually works. */}
        {!ctx.onKick && !ctx.onToggleAi && (
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

                {/* [DEFAULT — direct request: "should also be implemented in hotseat mode"]
                    AI-toggle is no longer bundled inside the kick/transfer group's `ctx.onKick &&
                    !isSelf` gate — those two really are host-only, but AI-toggle is available
                    whenever ctx.onToggleAi exists at all, independent of kick/transfer, and (for
                    hotseat specifically) even for the CURRENTLY active seat: "let the AI take
                    over from here" is exactly as meaningful for whoever's turn it is right now
                    as for anyone else's, unlike kicking/handing off host mid-turn. */}
                {(ctx.onToggleAi || (ctx.onKick && !isSelf)) && (
                  <div className="flex flex-wrap gap-1.5">
                    {ctx.onToggleAi && (
                      <button
                        type="button"
                        onClick={() => ctx.onToggleAi?.(p.playerId, !isAI)}
                        className={`${BTN_SECONDARY} px-2 py-1 text-[11px]`}
                      >
                        {isAI ? '🧑 Switch to Human' : '🤖 Switch to AI'}
                      </button>
                    )}
                    {ctx.onKick && !isSelf && (
                      <>
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
                      </>
                    )}
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
