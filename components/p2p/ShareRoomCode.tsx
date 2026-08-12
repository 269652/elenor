'use client';

/**
 * [DEFAULT — WebRTC P2P play] Extracted out of components/p2p/P2PApp.tsx (where it originally
 * lived inline, used only by that file's own HostLobby) into its own module so
 * components/p2p/ResumeHostLobby.tsx — [DEFAULT — direct request: "a client can also save the
 * game and resume it later as host"] — can reuse it too without importing FROM P2PApp.tsx (which
 * itself imports ResumeHostLobby, so that direction would be a circular import).
 */

import { useState } from 'react';
import { BTN_SECONDARY } from '@/components/uiClasses';

/** Room code + a shareable /p2p/<code> link, both one click from the clipboard — this is the
 *  thing a host has to actually get to their friends, so it gets the most visual weight on the
 *  whole screen. navigator.clipboard needs a secure context (https, or localhost in dev). */
export function ShareRoomCode({ roomCode }: { roomCode: string }) {
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);
  const link = typeof window !== 'undefined' ? `${window.location.origin}/p2p/${roomCode}` : '';

  async function copy(text: string, which: 'code' | 'link') {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      // Clipboard access denied/unavailable — the code is still shown on screen, just not
      // one-click-copyable. Not worth a whole error state for.
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-sm border border-hx-gold/50 bg-hx-gold/10 p-3">
      <span className="font-mono text-[10px] uppercase tracking-wide text-hx-ink-faint">Room code</span>
      <button
        type="button"
        onClick={() => copy(roomCode, 'code')}
        className="self-start font-display text-3xl font-bold tracking-[0.3em] text-hx-gold transition hover:text-hx-gold-bright"
        title="Click to copy"
      >
        {roomCode}
      </button>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => copy(link, 'link')} className={`${BTN_SECONDARY} flex-1 text-center`}>
          {copied === 'link' ? '✓ Link copied' : copied === 'code' ? '✓ Code copied' : '🔗 Copy shareable link'}
        </button>
      </div>
      <p className="text-[11px] text-hx-ink-faint">Share either one — joiners can type the code or open the link directly.</p>
    </div>
  );
}
