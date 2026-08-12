'use client';

import { useLayoutEffect, useState } from 'react';
import Image from 'next/image';
import { HotseatApp } from '@/components/HotseatApp';
import { P2PApp } from '@/components/p2p/P2PApp';
import { createGameAction, joinGameAction } from '@/actions/game-actions';
import { BTN_ARCANE, BTN_GHOST, BTN_PRIMARY, BTN_SECONDARY, INPUT, PANEL } from '@/components/uiClasses';
import { SCREEN_ART } from '@/components/screenArt';
import { loadHotseatSession } from '@/lib/hotseatPersistence';
import { loadHostSession, loadJoinSession } from '@/lib/webrtc/persistence';

type Tab = 'menu' | 'local' | 'online' | 'p2p';

export function LandingPage({ supabaseConfigured }: { supabaseConfigured: boolean }) {
  // [BUG FIX] `tab`'s initial value used to be computed straight from localStorage/sessionStorage
  // in this useState initializer. That runs during SSR too (where `window` is undefined, so it
  // always resolved to 'menu') AND during the client's first hydration pass (where it could
  // resolve to 'local'/'p2p') — a genuine hydration mismatch, since React requires the client's
  // very first render to match what the server sent. `tab` now starts at `null` on BOTH server
  // and client (deterministic either way), and useLayoutEffect below — which only ever runs on
  // the client, synchronously right after the DOM commits but before the browser paints —
  // resolves the real tab immediately after. Net effect: no mismatch, and (since it beats paint)
  // no visible flash of the wrong screen either — see [DEFAULT — direct request: "it should
  // rather directly reload into the open session"] below for why landing on the right screen
  // immediately matters here specifically.
  const [tab, setTab] = useState<Tab | null>(null);
  useLayoutEffect(() => {
    // This IS the "synchronize with an external system" case the lint rule's own guidance
    // carves out — localStorage/sessionStorage, read exactly once, right after mount, is the
    // external system; there's no other way to get this value into state without either this
    // effect or the pre-existing hydration mismatch it replaces.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (loadHotseatSession()) setTab('local');
    else if (loadHostSession() || loadJoinSession()) setTab('p2p');
    else setTab('menu');
  }, []);
  if (tab === null) return null;

  // [DEFAULT — direct request: "There's no back to main screen button in the lobbies... add that
  // for hotseat and p2p"] HotseatApp previously received no way at all to signal "leave hotseat
  // and go back to the landing page" — its pre-game screen (components/HotseatApp.tsx) had no
  // such button anywhere. P2P already gets this via its own onExit prop below.
  if (tab === 'local') return <HotseatApp onExit={() => setTab('menu')} />;
  // [DEFAULT — direct request: "WebRTC screens should render exactly the same as hotseat UI
  // elements and make use of whole screen"] No wrapper here, same as the 'local' branch above —
  // P2PApp now owns its own per-screen centering (components/p2p/P2PApp.tsx's CenteredScreen),
  // scoped to setup/lobby screens only, so the active game board is free to fill this page's
  // natural full block width/height exactly like HotseatApp's GameBoardApp does. A centering
  // flex wrapper here would shrink-wrap the board back down to its content size.
  if (tab === 'p2p') return <P2PApp onExit={() => setTab('menu')} />;

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden">
      {/* Full-bleed hero art — commissioned for this screen — with a dark scrim so the title
          and controls stay legible on top. A slow, near-imperceptible Ken Burns drift keeps
          the screen feeling alive rather than static (disabled under prefers-reduced-motion). */}
      <Image
        src={SCREEN_ART.main ?? '/artworks/tiles/forest.jpg'}
        alt=""
        aria-hidden="true"
        fill
        priority
        sizes="100vw"
        className="pointer-events-none object-cover motion-safe:animate-ken-burns"
      />
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 80% 55% at 50% 32%, color-mix(in srgb, var(--color-hx-bg) 15%, transparent) 0%, color-mix(in srgb, var(--color-hx-bg) 55%, transparent) 70%, var(--color-hx-bg) 100%), ' +
            'linear-gradient(180deg, color-mix(in srgb, var(--color-hx-bg) 35%, transparent) 0%, color-mix(in srgb, var(--color-hx-bg) 45%, transparent) 40%, var(--color-hx-bg) 100%)',
        }}
      />

      <div className="relative z-10 mx-auto flex h-full w-full max-w-lg flex-col items-center justify-center gap-10 p-6 text-center">
        <div className="flex flex-col gap-2 motion-safe:animate-fade-up">
          <h1
            className="font-display text-5xl font-bold tracking-tight text-hx-ink sm:text-6xl"
            style={{ textShadow: '0 2px 20px rgba(0,0,0,0.7), 0 1px 3px rgba(0,0,0,0.9)' }}
          >
            🗺️ Elenor
          </h1>
          <p className="text-base text-hx-ink-dim" style={{ textShadow: '0 1px 8px rgba(0,0,0,0.8)' }}>
            Settlers + Risk + Munchkin, on one shared hex world.
          </p>
        </div>

        {tab === 'menu' && (
          <div className="flex w-full flex-col gap-3 motion-safe:animate-fade-up [animation-delay:180ms]">
            <button
              type="button"
              onClick={() => setTab('local')}
              className={BTN_PRIMARY}
              style={{ padding: '1rem 1.5rem', fontSize: '1rem' }}
            >
              🪑 Play Local (Hotseat)
            </button>
            <button type="button" onClick={() => setTab('p2p')} className={BTN_ARCANE}>
              🔗 Play P2P (WebRTC)
            </button>
            <button type="button" disabled title="Coming soon" className={BTN_GHOST}>
              🌐 Play Online (Realtime / Async)
            </button>
          </div>
        )}

        {tab === 'online' && (
          <div className="flex w-full flex-col gap-4 text-left motion-safe:animate-fade-up">
            {!supabaseConfigured && (
              <p className="rounded-sm border border-hx-copper/50 bg-hx-copper/10 px-3 py-2 text-sm text-hx-copper">
                ⚠️ Online play needs a Supabase project. Copy <code>.env.example</code> to <code>.env.local</code> and fill
                in your credentials — see the README. Local hotseat mode works without this.
              </p>
            )}
            <form action={createGameAction} className={`${PANEL} flex flex-col gap-2`}>
              <span className="text-sm font-semibold text-hx-ink">🏰 Host a new game</span>
              <input name="displayName" placeholder="Your name" required maxLength={20} className={INPUT} />
              <button type="submit" disabled={!supabaseConfigured} className={BTN_PRIMARY}>
                Create Room
              </button>
            </form>
            <form action={joinGameAction} className={`${PANEL} flex flex-col gap-2`}>
              <span className="text-sm font-semibold text-hx-ink">🚪 Join a game</span>
              <input name="displayName" placeholder="Your name" required maxLength={20} className={INPUT} />
              <input name="roomCode" placeholder="Room code" required maxLength={6} className={`${INPUT} uppercase`} />
              <button type="submit" disabled={!supabaseConfigured} className={BTN_SECONDARY}>
                Join Room
              </button>
            </form>
            <button
              type="button"
              onClick={() => setTab('menu')}
              className="self-start font-mono text-[11px] uppercase tracking-wide text-hx-ink-faint transition hover:text-hx-ink"
            >
              ← Back
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
