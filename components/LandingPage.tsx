'use client';

import { useState } from 'react';
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
  // [DEFAULT — direct request: "it should rather directly reload into the open session"] A
  // reload always remounts LandingPage fresh — without this check it would default to 'menu'
  // and require an extra manual click back into hotseat/P2P before either mode's OWN resume
  // logic (HotseatApp.tsx, components/p2p/P2PApp.tsx) ever got a chance to run. Checked once,
  // here, so the very first render already knows which screen to land on.
  const [tab, setTab] = useState<Tab>(() => {
    if (loadHotseatSession()) return 'local';
    if (loadHostSession() || loadJoinSession()) return 'p2p';
    return 'menu';
  });

  if (tab === 'local') return <HotseatApp />;
  if (tab === 'p2p') {
    return (
      <div className="flex h-full w-full items-center justify-center overflow-y-auto p-4">
        <P2PApp onExit={() => setTab('menu')} />
      </div>
    );
  }

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
            🗺️ Hexrealms
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
