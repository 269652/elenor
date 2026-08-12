'use client';

/**
 * [DEFAULT — direct request: "For WebRTC a client can also save the game and resume it later as
 * host .. it first shows the lobby where all players can connect again and then the host can
 * click a resume game button .. the lobby should display the original players slightly
 * transparent and with a connect button .. it's also possible to switch a player from human to
 * AI"] Host's view of hooks/use-p2p-host.ts's 'resume-lobby' phase — the ghost-picker equivalent
 * of P2PApp.tsx's own HostLobby, for a room that's resuming a save instead of starting fresh.
 * Kept as its own file (unlike HostLobby, which lives inline in P2PApp.tsx) since this one has
 * meaningfully more per-row logic (three statuses × two possible actions) than HostLobby's plain
 * roster + Start button.
 */

import clsx from 'clsx';
import { BTN_GHOST, BTN_PRIMARY, BTN_SECONDARY, PANEL } from '@/components/uiClasses';
import type { P2PHostPhase } from '@/hooks/use-p2p-host';
import { ShareRoomCode } from './ShareRoomCode';

const STATUS_BADGE: Record<'connected' | 'ai' | 'ghost', { label: string; className: string }> = {
  connected: { label: '🟢 Connected', className: 'text-hx-moss' },
  ai: { label: '🤖 AI', className: 'text-hx-arcane' },
  ghost: { label: '👻 Waiting', className: 'text-hx-ink-faint' },
};

export function ResumeHostLobby({
  hostState,
  onLeave,
  onMainMenu,
}: {
  hostState: Extract<P2PHostPhase, { phase: 'resume-lobby' }>;
  onLeave: () => void;
  /** [DEFAULT — direct request: "There's no back to main screen button in the lobbies... add
   *  that for hotseat and p2p"] Distinct from onLeave — see components/p2p/P2PApp.tsx's
   *  HostLobby (its non-resume sibling) for the identical distinction. */
  onMainMenu: () => void;
}) {
  return (
    <div className={`${PANEL} mx-auto flex max-w-md flex-col gap-4`}>
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-xl font-bold text-hx-ink">🏰 Resuming a saved game</h2>
        <p className="text-sm text-hx-ink-dim">
          Share the room code below — each original player can connect and pick themself from the list. It&rsquo;s
          important everyone reconnects as the SAME player they were before.
        </p>
      </div>
      <ShareRoomCode roomCode={hostState.roomCode} />
      <div className="flex flex-col gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wide text-hx-ink-faint">
          Players ({hostState.players.length})
        </span>
        <ul className="flex flex-col divide-y divide-hx-border overflow-hidden rounded-sm border border-hx-border">
          {hostState.players.map((p) => {
            const isAI = hostState.aiControlledPlayerIds.has(p.playerId);
            const badge = STATUS_BADGE[p.status];
            return (
              <li
                key={p.playerId}
                className={clsx('flex flex-col gap-1.5 px-2.5 py-2 transition-opacity', p.status === 'ghost' && 'opacity-50')}
              >
                <div className="flex items-center gap-2">
                  <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: p.color }} />
                  <span className="flex-1 truncate text-sm text-hx-ink">{p.name}</span>
                  {p.isHost && <span className="font-mono text-[9px] uppercase tracking-wide text-hx-gold">host</span>}
                  <span className={clsx('font-mono text-[9px] uppercase tracking-wide', badge.className)}>{badge.label}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {/* [DEFAULT — direct request: "it's also possible to switch a player from human
                      to AI in case you're resuming a game with less players than you started it"]
                      Always offered, same as components/p2p/AdminMenu.tsx's identical toggle mid-
                      game — even a currently-connected seat can be forced to AI (e.g. that player
                      isn't coming back this session after all). */}
                  <button
                    type="button"
                    onClick={() => hostState.setSeatAiControl(p.playerId, !isAI)}
                    className={`${BTN_SECONDARY} px-2 py-1 text-[11px]`}
                  >
                    {isAI ? '🧑 Switch to Human' : '🤖 Switch to AI'}
                  </button>
                  {p.status === 'ghost' && (
                    <button
                      type="button"
                      onClick={() => hostState.claimSeatForSelf(p.playerId)}
                      className={`${BTN_SECONDARY} px-2 py-1 text-[11px]`}
                    >
                      🙋 Play as {p.name}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      {/* [DEFAULT — direct request: "the host can click a resume game button"] Always enabled —
          the AI toggle above already gives the host a way to avoid stranding a ghost seat, but
          hard-blocking Resume Game until every seat is claimed/AI'd would be needlessly
          restrictive (a seat can just as well sit as a ghost until someone actually shows up,
          same as the mid-game reconnect path already tolerates for a disconnected player). */}
      <button type="button" onClick={hostState.resumeGame} className={BTN_PRIMARY}>
        ▶ Resume Game
      </button>
      <button
        type="button"
        onClick={() => {
          if (window.confirm('Close this room? Nobody will be able to connect or resume this game as this room.')) onLeave();
        }}
        className={BTN_GHOST}
      >
        ✖ Close room
      </button>
      <button type="button" onClick={onMainMenu} className={BTN_GHOST}>
        🏠 Main Menu
      </button>
    </div>
  );
}
