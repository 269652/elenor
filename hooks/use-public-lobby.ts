'use client';

/**
 * [DEFAULT — direct request: "add a 'Public' switch when hosting a P2P room which lists the room
 * publicly using the next.js server api"] Owns the host's side of the public-lobby heartbeat —
 * see lib/publicLobbyStore.ts's file header for the overall design and why "the server pings the
 * lobby" is actually implemented as "the lobby pings the server."
 *
 * Deliberately scoped to hooks/use-p2p-host.ts's ordinary 'lobby' phase only (see
 * components/p2p/P2PApp.tsx's HostLobby, the only caller) — a resume-lobby's seats are meant for
 * specific original players reclaiming their own identity, not open to whichever stranger finds
 * it on a public board, so ResumeHostLobby never uses this.
 *
 * No `active` param: this hook is meant to be mounted directly inside the component that itself
 * only renders during the lobby phase (HostLobby unmounts the instant the room leaves 'lobby',
 * whether because the game started or the room closed) — so this hook's own mount/unmount
 * lifecycle already is "is this genuinely a live, joinable pre-game lobby right now," with no
 * separate flag needed to track it.
 */

import { useEffect, useRef } from 'react';

const LOBBY_HEARTBEAT_INTERVAL_MS = 30_000;

export function usePublicLobbyListing(params: {
  isPublic: boolean;
  roomCode: string;
  hostName: string;
  playerCount: number;
  maxPlayers: number;
}) {
  const { isPublic, roomCode, hostName, playerCount, maxPlayers } = params;
  // Tracks whether THIS effect instance actually registered a listing, so its own cleanup only
  // ever sends a DELETE for a room it (or a prior run of this same effect) genuinely POSTed —
  // never a spurious unregister for a room that was never public in the first place.
  const registeredRef = useRef(false);

  useEffect(() => {
    if (!isPublic || !roomCode) return; // nothing to register — see effect's own cleanup below for the DELETE-if-previously-registered case

    let cancelled = false;
    function heartbeat() {
      if (cancelled) return;
      registeredRef.current = true;
      void fetch('/api/lobbies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomCode, hostName, playerCount, maxPlayers }),
      }).catch(() => {
        // Best-effort — a missed heartbeat just means the listing goes stale a little early and
        // either the next tick or the server's own STALE_MS grace catches up. Never worth
        // surfacing to the host as an error over something this cosmetic.
      });
    }
    heartbeat(); // register/refresh immediately — don't make joiners wait out the first interval
    const timer = setInterval(heartbeat, LOBBY_HEARTBEAT_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
      // [DEFAULT — direct request: "When the game starts or the room closes it should vanish from
      // the list"] Fires on EVERY reason this effect tears down — isPublic flipped off, the
      // roster changed (roomCode/hostName/playerCount/maxPlayers are all deps below, so any of
      // them changing re-runs this cleanup then re-registers fresh), or — same cleanup function,
      // no separate handling needed — the component genuinely unmounted (game started / room
      // closed). keepalive lets the request actually complete even if the tab is closing right now.
      if (registeredRef.current) {
        registeredRef.current = false;
        void fetch(`/api/lobbies/${roomCode}`, { method: 'DELETE', keepalive: true }).catch(() => {});
      }
    };
  }, [isPublic, roomCode, hostName, playerCount, maxPlayers]);
}
