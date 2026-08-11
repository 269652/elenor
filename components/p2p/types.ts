/**
 * [DEFAULT — direct request: "a menu when I press ESC where the admin can manage the players ..
 * a little chat in a second tab of sidebar"] Shared shape components/GameBoardApp.tsx needs to
 * render the ESC admin menu and the chat sidebar tab — one bundle rather than a dozen loose
 * props, since every field here only ever exists together (there's no P2P game with a roster but
 * no chat, or chat but no AI-toggle). Built directly from hooks/use-p2p-host.ts's and
 * hooks/use-p2p-join.ts's 'active'-phase return shapes by components/p2p/P2PApp.tsx — the host
 * hook has real kick/toggle/transfer functions, the joiner hook has none (host-only actions), so
 * P2PApp fills those in as undefined for a joiner and AdminMenu hides the corresponding buttons.
 */

import type { PlayerId } from '@/engine';
import type { ChatMessage, LobbyPlayerInfo } from '@/lib/webrtc/protocol';

export interface P2PRoomContext {
  isHost: boolean;
  myPlayerId: PlayerId;
  players: LobbyPlayerInfo[];
  aiControlledPlayerIds: ReadonlySet<PlayerId>;
  /** Host-only — undefined for a joiner, who never sees the corresponding admin-menu button. */
  onKick?: (playerId: PlayerId) => void;
  onToggleAi?: (playerId: PlayerId, isAI: boolean) => void;
  onTransferHost?: (playerId: PlayerId) => void;
  chatMessages: ChatMessage[];
  unreadChatCount: number;
  sendChat: (text: string) => void;
  markChatRead: () => void;
}
