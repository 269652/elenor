'use client';

/**
 * [DEFAULT — direct request: "the lobby should display the original players slightly transparent
 * and with a connect button so each player can simply connect to its old player in the game ..
 * no need to enter a name again; just use one of the players"] Joiner's view of
 * hooks/use-p2p-join.ts's 'resume-lobby' phase — the ghost-picker roster, mirrored from
 * components/p2p/ResumeHostLobby.tsx's identical rendering but with a claim button instead of
 * host-only admin controls. Also reused directly by components/p2p/P2PApp.tsx's join-setup screen
 * once probeLobby reveals the room is resuming a save (before the player has even committed to
 * joining) — see that file's own comment on why name/color entry doesn't apply there at all.
 */

import clsx from 'clsx';
import { BTN_SECONDARY } from '@/components/uiClasses';
import type { ResumeLobbyPlayerInfo } from '@/lib/webrtc/protocol';
import type { PlayerId } from '@/engine';

const STATUS_BADGE: Record<'connected' | 'ai' | 'ghost', { label: string; className: string }> = {
  connected: { label: '🟢 Connected', className: 'text-hx-moss' },
  ai: { label: '🤖 AI', className: 'text-hx-arcane' },
  ghost: { label: '👻 Waiting', className: 'text-hx-ink-faint' },
};

export function ResumeJoinLobby({
  players,
  myPlayerId,
  onClaim,
}: {
  players: ResumeLobbyPlayerInfo[];
  /** Null until THIS device has claimed a seat — nothing renders as "you" before that. */
  myPlayerId: PlayerId | null;
  onClaim: (playerId: PlayerId, name: string, color: string) => void;
}) {
  const claimed = players.find((p) => p.playerId === myPlayerId);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-hx-ink-dim">
        This room is resuming a saved game — pick which player you were. Names and colors carry over automatically.
      </p>
      <ul className="flex flex-col divide-y divide-hx-border overflow-hidden rounded-sm border border-hx-border">
        {players.map((p) => {
          const isSelf = p.playerId === myPlayerId;
          const badge = STATUS_BADGE[p.status];
          return (
            <li
              key={p.playerId}
              className={clsx('flex flex-col gap-1.5 px-2.5 py-2 transition-opacity', p.status === 'ghost' && !isSelf && 'opacity-50')}
            >
              <div className="flex items-center gap-2">
                <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: p.color }} />
                <span className="flex-1 truncate text-sm text-hx-ink">{p.name}</span>
                {isSelf && <span className="font-mono text-[9px] uppercase tracking-wide text-hx-gold">you</span>}
                {p.isHost && <span className="font-mono text-[9px] uppercase tracking-wide text-hx-gold">host</span>}
                <span className={clsx('font-mono text-[9px] uppercase tracking-wide', badge.className)}>{badge.label}</span>
              </div>
              {p.status === 'ghost' && !isSelf && (
                <button
                  type="button"
                  onClick={() => onClaim(p.playerId, p.name, p.color)}
                  className={`${BTN_SECONDARY} px-2 py-1 text-[11px]`}
                >
                  🙋 Connect as {p.name}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {claimed && (
        <p className="rounded-sm border border-hx-border bg-hx-panel-2 px-2.5 py-1.5 text-xs text-hx-ink-dim">
          ⏳ Waiting for the host to resume the game…
        </p>
      )}
    </div>
  );
}
