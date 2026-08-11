'use client';

/**
 * [DEFAULT — direct request: "a little chat in a second tab of sidebar .. ability to mute other
 * players or the chat entirely .. badge with unread messages"] Mounted by
 * components/GameBoardApp.tsx only while its "Chat" sidebar tab is selected — that mount/unmount
 * IS the "is the user looking at chat right now" signal markChatRead below relies on. Mute state
 * is deliberately local-only (never sent over the wire, never touches hooks/use-p2p-host.ts or
 * use-p2p-join.ts) — it's a purely personal "don't show me this" preference, same as muting a
 * channel in any chat app never stops the other side from sending.
 */

import { useEffect, useRef, useState } from 'react';
import { BTN_PRIMARY, INPUT } from '@/components/uiClasses';
import type { P2PRoomContext } from './types';

export function ChatPanel({ ctx }: { ctx: P2PRoomContext }) {
  const [draft, setDraft] = useState('');
  const [mutedPlayerIds, setMutedPlayerIds] = useState<ReadonlySet<string>>(new Set());
  const [mutedVoicePlayerIds, setMutedVoicePlayerIds] = useState<ReadonlySet<string>>(new Set());
  const [chatMuted, setChatMuted] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const audioRefs = useRef(new Map<string, HTMLAudioElement>());

  // Resets the badge for as long as this panel stays mounted (i.e. the Chat tab is the one
  // selected) — re-firing on every ctx identity change is harmless (setUnreadChatCount(0) when
  // it's already 0 is a no-op render-wise) and is exactly what keeps the badge cleared while a
  // player is actively reading, not just at the moment they first switched tabs.
  useEffect(() => {
    ctx.markChatRead();
  });

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [ctx.chatMessages.length]);

  useEffect(() => {
    const streamIds = new Set(ctx.remoteVoiceStreams.map((s) => s.playerId));
    for (const [playerId, el] of audioRefs.current.entries()) {
      if (!streamIds.has(playerId)) {
        el.srcObject = null;
        audioRefs.current.delete(playerId);
      }
    }
  }, [ctx.remoteVoiceStreams]);

  function toggleMutePlayer(playerId: string) {
    setMutedPlayerIds((prev) => {
      const next = new Set(prev);
      if (next.has(playerId)) next.delete(playerId);
      else next.add(playerId);
      return next;
    });
  }

  function send() {
    const text = draft.trim();
    if (!text) return;
    ctx.sendChat(text);
    setDraft('');
  }

  function toggleMuteVoicePlayer(playerId: string) {
    setMutedVoicePlayerIds((prev) => {
      const next = new Set(prev);
      if (next.has(playerId)) next.delete(playerId);
      else next.add(playerId);
      return next;
    });
  }

  const visibleMessages = chatMuted ? [] : ctx.chatMessages.filter((m) => !mutedPlayerIds.has(m.playerId));
  const otherPlayers = ctx.players.filter((p) => p.playerId !== ctx.myPlayerId);
  const me = ctx.players.find((p) => p.playerId === ctx.myPlayerId);
  const voiceParticipantCount = ctx.voiceEnabled ? ctx.remoteVoiceStreams.length + 1 : ctx.remoteVoiceStreams.length;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wide text-hx-ink-faint">Room chat</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setChatMuted((v) => !v)}
            className="rounded-sm border border-hx-border px-2 py-0.5 text-[10px] text-hx-ink-faint transition hover:text-hx-ink"
          >
            {chatMuted ? '🔇 Unmute chat' : '🔊 Mute chat'}
          </button>
          <button
            type="button"
            onClick={() => {
              if (ctx.voiceEnabled) ctx.disableVoice();
              else void ctx.enableVoice();
            }}
            className="rounded-sm border border-hx-border px-2 py-0.5 text-[10px] text-hx-ink-faint transition hover:text-hx-ink"
          >
            {ctx.voiceEnabled ? '🎤 Leave voice' : '🎙️ Join voice'}
          </button>
          <button
            type="button"
            disabled={!ctx.voiceEnabled}
            onClick={ctx.toggleVoiceMuted}
            className="rounded-sm border border-hx-border px-2 py-0.5 text-[10px] text-hx-ink-faint transition hover:text-hx-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            {ctx.voiceMuted ? '🔈 Unmute mic' : '🔇 Mute mic'}
          </button>
        </div>
      </div>

      {ctx.voiceError && <p className="text-xs text-hx-blood">⚠️ {ctx.voiceError}</p>}

      {ctx.voiceEnabled && (
        <div className="rounded-sm border border-hx-border bg-hx-panel-2 p-2">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] uppercase tracking-wide text-hx-ink-faint">Voice participants</span>
            <span className="text-[10px] text-hx-ink-faint">{voiceParticipantCount} live</span>
          </div>
          <div className="mb-1 flex items-center justify-between gap-2 text-xs">
            <span style={{ color: me?.color ?? '#888888' }} className="truncate font-semibold">
              {me?.name ?? 'You'} (You)
            </span>
            <span className="text-[10px] text-hx-ink-faint">{ctx.voiceMuted ? '🔇 Mic muted' : '🎤 Mic live'}</span>
          </div>
          {ctx.remoteVoiceStreams.length === 0 && <p className="text-xs text-hx-ink-faint">No one else is in voice yet.</p>}
          {ctx.remoteVoiceStreams.map((entry) => {
            const muted = mutedVoicePlayerIds.has(entry.playerId);
            return (
              <div key={entry.playerId} className="mb-1 flex items-center justify-between gap-2 text-xs">
                <span style={{ color: entry.color }} className="truncate font-semibold">
                  {entry.name}
                </span>
                <button
                  type="button"
                  onClick={() => toggleMuteVoicePlayer(entry.playerId)}
                  className="rounded-sm border border-hx-border px-1.5 py-0.5 text-[10px] text-hx-ink-faint transition hover:text-hx-ink"
                >
                  {muted ? '🔈 Unmute' : '🔇 Mute'}
                </button>
                <audio
                  autoPlay
                  playsInline
                  muted={muted}
                  ref={(el) => {
                    if (!el) return;
                    audioRefs.current.set(entry.playerId, el);
                    if (el.srcObject !== entry.stream) {
                      el.srcObject = entry.stream;
                      void el.play().catch(() => {
                        // Some browsers gate autoplay until a user gesture; Join Voice itself is
                        // the intended gesture, but failing quietly keeps UI stable.
                      });
                    }
                  }}
                />
              </div>
            );
          })}
        </div>
      )}

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto rounded-sm border border-hx-border bg-hx-panel-2 p-2">
        {chatMuted && <p className="text-xs text-hx-ink-faint">Chat is muted for you — nobody else is affected.</p>}
        {!chatMuted && visibleMessages.length === 0 && <p className="text-xs text-hx-ink-faint">No messages yet — say hello.</p>}
        {!chatMuted &&
          visibleMessages.map((m) => (
            <div key={m.id} className="mb-1.5 text-xs leading-snug">
              <span className="font-semibold" style={{ color: m.color }}>
                {m.name}
              </span>
              <span className="ml-1.5 text-hx-ink">{m.text}</span>
            </div>
          ))}
      </div>

      {otherPlayers.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {otherPlayers.map((p) => {
            const muted = mutedPlayerIds.has(p.playerId);
            return (
              <button
                key={p.playerId}
                type="button"
                onClick={() => toggleMutePlayer(p.playerId)}
                title={muted ? `Unmute ${p.name}` : `Mute ${p.name}`}
                className={`rounded-sm border px-1.5 py-0.5 text-[10px] transition ${
                  muted ? 'border-hx-border text-hx-ink-faint line-through' : 'border-hx-border text-hx-ink-dim hover:text-hx-ink'
                }`}
              >
                {muted ? '🔇' : '🔊'} {p.name}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send();
          }}
          placeholder="Message…"
          maxLength={500}
          className={`flex-1 ${INPUT}`}
        />
        <button type="button" onClick={send} disabled={!draft.trim()} className={BTN_PRIMARY}>
          Send
        </button>
      </div>
    </div>
  );
}
