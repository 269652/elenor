'use client';

/**
 * [DEFAULT — direct request: "when you click WebRTC and join there should be a button to list
 * all open lobbies"] Polls GET /api/lobbies while mounted (lib/publicLobbyStore.ts is the
 * server-side directory this reads) and lets the player jump straight into the ordinary
 * join-setup flow with a room code already filled in — they still pick their own name/color
 * there, same as typing a code in by hand; this only saves them having to already know the code.
 */

import { useEffect, useState } from 'react';
import { BTN_GHOST, BTN_PRIMARY, PANEL } from '@/components/uiClasses';
import type { PublicLobbyEntry } from '@/lib/publicLobbyStore';

const POLL_INTERVAL_MS = 6000;

export function BrowsePublicLobbies({ onJoin, onBack }: { onJoin: (roomCode: string) => void; onBack: () => void }) {
  const [lobbies, setLobbies] = useState<PublicLobbyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const res = await fetch('/api/lobbies');
        if (!res.ok) throw new Error('request failed');
        const data = (await res.json()) as { lobbies?: PublicLobbyEntry[] };
        if (!cancelled) {
          setLobbies(data.lobbies ?? []);
          setError(null);
        }
      } catch {
        if (!cancelled) setError("Couldn't load public lobbies — try again in a moment.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void refresh();
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className={`${PANEL} mx-auto flex max-w-md flex-col gap-3`}>
      <h2 className="font-display text-xl font-bold text-hx-ink">🌐 Public Lobbies</h2>
      {loading && <p className="text-sm text-hx-ink-dim">Loading…</p>}
      {error && <p className="text-xs text-hx-blood">{error}</p>}
      {!loading && !error && lobbies.length === 0 && (
        <p className="text-sm text-hx-ink-dim">
          No public lobbies open right now — host a room and flip on &ldquo;Public&rdquo; to be the first.
        </p>
      )}
      {lobbies.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {lobbies.map((l) => {
            const full = l.playerCount >= l.maxPlayers;
            return (
              <li key={l.roomCode} className="flex items-center justify-between gap-2 rounded-sm border border-hx-border bg-hx-panel-2 px-2.5 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-hx-ink">{l.hostName}&rsquo;s room</p>
                  <p className="font-mono text-[10px] text-hx-ink-faint">
                    {l.roomCode} · {l.playerCount}/{l.maxPlayers} players
                  </p>
                </div>
                <button
                  type="button"
                  disabled={full}
                  onClick={() => onJoin(l.roomCode)}
                  title={full ? 'Room is full' : undefined}
                  className={`${BTN_PRIMARY} px-2 py-1 text-[11px] disabled:cursor-not-allowed disabled:opacity-40`}
                >
                  {full ? 'Full' : 'Join'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <button type="button" onClick={onBack} className={BTN_GHOST}>
        ← Back
      </button>
    </div>
  );
}
