'use client';

/**
 * [DEFAULT — WebRTC P2P play] Shareable join link — a host's "🔗 Copy shareable link" button
 * (components/p2p/P2PApp.tsx's ShareRoomCode) points here. Unlike app/play/[roomCode]/page.tsx
 * (the server-backed online mode's room page), there is nothing to fetch server-side: no DB row,
 * no session — the room lives entirely in the host's browser, reachable only over WebRTC. This
 * is a client component purely so it can pre-fill P2PApp's join form with the code from the URL;
 * everything else about joining still happens through the exact same flow as typing the code in
 * by hand on the landing page.
 */

import { use } from 'react';
import { useRouter } from 'next/navigation';
import { P2PApp } from '@/components/p2p/P2PApp';

export default function P2PJoinLinkPage({ params }: { params: Promise<{ roomCode: string }> }) {
  const { roomCode } = use(params);
  const router = useRouter();

  return (
    <main className="flex h-dvh items-center justify-center overflow-y-auto p-4">
      <P2PApp initialRoomCode={roomCode} onExit={() => router.push('/')} />
    </main>
  );
}
