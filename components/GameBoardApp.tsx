'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import clsx from 'clsx';
import { SCREEN_ART } from '@/components/screenArt';
import {
  Phase,
  PHASE_LABEL,
  RESOURCE_TYPES,
  checkMovePath,
  classDefFor,
  garrisonOwnerOf,
  hexKey,
  hexNeighbors,
  movementRangeFor,
  remainingCarryCapacity,
  roadConnectedTiles,
  tileAt,
  type Action,
  type GameState,
  type HexCoord,
  type Player,
  type PlayerId,
  type Tile,
  type WinCondition,
} from '@/engine';
import { HexBoard } from '@/components/board/HexBoard';
import { HeroPanel } from '@/components/hero/HeroPanel';
import { HeroBattleBanner } from '@/components/hero/HeroBattleBanner';
import { DoorCardPanel, PendingDoorMonsterBanner, isDoorMonsterPendingFor, unvisitedHighlightKeys } from '@/components/hero/DoorCardPanel';
import { PhaseTracker, PHASE_ICON } from '@/components/hud/PhaseTracker';
import { ResourceBar } from '@/components/hud/ResourceBar';
import { BuildMenu, roadEndpointOptions } from '@/components/build/BuildMenu';
import { TradePanel } from '@/components/hud/TradePanel';
import { BTN_DANGER, BTN_GHOST, BTN_PRIMARY, BTN_SECONDARY, INPUT, PANEL } from '@/components/uiClasses';
import { useAiTurn } from '@/hooks/use-ai-turn';
import { IosSwitch } from '@/components/IosSwitch';
import { AdminMenu, type AdminMenuContext } from '@/components/AdminMenu';
import { ChatPanel } from '@/components/p2p/ChatPanel';
import { SavedGamesPanel } from '@/components/SavedGamesPanel';
import type { P2PRoomContext } from '@/components/p2p/types';
import type { HotseatStartPayload } from '@/components/lobby/HotseatSetup';
import type { SavedGame } from '@/lib/savedGames';
import { trackEvent } from '@/lib/analytics';

const NO_AI_PLAYERS: ReadonlySet<PlayerId> = new Set();

/** Friendly victory-screen labels — WinCondition's own values are code identifiers (camelCase-
 *  ish, no spaces), fine for logs/events but not for the win banner a player actually reads. */
const WIN_CONDITION_LABEL: Record<WinCondition, string> = {
  VictoryPoints: 'Victory Points',
  Domination: 'Domination',
  HeroLevelRace: 'Hero Level Race',
  CapitalConquest: 'Capital Conquest',
};

/** The wooden-table backdrop behind the whole game screen — fixed to the viewport (not the
 *  scrolling sidebar) so it reads as the surface everything is sitting on, not a page
 *  background that scrolls away. Board/HUD panels are all opaque already, so this only needs
 *  a light edge vignette to seat the image into the page frame, not a legibility scrim. */
function TableBackdrop() {
  if (!SCREEN_ART.game) return null;
  return (
    <div className="fixed inset-0 -z-10 overflow-hidden" aria-hidden="true">
      <Image
        src={SCREEN_ART.game}
        alt=""
        fill
        priority
        sizes="100vw"
        className="object-cover motion-safe:animate-ken-burns"
      />
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(ellipse 100% 100% at 50% 50%, transparent 55%, var(--color-hx-bg) 105%)' }}
      />
    </div>
  );
}

interface GameBoardAppProps {
  state: GameState;
  dispatch: (action: Action) => boolean | Promise<boolean>;
  error: string | null;
  /** Hotseat: always the active player (pass-and-play). Online: the signed-in player, whose
   *  controls are read-only when it's not their turn. */
  isMyTurn: boolean;
  /** Seats driven by ai/decideAction.ts instead of a human — see hooks/use-ai-turn.ts. Omit
   *  (or leave empty) for a game with no AI opponents; online mode doesn't wire this up yet. */
  aiPlayerIds?: ReadonlySet<PlayerId>;
  /** [DEFAULT — direct request: "add exit game button somewhere"] Leaves the current game and
   *  returns to whatever screen this mode considers "before the game" — clearing hotseat's
   *  persisted localStorage session, closing a P2P peer connection and its persisted session, or
   *  just navigating away, depending on which caller wires it up. Optional: online mode (and any
   *  future mode) that doesn't have an "exit" concept yet simply omits it and no button renders. */
  onExit?: () => void;
  /** [DEFAULT — direct request: "a menu when I press ESC where the admin can manage the players
   *  .. a little chat in a second tab of sidebar"] Present only for P2P play — chat/voice have no
   *  hotseat equivalent, and online mode doesn't wire this up (yet). Its mere presence (alongside
   *  hotseatAdmin below) gates the Escape listener and the admin menu, and on its own gates the
   *  chat sidebar tab — omitting both (the online default) reproduces this component's exact
   *  pre-existing behavior with zero code-path changes for that mode. */
  p2p?: P2PRoomContext;
  /** [DEFAULT — direct request: "The Escape Menu where you can change players from AI to Human
   *  mid game should also be implemented in hotseat mode"] Hotseat's OWN admin context — just
   *  the roster + AI-toggle, no kick/transfer (hotseat has no "other device" to remove or hand
   *  hosting to, it's one shared device). Threaded down from components/HotseatApp.tsx's
   *  LocalGame. AdminMenuContext (components/AdminMenu.tsx) is a strict subset of P2PRoomContext,
   *  so p2p above already satisfies this same shape when P2P play is what's active — see the
   *  adminCtx computation below for how the two combine. */
  hotseatAdmin?: AdminMenuContext;
  /** [DEFAULT — direct request: "a third tab which holds all saved games and allows you to
   *  restore it"] Hotseat-only wiring for the Saves sidebar tab below (see
   *  components/SavedGamesPanel.tsx) — threaded down from components/HotseatApp.tsx's LocalGame,
   *  which already passes state/dispatch/etc. here. P2P's own call sites (components/p2p/
   *  P2PApp.tsx) simply omit both: a P2P save has no in-place restore (that only happens via the
   *  P2P main menu's "Resume a saved game" flow, hooks/use-p2p-host.ts's resumeFromSavedGame),
   *  consistent with how `p2p` itself is optional and omitted for hotseat. */
  currentHotseatPayload?: HotseatStartPayload;
  onRestore?: (save: SavedGame) => void;
}

/** [DEFAULT — territory rework] What a MoveSoldiers march onto a given neighbour would actually
 *  DO. The three outcomes are the whole territory game now, and which one you get is decided
 *  entirely by what is already standing on the destination — so it is knowable, and therefore
 *  showable, before the click. Nobody should ever be surprised into a battle. */
type MarchOutcome = 'reinforce' | 'occupy' | 'battle';

interface MarchTarget {
  coord: HexCoord;
  tile: Tile;
  outcome: MarchOutcome;
  /** Soldiers already on the destination, whoever they belong to. */
  defenders: number;
  defenderName: string | null;
  ownerName: string | null;
  hasWatchtower: boolean;
}

const MARCH_META: Record<MarchOutcome, { icon: string; label: string; className: string }> = {
  // [DEFAULT — direct feedback: "Buttons should not have transparency"] Solid fills instead of
  // the previous translucent /15-/20 washes. The inner label spans (below, in the button JSX)
  // set their own explicit text colors regardless, so no text-color change is needed here.
  reinforce: {
    icon: '🛡️',
    label: 'Reinforce',
    className: 'border-hx-moss bg-hx-moss hover:brightness-110',
  },
  occupy: {
    icon: '🚩',
    label: 'Occupy',
    className: 'border-hx-copper bg-hx-copper hover:brightness-110',
  },
  battle: {
    icon: '⚔️',
    label: 'Battle',
    className: 'border-hx-blood bg-hx-blood hover:brightness-110',
  },
};

function marchTargetsFrom(state: GameState, player: Player, from: HexCoord): MarchTarget[] {
  const nameOf = (id: PlayerId | null | undefined) => (id ? state.players.find((p) => p.id === id)?.name ?? id : null);

  return hexNeighbors(from).flatMap((coord): MarchTarget[] => {
    const tile = state.map[hexKey(coord)];
    if (!tile) return []; // Soldiers cannot march off the edge of the placed map.
    const holder = garrisonOwnerOf(tile);
    const base = {
      coord,
      tile,
      defenders: tile.militiaCount ?? 0,
      defenderName: nameOf(holder),
      ownerName: nameOf(tile.ownerId),
      hasWatchtower: tile.building?.type === 'Watchtower',
    };
    // Whoever is STANDING there decides it — a tile you own but a rival is squatting on is a
    // battle, and a rival-owned tile nobody is defending is a walk-on.
    if (holder && holder !== player.id) return [{ ...base, outcome: 'battle' }];
    if (tile.ownerId === player.id) return [{ ...base, outcome: 'reinforce' }];
    return [{ ...base, outcome: 'occupy' }];
  });
}

function marchBlurb(target: MarchTarget, count: number): string {
  switch (target.outcome) {
    case 'reinforce':
      return `Your own tile — the ${count} join the ${target.defenders} already there.`;
    case 'occupy':
      // Reinforcing your OWN troops on foreign ground re-stamps occupationSinceRound (see
      // applyMoveSoldiers), which pushes the claim back a round — worth saying out loud.
      return target.defenders > 0
        ? `Your ${target.defenders} already hold ${target.ownerName ? `${target.ownerName}'s` : 'this unclaimed'} ground — sending more restarts the hold clock.`
        : `${target.ownerName ? `${target.ownerName}'s` : 'Unclaimed'} ground, undefended — hold it into your next turn and it becomes yours.`;
    case 'battle':
      return `${target.defenderName} defends with ${target.defenders}${target.hasWatchtower ? ' behind a Watchtower' : ''} — dice resolve on contact.`;
  }
}

/** Every tile with Soldiers of this player's on it — including ones they don't own but are
 *  currently occupying, which is precisely where the interesting decisions are. */
function garrisonsOf(state: GameState, player: Player): Tile[] {
  return Object.values(state.map)
    .filter((t) => (t.militiaCount ?? 0) > 0 && garrisonOwnerOf(t) === player.id)
    .sort((a, b) => (b.militiaCount ?? 0) - (a.militiaCount ?? 0));
}

// IosSwitch now lives in components/IosSwitch.tsx — see that file's own header comment for why it
// was extracted out of here (components/p2p/P2PApp.tsx's "Public" lobby toggle needs it too).

export function GameBoardApp({
  state,
  dispatch,
  error,
  isMyTurn,
  aiPlayerIds = NO_AI_PLAYERS,
  onExit,
  p2p,
  hotseatAdmin,
  currentHotseatPayload,
  onRestore,
}: GameBoardAppProps) {
  const [selectedCoord, setSelectedCoord] = useState<HexCoord | null>(null);
  // [DEFAULT — direct request: "a menu when I press ESC .. a little chat in a second tab of
  // sidebar" + follow-up: "should also be implemented in hotseat mode"] p2p and hotseatAdmin are
  // mutually exclusive in practice (a given GameBoardApp mount is either hotseat or P2P, never
  // both), and p2p already structurally satisfies AdminMenuContext on its own — this just picks
  // whichever one is actually present. The listener/menu attach whenever EITHER exists; online
  // mode (neither) still gets zero code-path change, same as before.
  const adminCtx: AdminMenuContext | undefined = p2p ?? hotseatAdmin;
  const [showAdminMenu, setShowAdminMenu] = useState(false);
  // [DEFAULT — direct request: "a third tab which holds all saved games"] Unlike 'chat' (gated by
  // p2p being present), 'saves' shows for BOTH hotseat and P2P — see the tab strip below.
  const [sidebarTab, setSidebarTab] = useState<'game' | 'chat' | 'saves'>('game');
  useEffect(() => {
    if (!adminCtx) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      setShowAdminMenu((v) => !v);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [adminCtx]);
  const [pendingPath, setPendingPath] = useState<HexCoord[]>([]);
  /** Armed march: the tile whose garrison is about to walk somewhere, and how many of them. */
  const [marchFrom, setMarchFrom] = useState<HexCoord | null>(null);
  const [marchCount, setMarchCount] = useState(1);
  /** A battle the player has picked but not yet confirmed — see MarchOutcome. */
  const [pendingAssault, setPendingAssault] = useState<HexCoord | null>(null);
  /** [DEFAULT — hero battle participation] Whether the hero standing on the march's origin tile
   *  is opted into lending their die to the pending assault — see the assault-confirmation block
   *  in ArmyPanel. Reset alongside pendingAssault everywhere that gets cleared or re-armed, so a
   *  stale "yes" never silently carries over onto a different battle. */
  const [heroJoinsAssault, setHeroJoinsAssault] = useState(false);
  /** Road-laying is its own explicit mode with an obvious cancel, not a modifier-click. */
  const [roadMode, setRoadMode] = useState(false);
  const [roadAnchor, setRoadAnchor] = useState<HexCoord | null>(null);

  // [DEFAULT — autoplay, direct request: "add an autoplay switch and button which lets human
  // players let AI play automatically. Button plays current round only; when switch is active
  // and button pressed it autoplays until switch is deactivated again"] Two independent pieces
  // of state, matching the two controls: the switch is a per-player MODE PREFERENCE (flipping it
  // alone does nothing until the button engages autoplay), `autoplayActive` is whether autoplay
  // is CURRENTLY running. `autoplayEngagedRound` remembers which round it was switched on in, so
  // single-round mode knows when to stop — see the auto-disable check below.
  //
  // [BUG FIX — direct feedback: "the switch is not individual per player .. if I deactivate it
  // in reds turn it's also deactivated in blues turn"] Originally a single shared boolean, so in
  // hotseat (where every human seat reuses this same component instance) flipping the switch
  // during one player's turn silently changed it for every other player too — Red turning
  // autoplay off left Blue unable to tell the checkbox was never THEIRS to begin with. Keyed by
  // PlayerId instead: each seat remembers its own preference, independent of whoever last
  // touched the control.
  const [continuousByPlayer, setContinuousByPlayer] = useState<Record<PlayerId, boolean>>({});
  const [autoplayActive, setAutoplayActive] = useState(false);
  const [autoplayEngagedRound, setAutoplayEngagedRound] = useState<number | null>(null);
  // [BUG FIX — direct feedback: "it doesn't continue autoplay if continuous is active .. plays
  // only one round and next one it stops. Continuous should not need another button click in
  // next round"] Fixed once at the moment the button engages autoplay, from whichever player's
  // switch was actually on at that instant — deliberately NOT re-derived from
  // continuousByPlayer[currentPlayerId] on every render. In hotseat, the round boundary lands
  // exactly when currentPlayerId has already rolled over to the FIRST player of the new round —
  // who is frequently a DIFFERENT seat than whoever pressed the button, and very possibly one
  // that never touched their own switch (defaults to off). Re-deriving continuity from that
  // seat's own preference made a genuinely continuous run stop dead at the very first round
  // boundary it crossed, unless every single seat happened to also have their own switch on.
  // This flag is the run's own memory of what mode IT was engaged in, independent of whose turn
  // it happens to be checked against later.
  const [runIsContinuous, setRunIsContinuous] = useState(false);

  const player = state.players.find((p) => p.id === state.currentPlayerId)!;
  const hero = player.hero;
  // This seat's own switch position — always read fresh off the CURRENT player's id, never off
  // whoever engaged autoplay, so a run that carries over into a new player's turn immediately
  // starts respecting THEIR preference instead of the previous player's. Purely a UI display/
  // press-time value now — see runIsContinuous above for what actually governs an in-progress
  // run's continuation.
  const currentPlayerContinuous = continuousByPlayer[state.currentPlayerId] ?? false;
  // The seat's PERMANENT status, set once at game creation (HotseatSetup's AI toggle) — kept
  // separate from the EFFECTIVE ai-driven status below so the "AI is thinking" banner can tell a
  // real AI opponent apart from a human seat that's just delegated this turn to autoplay.
  const isPermanentAi = aiPlayerIds.has(state.currentPlayerId);
  // Autoplay only ever drives a seat this client actually controls (isMyTurn) and that isn't
  // already a permanent AI (which plays itself regardless) — this is what keeps it safe in
  // online/P2P play: it can never touch another real player's turn, because isMyTurn is false
  // for those regardless of this client's local autoplay state.
  const autoplayingThisTurn = autoplayActive && isMyTurn && !isPermanentAi;
  // New Set identity only when what it CONTAINS actually needs to change (autoplayingThisTurn
  // flips, the underlying aiPlayerIds prop changes, or the turn moves to a new player) — stable
  // across the many re-renders a single automated turn produces, so useAiTurn's effect (keyed on
  // this reference) doesn't tear down and restart every single action tick.
  const effectiveAiPlayerIds = useMemo(() => {
    if (!autoplayingThisTurn) return aiPlayerIds;
    const merged = new Set(aiPlayerIds);
    merged.add(state.currentPlayerId);
    return merged;
  }, [aiPlayerIds, autoplayingThisTurn, state.currentPlayerId]);
  const isAiTurn = effectiveAiPlayerIds.has(state.currentPlayerId);
  const canAct = isMyTurn && !isAiTurn && !state.winnerId;

  // Single-round mode's stop condition: once the round this was engaged in has passed, drop back
  // to manual control. Continuous mode has no such check — only an explicit switch-off (see the
  // IosSwitch onChange below) or the Stop button turns it off; gated on runIsContinuous (the
  // mode the RUN was engaged in), not the current turn's own preference — see its doc comment
  // above for why. Render-time state adjustment, same sanctioned pattern as the road-mode guard
  // right below — this is a direct, synchronous consequence of state.roundNumber advancing, not
  // an external system to subscribe to.
  if (autoplayActive && !runIsContinuous && autoplayEngagedRound !== null && state.roundNumber > autoplayEngagedRound) {
    setAutoplayActive(false);
    setAutoplayEngagedRound(null);
  }

  // [DEFAULT — roads, UI feedback change] Roads are now a Build-phase-only action (engine's
  // applyBuildRoad rejects it elsewhere) — if the turn advances out of Build while road mode is
  // still armed (e.g. a human left it open, then AdvancePhase fired), drop the mode rather than
  // leave a control armed for an action the engine will now refuse. React-sanctioned "adjust
  // state during render" pattern (https://react.dev/reference/react/useState#storing-information-from-previous-renders) —
  // this only ever fires as a direct consequence of THIS render's own props, so an effect would
  // just reproduce it one render late.
  if (roadMode && state.currentPhase !== Phase.Build) {
    setRoadMode(false);
    setRoadAnchor(null);
  }

  // Same guard as HexBoard's: roadConnectedTiles walks state.roads, so a pre-roads GameState
  // (older persisted room, hot-reloaded in-memory game) would throw rather than render.
  const roadConnectedKeys = useMemo<Set<string>>(
    () => (state.roads ? roadConnectedTiles(state, player) : new Set<string>()),
    [state, player]
  );
  const highlightCoords = useMemo(
    () => computeHighlights(state, player, pendingPath, { roadMode, roadAnchor, marchFrom }),
    [state, player, pendingPath, roadMode, roadAnchor, marchFrom]
  );
  // [DEFAULT — Munchkin exploration layer] Which currently-reachable hexes would draw a Door
  // card if the hero stepped onto them — see DoorCardPanel.tsx's unvisitedHighlightKeys. Only
  // meaningful during Move Hero; that function already no-ops the highlight set for every other
  // phase, this just skips the (harmless but pointless) work outside it.
  const unopenedDoorCoords = useMemo(
    () => (state.currentPhase === Phase.MoveHero ? unvisitedHighlightKeys(state, hero, highlightCoords) : new Set<string>()),
    [state, hero, highlightCoords]
  );
  // A pending Door monster (state.pendingDoorMonster) blocks AdvancePhase out of Phase 4 AND
  // blocks EndTurn outright from any phase (reducers.ts's requireNoPendingDoorMonster) — the
  // footer buttons below need to agree with the engine before the click, not just report its
  // rejection after.
  const doorMonsterPendingForMe = isDoorMonsterPendingFor(state, player);
  // [DEFAULT — direct request: "Next phase should be disabled until drawn a card"] Only live
  // during Phase 1, and only until a tile has been drawn (pendingTileDraw set) or placed
  // (hasPlacedTileThisTurn) — the engine itself doesn't require a draw before advancing, but
  // skipping it silently forfeits Phase 1's entire action, which the UI now refuses to do quietly.
  const noTileDrawnYet = state.currentPhase === Phase.DrawAndPlaceTile && !state.pendingTileDraw && !state.hasPlacedTileThisTurn;
  useAiTurn(state, effectiveAiPlayerIds, dispatch);

  // [DEFAULT — direct request: "track when a user starts a new game, wins, loses or quits a
  // running game"] Fires exactly once per game, the render after winnerId first flips from null
  // — trackedWinRef (not just the state.winnerId dep) is what guarantees the "once" part, since
  // p2p is a freshly-built object every render (see its own header comment) and would otherwise
  // re-run this effect — and re-fire the event — on every subsequent re-render for the rest of
  // the (now frozen, game-over) session.
  const trackedWinRef = useRef(false);
  useEffect(() => {
    if (!state.winnerId || trackedWinRef.current) return;
    trackedWinRef.current = true;
    const payload = { winCondition: state.winCondition, roundNumber: state.roundNumber };
    if (p2p) {
      // P2P has a real per-device identity (p2p.myPlayerId) to compare the winner against, so
      // each connected client can tell its own win from its own loss.
      trackEvent(p2p.myPlayerId === state.winnerId ? 'game_win' : 'game_lose', { mode: 'p2p', ...payload });
    } else {
      // Hotseat is pass-and-play on one shared device — there's no stable "you" distinct from
      // the winner to compare against (hotseatAdmin.myPlayerId is just "whoever's turn it
      // currently is", not a real per-seat identity), so a win/lose split isn't meaningful here.
      // Track the table's own outcome once instead.
      trackEvent('game_win', { mode: 'hotseat', ...payload });
    }
  }, [state.winnerId, state.winCondition, state.roundNumber, p2p]);

  // [DEFAULT — direct request: "also add an event for when a player reaches round 10"]
  // roundNumber is shared game state, not per-player, so "a player reaches round 10" is really
  // "this client's own view of the game gets there" — exactly like game_start above, each
  // connected P2P client (host and every joiner) tracks its own arrival independently. Same
  // once-per-game ref-guard shape as trackedWinRef, and >= rather than === in case a future round
  // transition ever skips a number.
  const trackedRound10Ref = useRef(false);
  useEffect(() => {
    if (state.roundNumber < 10 || trackedRound10Ref.current) return;
    trackedRound10Ref.current = true;
    trackEvent('round_10_reached', { mode: p2p ? 'p2p' : 'hotseat' });
  }, [state.roundNumber, p2p]);

  function clearModes() {
    setMarchFrom(null);
    setPendingAssault(null);
    setHeroJoinsAssault(false);
    setRoadMode(false);
    setRoadAnchor(null);
  }

  if (state.winnerId) {
    const winner = state.players.find((p) => p.id === state.winnerId);
    return (
      <>
        <TableBackdrop />
        <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
          <span className="text-5xl motion-safe:animate-pop">🏆</span>
          <h2 className="font-display text-3xl font-bold motion-safe:animate-pop motion-safe:[animation-delay:120ms]" style={{ color: winner?.color }}>
            {winner?.name} wins!
          </h2>
          <p className="font-mono text-xs uppercase tracking-wide text-hx-ink-dim motion-safe:animate-fade-up motion-safe:[animation-delay:280ms]">
            Win condition: {state.winCondition ? WIN_CONDITION_LABEL[state.winCondition] : ''}
          </p>
          {/* [DEFAULT — direct request: "add exit game button somewhere"] The game is already
              over here, so no confirm needed — unlike the in-progress Exit button below. */}
          {onExit && (
            <button
              type="button"
              onClick={onExit}
              className={clsx(BTN_SECONDARY, 'mt-2 motion-safe:animate-fade-up motion-safe:[animation-delay:400ms]')}
            >
              🚪 Exit to menu
            </button>
          )}
        </div>
      </>
    );
  }

  /** Fires the actual march. Battles route through a confirmation step first (see the assault
   *  bar in ArmyPanel) — every other outcome is harmless enough to resolve on the click.
   *  [DEFAULT — hero battle participation] heroId/heroJoins are only ever set by that same
   *  confirmation step, for a contested march whose origin hero opted in — see
   *  MoveSoldiersAction.heroJoins's doc comment for why an uncontested reinforce/occupy never
   *  needs them. */
  function march(from: HexCoord, to: HexCoord, count: number, heroId?: string, heroJoins?: boolean) {
    const action: Action =
      heroJoins && heroId
        ? { type: 'MoveSoldiers', actorId: player.id, fromCoord: from, toCoord: to, count, heroId, heroJoins: true }
        : { type: 'MoveSoldiers', actorId: player.id, fromCoord: from, toCoord: to, count };
    void Promise.resolve(dispatch(action)).then((ok) => {
      if (!ok) return;
      setPendingAssault(null);
      setHeroJoinsAssault(false);
      setMarchFrom(null);
      setSelectedCoord(from);
    });
  }

  function handleMarchPick(target: MarchTarget, from: HexCoord, count: number) {
    if (target.outcome === 'battle') {
      setPendingAssault(target.coord);
      setHeroJoinsAssault(false); // fresh opt-in per battle target, never carried over silently
      return;
    }
    march(from, target.coord, count);
  }

  function handleRoadClick(coord: HexCoord) {
    if (!state.map[hexKey(coord)]) return; // nothing to run a road along yet
    if (!roadAnchor) {
      setRoadAnchor(coord);
      return;
    }
    if (roadAnchor.q === coord.q && roadAnchor.r === coord.r) {
      setRoadAnchor(null);
      return;
    }
    const isNeighbor = hexNeighbors(roadAnchor).some((n) => n.q === coord.q && n.r === coord.r);
    if (!isNeighbor) {
      setRoadAnchor(coord); // clicked somewhere far off — treat it as re-anchoring, not an error
      return;
    }
    void Promise.resolve(dispatch({ type: 'BuildRoad', actorId: player.id, from: roadAnchor, to: coord })).then((ok) => {
      // Chaining is the point of a road network, so a successful segment re-anchors on the tile
      // just reached instead of dropping out of the mode entirely.
      if (ok) setRoadAnchor(coord);
    });
  }

  function handleTileClick(coord: HexCoord) {
    if (!canAct) return;

    if (roadMode) {
      handleRoadClick(coord);
      return;
    }

    if (marchFrom) {
      const target = marchTargetsFrom(state, player, marchFrom).find((t) => t.coord.q === coord.q && t.coord.r === coord.r);
      if (target) {
        handleMarchPick(target, marchFrom, marchCount);
        return;
      }
      setMarchFrom(null); // clicked away from the march — stand down and select normally
      setPendingAssault(null);
      setHeroJoinsAssault(false);
    }

    setSelectedCoord(coord);

    if (state.currentPhase === Phase.DrawAndPlaceTile && state.pendingTileDraw) {
      if (highlightCoords.has(hexKey(coord))) {
        void dispatch({ type: 'PlaceTile', actorId: player.id, tileType: state.pendingTileDraw, coord });
      }
      return;
    }

    if (state.currentPhase === Phase.MoveHero) {
      const nextPath = [...pendingPath, coord];
      const check = checkMovePath(state, player, hero, nextPath);
      if (check.legal) setPendingPath(nextPath);
      return;
    }
  }

  return (
    <>
      <TableBackdrop />
      <div className="grid h-full grid-cols-1 gap-4 lg:grid-cols-[1fr_396px] lg:gap-x-0">
      {/* [DEFAULT — direct request: "the main left screen should not be scrollable .. zoom out
          if there's not enough space"] `min-h-0` at both levels here is the actual fix: a flex
          item's default `min-height: auto` refuses to shrink below its content's intrinsic size,
          which — combined with the board's old `min-h-[50vh]` FLOOR — forced this column taller
          than the grid row actually had room for the moment ResourceBar started sharing it,
          overflowing the viewport and forcing the whole page to scroll. With that floor gone and
          min-h-0 set, the board container genuinely fills "whatever's left after ResourceBar,"
          and HexBoard's own SVG viewBox (components/board/HexBoard.tsx) already scales to fit
          however many tiles are on it — the effective behavior IS "zoom out as the map grows,"
          it just needs the container to actually hand it a bounded box to zoom into. */}
      <div className="relative flex h-full min-h-0 flex-col gap-3">
        {/* [DEFAULT — UI feedback change, direct request: "move the stock panel from the sidebar
            to top of left screen to free some space"] ResourceBar is already a compact
            horizontal bar (flex-wrap of small pills) — moved off the sidebar entirely and onto
            the map column instead, so the sidebar has one fewer stacked panel. */}
        <ResourceBar player={player} />
        <div className="min-h-0 flex-1 overflow-hidden rounded-sm border border-hx-border-strong bg-hx-panel shadow-[0_4px_20px_-6px_rgba(0,0,0,0.6)]">
          <HexBoard
            state={state}
            highlightCoords={highlightCoords}
            pendingPath={pendingPath}
            onTileClick={handleTileClick}
            selectedCoord={selectedCoord}
            roadConnectedKeys={roadConnectedKeys}
            roadAnchor={roadMode ? roadAnchor : null}
            marchFrom={marchFrom}
            marchColor={player.color}
            unopenedDoorCoords={unopenedDoorCoords}
          />
        </div>
      </div>

      <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden lg:pl-4">
        {/* [DEFAULT — direct request: "a little chat in a second tab of sidebar .. badge with
            unread messages" / "a third tab which holds all saved games"] Game+Saves always show;
            Chat is P2P-only (hotseat/online have no `p2p` context and simply never render that
            one button — reproducing the strip's exact pre-existing layout for those modes save
            for the new Saves tab, which is deliberately NOT gated the same way). */}
        <div className="flex shrink-0 gap-1 border-b border-hx-border">
          <button
            type="button"
            onClick={() => setSidebarTab('game')}
            className={clsx(
              'flex-1 rounded-t-sm px-2 py-1.5 text-xs font-semibold transition',
              sidebarTab === 'game' ? 'border-b-2 border-hx-gold text-hx-gold' : 'text-hx-ink-faint hover:text-hx-ink'
            )}
          >
            🗺️ Game
          </button>
          {p2p && (
            <button
              type="button"
              onClick={() => setSidebarTab('chat')}
              className={clsx(
                'relative flex-1 rounded-t-sm px-2 py-1.5 text-xs font-semibold transition',
                sidebarTab === 'chat' ? 'border-b-2 border-hx-gold text-hx-gold' : 'text-hx-ink-faint hover:text-hx-ink'
              )}
            >
              💬 Chat
              {p2p.unreadChatCount > 0 && (
                <span className="absolute right-1 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-hx-blood px-1 font-mono text-[9px] text-hx-ink">
                  {p2p.unreadChatCount > 99 ? '99+' : p2p.unreadChatCount}
                </span>
              )}
            </button>
          )}
          <button
            type="button"
            onClick={() => setSidebarTab('saves')}
            className={clsx(
              'flex-1 rounded-t-sm px-2 py-1.5 text-xs font-semibold transition',
              sidebarTab === 'saves' ? 'border-b-2 border-hx-gold text-hx-gold' : 'text-hx-ink-faint hover:text-hx-ink'
            )}
          >
            💾 Saves
          </button>
        </div>
        {p2p && sidebarTab === 'chat' ? (
          <ChatPanel ctx={p2p} />
        ) : sidebarTab === 'saves' ? (
          <SavedGamesPanel
            mode={p2p ? 'p2p' : 'hotseat'}
            currentState={state}
            currentAiControlledPlayerIds={p2p?.aiControlledPlayerIds}
            currentHotseatPayload={currentHotseatPayload}
            onRestore={onRestore}
          />
        ) : (
      <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto">
        <div className={PANEL}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <PhaseTracker state={state} />
            </div>
            {/* [DEFAULT — direct request: "add exit game button somewhere"] A small, clearly
                secondary icon-button rather than a full-width CTA — leaving mid-game is rare and
                shouldn't compete for attention with the phase tracker it sits beside. Confirmed
                via a plain window.confirm rather than a custom modal: this only ever discards
                THIS device's own local/hosted session (hotseat's localStorage save, or a P2P
                room this device is hosting/in), never anything sent elsewhere, so a lightweight
                native confirm is proportionate. */}
            {onExit && (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm('Exit this game? You can resume a hotseat game later, but a P2P room closes for everyone once the host leaves.')) {
                    // [DEFAULT — direct request: "track ... when a user ... quits a running
                    // game"] This button only ever renders here, in the main (non-game-over)
                    // render — the finished-game screen above has its own separate, no-confirm
                    // "Exit to menu" button that doesn't count as quitting.
                    trackEvent('game_quit', { mode: p2p ? 'p2p' : 'hotseat', roundNumber: state.roundNumber });
                    onExit();
                  }
                }}
                title="Exit game"
                aria-label="Exit game"
                className="shrink-0 rounded-sm border border-hx-border px-2 py-1 text-xs text-hx-ink-faint transition hover:border-hx-blood/60 hover:text-hx-blood"
              >
                🚪 Exit
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="rounded-sm border border-hx-blood/60 bg-hx-blood/15 px-2.5 py-1.5 text-xs text-hx-ink">⚠️ {error}</div>
        )}
        {isAiTurn && (
          // [DEFAULT — direct feedback: "a lot of text doesn't have enough contrast to be
          // readable"] Was text-hx-arcane on bg-hx-arcane/15 — same-hue text on a tinted
          // background of itself, well under WCAG's 4.5:1 minimum (measured ~2.5:1). The border
          // still carries the arcane color cue; the text itself is now the high-contrast
          // default ink color used everywhere else.
          <div className="flex items-center gap-1.5 rounded-sm border border-hx-arcane/50 bg-hx-arcane/15 px-2.5 py-1.5 text-xs text-hx-ink">
            <span className="motion-safe:animate-pulse">{isPermanentAi ? '🤖' : '⏩'}</span>
            <span style={{ color: player.color }}>{player.name}</span>
            {isPermanentAi ? ' is thinking…' : "'s turn is being autoplayed…"}
          </div>
        )}
        {!isAiTurn && !isMyTurn && (
          <div className="rounded-sm border border-hx-border bg-hx-panel-2 px-2.5 py-1.5 text-xs text-hx-ink-dim">
            Waiting for <span style={{ color: player.color }}>{player.name}</span>&rsquo;s turn…
          </div>
        )}

        <div className="relative flex min-h-0 flex-col gap-3">

        {/* [DEFAULT — autoplay] Two controls, matching the ask exactly: a switch that only
            changes MODE (continuous vs single-round) and a button that's the actual go/stop
            trigger. Placed near the top, close to the phase tracker, since it's a meta-control a
            player might reach for at any point in their turn — not tied to one specific phase.
            The switch is THIS PLAYER's own — see currentPlayerContinuous's doc comment above. */}
        <div className={PANEL}>
          <div className="flex items-center justify-between gap-2">
            <IosSwitch
              checked={currentPlayerContinuous}
              disabled={!canAct}
              onChange={(next) => {
                setContinuousByPlayer((prev) => ({ ...prev, [state.currentPlayerId]: next }));
                // "until switch is deactivated again" — turning it off mid-run is itself the
                // stop signal for continuous mode, not just a mode change for next time.
                if (!next && autoplayActive) {
                  setAutoplayActive(false);
                  setAutoplayEngagedRound(null);
                  setRunIsContinuous(false);
                }
              }}
              label="🔁 Continuous"
            />
            <button
              type="button"
              disabled={!autoplayActive && !canAct}
              onClick={() => {
                if (autoplayActive) {
                  setAutoplayActive(false);
                  setAutoplayEngagedRound(null);
                  setRunIsContinuous(false);
                } else {
                  setAutoplayActive(true);
                  setAutoplayEngagedRound(state.roundNumber);
                  // Captured once, here, from the CURRENT player's switch at press-time — see
                  // runIsContinuous's doc comment for why this must not be re-derived later.
                  setRunIsContinuous(currentPlayerContinuous);
                }
              }}
              className={autoplayActive ? BTN_DANGER : BTN_SECONDARY}
              title={!autoplayActive && !canAct ? "Only available on your own turn" : undefined}
            >
              {autoplayActive ? '⏸ Stop autoplay' : currentPlayerContinuous ? '▶ Autoplay' : '▶ Play this round'}
            </button>
          </div>
          {autoplayActive && (
            <p className="mt-1.5 text-[11px] text-hx-ink-faint">
              {runIsContinuous
                ? 'Autoplaying continuously, round after round — flip the switch off to stop.'
                : `Autoplaying the rest of round ${autoplayEngagedRound} for you.`}
            </p>
          )}
        </div>

        {/* [DEFAULT — UI feedback change, direct request: "make current actions more prominent
            ... Draw Tile button is buried deep in the menu"] The single most important question
            on screen — "what do I do right now" — used to be answered by a plain PANEL wrapper
            sitting below PhaseTracker/HeroBattleBanner/HeroPanel/DoorCardPanel, indistinguishable
            from any other card. Moved to the top of the action stack (right under the phase
            tracker) and given its own unmissable treatment: a gold glow + shimmer whenever it's
            actually this seat's turn to act, an explicit phase icon/name header, and a "Your
            move" tag so the eye lands here first, not on the board or the resource bar. */}
        <div
          className={clsx(
            'rounded-sm border-2 p-3 transition-shadow',
            canAct
              ? 'border-hx-gold bg-hx-gold/10 shadow-[0_0_24px_-6px_rgba(217,164,65,0.6)] motion-safe:animate-shimmer'
              : 'border-hx-border bg-hx-panel-2/60'
          )}
        >
          <div className="mb-2.5 flex items-center gap-2">
            <span className="text-lg" aria-hidden="true">
              {PHASE_ICON[state.currentPhase]}
            </span>
            <span className={clsx('font-display text-sm font-bold', canAct ? 'text-hx-gold' : 'text-hx-ink-faint')}>
              {PHASE_LABEL[state.currentPhase]}
            </span>
            {canAct && (
              <span className="ml-auto font-mono text-[9px] font-bold uppercase tracking-wide text-hx-gold">▶ Your move</span>
            )}
          </div>
          <PhaseActions
            state={state}
            player={player}
            selectedCoord={selectedCoord}
            setSelectedCoord={setSelectedCoord}
            pendingPath={pendingPath}
            setPendingPath={setPendingPath}
            marchFrom={marchFrom}
            setMarchFrom={setMarchFrom}
            marchCount={marchCount}
            setMarchCount={setMarchCount}
            pendingAssault={pendingAssault}
            setPendingAssault={setPendingAssault}
            heroJoinsAssault={heroJoinsAssault}
            setHeroJoinsAssault={setHeroJoinsAssault}
            onMarchPick={handleMarchPick}
            onMarchConfirm={march}
            dispatch={dispatch}
            canAct={canAct}
          />

          {/* [DEFAULT — UI feedback change, direct request: "move the next phase and end turn
              button to the top under available actions"] Right inside the same prominent CTA
              box as the phase actions themselves — advancing IS the natural next step once
              those actions are done, so it reads as one continuous flow instead of a control
              buried at the bottom of a long scrolling sidebar. */}
          {doorMonsterPendingForMe && (
            <div className="mt-3 rounded-sm border border-hx-blood/60 bg-hx-blood/15 px-2.5 py-1.5 text-xs text-hx-ink motion-safe:animate-shimmer">
              🚪👹 A Door monster is still standing in the way — resolve it in the Fight phase before you can end this turn.
            </div>
          )}

          {/* [DEFAULT — direct request: "Next phase should be disabled until drawn a card"]
              Phase 1 opens with no tile drawn and nothing placed yet — advancing (or skipping
              straight to End Turn) before EITHER has happened would silently forfeit the whole
              phase's action. Cleared the instant a tile is drawn (even before it's placed) or
              once one has already been placed this turn. */}
          {noTileDrawnYet && (
            <p className="mt-3 text-[11px] text-hx-ink-faint">🎴 Draw a tile before advancing.</p>
          )}

          <button
            type="button"
            disabled={!canAct || noTileDrawnYet || (doorMonsterPendingForMe && state.currentPhase === Phase.Fight)}
            title={
              noTileDrawnYet
                ? 'Draw a tile first'
                : doorMonsterPendingForMe && state.currentPhase === Phase.Fight
                  ? 'Fight the Door monster before leaving this phase'
                  : undefined
            }
            onClick={() => {
              setSelectedCoord(null);
              setPendingPath([]);
              clearModes();
              void dispatch({ type: 'AdvancePhase', actorId: player.id });
            }}
            className={clsx(BTN_PRIMARY, 'mt-3 w-full')}
          >
            {state.currentPhase === Phase.Build ? 'End Turn ▶' : 'Next Phase ▶'}
          </button>

          {state.currentPhase !== Phase.Build && (
            <button
              type="button"
              disabled={!canAct || noTileDrawnYet || doorMonsterPendingForMe}
              title={noTileDrawnYet ? 'Draw a tile first' : doorMonsterPendingForMe ? 'Fight the Door monster before ending your turn' : undefined}
              onClick={() => {
                setSelectedCoord(null);
                setPendingPath([]);
                clearModes();
                void dispatch({ type: 'EndTurn', actorId: player.id });
              }}
              className={clsx(BTN_GHOST, 'mt-2 w-full')}
            >
              ⏭️ End Turn (skip remaining phases)
            </button>
          )}
        </div>

        {/* [DEFAULT — UI feedback change, direct request: "All building actions should be in an
            extra panel with icons for every structure that can be built .. not at the bottom of
            sidebar but rather more prominent"] Its own standalone panel, positioned right after
            the main CTA box — high enough to be seen without scrolling, always in the same spot
            turn after turn, rather than nested at the bottom of whatever else Phase 5's CTA
            content happened to contain.
            [DEFAULT — direct request: "The build actions panel should not be visible outside
            build phase"] Only rendered during Phase 5 now — no longer a stable always-present
            panel with a "locked" state, just hidden until it's actually relevant. */}
        {/* [DEFAULT — UI feedback change, direct request: "this should also go in the buildings
            panel" (re: the Roads & supply panel)] Roads are construction too — merged into
            BuildMenu as its own section instead of a separate standalone panel, so there's one
            "everything you can build" panel instead of two. */}
        {state.currentPhase === Phase.Build && (
          <BuildMenu
            state={state}
            player={player}
            selectedCoord={selectedCoord}
            dispatch={dispatch}
            canAct={canAct}
            roadMode={roadMode}
            roadAnchor={roadAnchor}
            roadConnectedCount={roadConnectedKeys.size}
            onRoadArm={() => {
              setMarchFrom(null);
              setPendingAssault(null);
              setRoadAnchor(null);
              setRoadMode(true);
            }}
            onRoadCancel={() => {
              setRoadMode(false);
              setRoadAnchor(null);
            }}
          />
        )}

        <HeroBattleBanner state={state} />

        <HeroPanel player={player} hero={hero} dispatch={dispatch} canAct={canAct} />

        <DoorCardPanel state={state} />

        <TradePanel player={player} dispatch={dispatch} canAct={canAct} />
        </div>
      </div>
        )}
      </div>
      </div>
      {adminCtx && showAdminMenu && <AdminMenu ctx={adminCtx} onClose={() => setShowAdminMenu(false)} />}
    </>
  );
}

interface HighlightModes {
  roadMode: boolean;
  roadAnchor: HexCoord | null;
  marchFrom: HexCoord | null;
}

function computeHighlights(state: GameState, player: Player, pendingPath: HexCoord[], modes: HighlightModes): Set<string> {
  const set = new Set<string>();

  // Both explicit modes take the board over completely while armed: mixing "these hexes are
  // where your hero may walk" with "these hexes are where a road may go" in one gold highlight
  // would make the board lie about what a click does.
  if (modes.roadMode) return roadEndpointOptions(state, player, modes.roadAnchor);

  if (modes.marchFrom) {
    for (const target of marchTargetsFrom(state, player, modes.marchFrom)) set.add(hexKey(target.coord));
    return set;
  }

  if (state.currentPhase === Phase.DrawAndPlaceTile && state.pendingTileDraw) {
    for (const owned of player.ownedTiles) {
      for (const n of hexNeighbors(owned)) {
        if (!state.map[hexKey(n)]) set.add(hexKey(n));
      }
    }
  }

  if (state.currentPhase === Phase.MoveHero) {
    const from = pendingPath.length > 0 ? pendingPath[pendingPath.length - 1] : player.hero.position;
    for (const n of hexNeighbors(from)) {
      const check = checkMovePath(state, player, player.hero, [...pendingPath, n]);
      if (check.legal) set.add(hexKey(n));
    }
  }

  if (state.currentPhase === Phase.Build) {
    for (const owned of player.ownedTiles) set.add(hexKey(owned));
  }

  return set;
}

interface PhaseActionsProps {
  state: GameState;
  player: Player;
  selectedCoord: HexCoord | null;
  setSelectedCoord: (c: HexCoord | null) => void;
  pendingPath: HexCoord[];
  setPendingPath: (p: HexCoord[]) => void;
  marchFrom: HexCoord | null;
  setMarchFrom: (c: HexCoord | null) => void;
  marchCount: number;
  setMarchCount: (n: number) => void;
  pendingAssault: HexCoord | null;
  setPendingAssault: (c: HexCoord | null) => void;
  /** [DEFAULT — hero battle participation] See heroJoinsAssault's doc comment in GameBoardApp. */
  heroJoinsAssault: boolean;
  setHeroJoinsAssault: (v: boolean) => void;
  onMarchPick: (target: MarchTarget, from: HexCoord, count: number) => void;
  onMarchConfirm: (from: HexCoord, to: HexCoord, count: number, heroId?: string, heroJoins?: boolean) => void;
  dispatch: (action: Action) => boolean | Promise<boolean>;
  canAct: boolean;
}

function PhaseActions(props: PhaseActionsProps) {
  const { state, player, pendingPath, setPendingPath, dispatch, canAct } = props;
  const hero = player.hero;

  switch (state.currentPhase) {
    case Phase.DrawAndPlaceTile:
      if (state.hasPlacedTileThisTurn) {
        return <p className="text-xs text-hx-ink-faint">Tile placed for this turn — advance to the next phase.</p>;
      }
      if (!state.pendingTileDraw) {
        // [DEFAULT — UI feedback change, direct request: "Draw Tile button is buried deep in
        // the menu"] The one and only thing to do to open this phase — promoted to the same
        // unmissable BTN_PRIMARY treatment as "Confirm Move" and "End Turn" get, instead of the
        // same quiet BTN_SECONDARY every optional Gather action uses.
        return (
          <button
            type="button"
            disabled={!canAct}
            onClick={() => void dispatch({ type: 'DrawTile', actorId: player.id })}
            className={clsx(BTN_PRIMARY, 'w-full text-center motion-safe:animate-pulse')}
          >
            🎴 Draw a tile
          </button>
        );
      }
      return (
        <p className="text-xs text-hx-ink-dim">
          Drew a <strong className="text-hx-gold">{state.pendingTileDraw}</strong> tile — click a highlighted hex to place it.
        </p>
      );

    case Phase.MoveHero:
      return (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-hx-ink-dim">Click adjacent highlighted hexes to build a path (movement range {heroRangeLabel(hero)}).</p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!canAct || pendingPath.length === 0}
              onClick={() =>
                void Promise.resolve(dispatch({ type: 'MoveHero', actorId: player.id, path: pendingPath })).then((ok) => ok && setPendingPath([]))
              }
              className="flex-1 rounded-sm border border-hx-arcane bg-hx-arcane px-2 py-1.5 text-xs font-semibold text-hx-ink transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Confirm Move
            </button>
            <button type="button" disabled={!canAct || pendingPath.length === 0} onClick={() => setPendingPath([])} className={BTN_GHOST}>
              Clear
            </button>
          </div>
        </div>
      );

    case Phase.Gather: {
      const tile = tileAt(state, hero.position);
      const isRogue = classDefFor(player).startingBonus.kind === 'Rogue';
      const stockpileTotal = tile ? RESOURCE_TYPES.reduce((sum, r) => sum + tile.stockpile[r], 0) : 0;
      const fullyLoaded = remainingCarryCapacity(hero) <= 0;
      return (
        <div className="flex flex-col gap-2">
          {fullyLoaded && (
            <p className="rounded-sm border border-hx-copper/50 bg-hx-copper/10 px-2 py-1.5 text-xs text-hx-ink">
              🎒 Hero is at full carrying capacity — visit your Capital to deposit before gathering more.
            </p>
          )}
          {tile?.ownerId === player.id && stockpileTotal > 0 && (
            <button
              type="button"
              disabled={!canAct || fullyLoaded}
              onClick={() => void dispatch({ type: 'Gather', actorId: player.id, coord: hero.position, gatherKind: 'CollectResources' })}
              className={BTN_SECONDARY}
            >
              📦 Collect {stockpileTotal} accumulated resource{stockpileTotal === 1 ? '' : 's'} here
            </button>
          )}
          {tile && tile.ownerId !== player.id && ['Forest', 'Plains', 'Hills', 'Mountain', 'Desert'].includes(tile.type) && (
            <button type="button" disabled={!canAct || fullyLoaded} onClick={() => void dispatch({ type: 'Gather', actorId: player.id, coord: hero.position, gatherKind: 'Forage' })} className={BTN_SECONDARY}>
              🧺 Forage this tile
            </button>
          )}
          {/* hasBeenLooted: a dungeon's hoard is taken once. Without this the button stayed live
              forever on a cleared Ruins tile and could be clicked to drain the whole Loot deck. */}
          {tile?.type === 'Ruins' && !tile.monsterDenCardId && !tile.hasBeenLooted && (
            <button type="button" disabled={!canAct} onClick={() => void dispatch({ type: 'Gather', actorId: player.id, coord: hero.position, gatherKind: 'LootRuins' })} className={BTN_SECONDARY}>
              💰 Loot cleared Ruins
            </button>
          )}
          {tile?.type === 'Ruins' && !tile.monsterDenCardId && tile.hasBeenLooted && (
            <p className="text-xs text-hx-ink-faint">🕸️ These Ruins have already been picked clean.</p>
          )}
          {tile?.ownerId === player.id && tile.building?.type === 'HuntingLodge' && (
            <button type="button" disabled={!canAct || fullyLoaded} onClick={() => void dispatch({ type: 'Gather', actorId: player.id, coord: hero.position, gatherKind: 'Hunt' })} className={BTN_SECONDARY}>
              🏹 Hunt
            </button>
          )}
          {isRogue && !player.hasStolenThisRound && (
            <button type="button" disabled={!canAct || fullyLoaded} onClick={() => void dispatch({ type: 'Gather', actorId: player.id, coord: hero.position, gatherKind: 'RogueSteal' })} className={BTN_SECONDARY}>
              🗡️ Rogue Steal from adjacent rival
            </button>
          )}
          <p className="text-xs text-hx-ink-faint">No eligible action? Just advance to the next phase.</p>
        </div>
      );
    }

    case Phase.Fight: {
      const tile = tileAt(state, hero.position);
      const rivalHeroHere = state.players.find((p) => p.id !== player.id && samePos(p.hero.position, hero.position));

      return (
        <div className="flex flex-col gap-2">
          <PendingDoorMonsterBanner state={state} player={player} dispatch={dispatch} canAct={canAct} />
          {tile?.type === 'Ruins' && tile.monsterDenCardId && (
            <button
              type="button"
              disabled={!canAct}
              onClick={() => void dispatch({ type: 'Fight', actorId: player.id, combatType: 'HeroVsMonster', coord: hero.position, monsterCardId: tile.monsterDenCardId! })}
              className={BTN_DANGER}
            >
              ⚔️ Fight the Monster here
            </button>
          )}
          {tile?.type === 'Volcano' && !tile.isTamed && (
            <button type="button" disabled={!canAct} onClick={() => void dispatch({ type: 'Fight', actorId: player.id, combatType: 'TameVolcano', coord: hero.position })} className={BTN_DANGER}>
              🌋 Attempt to tame the Volcano
            </button>
          )}
          {rivalHeroHere && (
            <button
              type="button"
              disabled={!canAct}
              onClick={() =>
                void dispatch({
                  type: 'Fight',
                  actorId: player.id,
                  combatType: 'HeroVsHero',
                  targetPlayerId: rivalHeroHere.id,
                  targetHeroId: rivalHeroHere.hero.id,
                  isBackstab: true,
                })
              }
              className={BTN_DANGER}
            >
              🗡️ Duel {rivalHeroHere.name}&rsquo;s hero here
            </button>
          )}
          {!tile?.monsterDenCardId && tile?.type !== 'Volcano' && !rivalHeroHere && !isDoorMonsterPendingFor(state, player) && (
            <p className="text-xs text-hx-ink-faint">Nothing for your hero to fight from here.</p>
          )}
          {/* The old "attack the tile next to my Barracks" button lived here. Territory is no
              longer taken at range — troops take ground by walking onto it in Phase 5. */}
          <p className="rounded-sm border border-hx-border bg-hx-panel-2 px-2 py-1.5 text-[11px] text-hx-ink-faint">
            🛡️ This phase is for your <em>hero</em>. Territory changes hands in Phase 5, by marching Soldiers onto an adjacent tile.
          </p>
        </div>
      );
    }

    case Phase.Build:
      // [DEFAULT — UI feedback change, direct request: "All building actions should be in an
      // extra panel ... not at the bottom of sidebar but rather more prominent"] BuildMenu used
      // to render nested here, inside the CTA box; it's now its own standalone, top-level sidebar
      // panel (see GameBoardApp's return JSX) so it gets a stable, prominent position instead of
      // being buried at the bottom of whatever this phase's CTA box happens to contain.
      return <ArmyPanel {...props} />;

    default:
      return null;
  }
}

/** [DEFAULT — territory rework] The whole territory war in one panel: where your Soldiers are,
 *  how many of them are about to walk, and — before any click commits anything — exactly which of
 *  reinforce / occupy / battle each adjacent tile would be. */
function ArmyPanel({
  state,
  player,
  selectedCoord,
  setSelectedCoord,
  marchFrom,
  setMarchFrom,
  marchCount,
  setMarchCount,
  pendingAssault,
  setPendingAssault,
  heroJoinsAssault,
  setHeroJoinsAssault,
  onMarchPick,
  onMarchConfirm,
  canAct,
}: PhaseActionsProps) {
  const garrisons = garrisonsOf(state, player);
  const selectedTile = selectedCoord ? state.map[hexKey(selectedCoord)] : undefined;
  const selectedIsMine = !!selectedTile && garrisonOwnerOf(selectedTile) === player.id && (selectedTile.militiaCount ?? 0) > 0;
  const origin = marchFrom ?? (selectedIsMine ? selectedCoord : null);
  const originTile = origin ? state.map[hexKey(origin)] : undefined;
  const available = originTile?.militiaCount ?? 0;
  const count = Math.max(1, Math.min(marchCount, available || 1));
  const targets = origin ? marchTargetsFrom(state, player, origin) : [];
  const assaultTarget = pendingAssault ? targets.find((t) => t.coord.q === pendingAssault.q && t.coord.r === pendingAssault.r) : undefined;
  // [DEFAULT — hero battle participation] The hero (if any) standing right where this march would
  // set off from — only such a hero can lend their die (MoveSoldiersAction.heroJoins requires
  // hero.position === fromCoord).
  const originHero = origin ? heroAtCoord(player, origin) : null;

  if (garrisons.length === 0) {
    return (
      <div className="flex flex-col gap-1.5">
        <h3 className="font-display text-sm font-bold text-hx-ink">⚔️ Army</h3>
        <p className="text-xs text-hx-ink-faint">
          No Soldiers in the field. A Barracks unlocks recruitment and fills its own tile each round — deploy that reserve, then march it to a
          border.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-display text-sm font-bold text-hx-ink">⚔️ Army — march &amp; hold</h3>
        <span className="font-mono text-[10px] uppercase tracking-wide text-hx-ink-faint">free action</span>
      </div>

      {/* Where your troops are. Doubles as the origin picker: territory is won by whichever
          stack is standing on the ground, so "where are my soldiers" is the first question. */}
      <ul className="flex flex-col gap-1">
        {garrisons.map((t) => {
          const isOrigin = !!origin && origin.q === t.coord.q && origin.r === t.coord.r;
          const foreign = t.ownerId !== player.id;
          return (
            <li key={hexKey(t.coord)}>
              <button
                type="button"
                disabled={!canAct}
                onClick={() => {
                  setSelectedCoord(t.coord);
                  setMarchFrom(null);
                  setPendingAssault(null);
                  setHeroJoinsAssault(false);
                  setMarchCount(t.militiaCount ?? 1);
                }}
                className={`w-full rounded-sm border px-2 py-1 text-left text-[11px] transition ${
                  isOrigin ? 'border-hx-gold bg-hx-gold text-hx-bg' : 'border-hx-border bg-hx-panel-2 text-hx-ink-dim hover:border-hx-gold/50'
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span>
                    <span className="font-mono font-bold" style={{ color: player.color }}>
                      {foreign ? '⚑' : '⚔'} {t.militiaCount}
                    </span>{' '}
                    {t.type} <span className="font-mono text-hx-ink-dim">({t.coord.q},{t.coord.r})</span>
                  </span>
                  {foreign && (
                    <span className="font-mono text-[9px] uppercase tracking-wide text-hx-gold-bright">
                      holding · R{(t.occupationSinceRound ?? state.roundNumber) + 1}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {!origin && <p className="text-xs text-hx-ink-faint">Pick a stack above (or click its tile) to march it.</p>}

      {origin && available > 0 && (
        <div className="flex flex-col gap-2 rounded-sm border border-hx-border bg-hx-panel-2 p-2">
          <div className="flex items-center gap-2">
            <label htmlFor="march-count" className="text-[11px] text-hx-ink-dim">
              March
            </label>
            <input
              id="march-count"
              type="number"
              min={1}
              max={available}
              disabled={!canAct}
              value={count}
              onChange={(e) => setMarchCount(Math.max(1, Math.min(available, Number(e.target.value) || 1)))}
              className={`w-14 ${INPUT}`}
            />
            <span className="text-[11px] text-hx-ink-faint">of {available}</span>
            <button type="button" disabled={!canAct} onClick={() => setMarchCount(available)} className="ml-auto rounded-sm border border-hx-border px-1.5 py-0.5 text-[10px] text-hx-ink-dim transition hover:border-hx-gold/50 hover:text-hx-ink disabled:cursor-not-allowed disabled:opacity-40">
              All
            </button>
          </div>

          <button
            type="button"
            disabled={!canAct}
            onClick={() => {
              setPendingAssault(null);
              setHeroJoinsAssault(false);
              setMarchFrom(marchFrom ? null : origin);
            }}
            className={`${BTN_SECONDARY} text-center`}
          >
            {marchFrom ? '✖ Cancel map picking' : '🗺️ Pick destination on the map'}
          </button>

          {targets.length === 0 && <p className="text-[11px] text-hx-ink-faint">Nowhere to march — no placed tile borders this one yet.</p>}

          {targets.map((t) => {
            const meta = MARCH_META[t.outcome];
            return (
              <button
                key={hexKey(t.coord)}
                type="button"
                disabled={!canAct}
                onClick={() => onMarchPick(t, origin, count)}
                className={`flex flex-col gap-0.5 rounded-sm border px-2 py-1.5 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${meta.className}`}
              >
                {/* [DEFAULT — direct feedback follow-up] text-hx-ink(-dim/-faint) below was
                    designed for dark panel backdrops; bumped up a tier now that the buttons
                    above are solid, saturated fills rather than dark translucent washes. */}
                <span className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-semibold text-hx-ink">
                    {meta.icon} {meta.label} → {t.tile.type}
                  </span>
                  <span className="font-mono text-[10px] text-hx-ink">
                    ({t.coord.q},{t.coord.r})
                  </span>
                </span>
                <span className="text-[11px] text-hx-ink-dim">{marchBlurb(t, count)}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* A battle is the one outcome you can't take back, so it gets its own confirmation with
          the actual numbers on it rather than resolving under the first click. */}
      {assaultTarget && origin && (
        <div className="flex flex-col gap-2 rounded-sm border border-hx-blood bg-hx-blood/20 p-2">
          <p className="text-xs text-hx-ink">
            ⚔️ Assault {assaultTarget.defenderName} at ({assaultTarget.coord.q},{assaultTarget.coord.r}): <strong>{count}</strong> attackers vs{' '}
            <strong>{assaultTarget.defenders}</strong> defenders{assaultTarget.hasWatchtower ? ' behind a Watchtower' : ''}. Dice resolve
            immediately; survivors that win must hold the ground into your next turn to claim it, losers fall back.
          </p>

          {/* [DEFAULT — hero battle participation] Only offerable when a hero is actually standing
              right here to lead the charge, and only for a genuinely contested tile — see
              MoveSoldiersAction.heroJoins's doc comment ("ignored on an uncontested move"). */}
          {originHero && assaultTarget.outcome === 'battle' && (
            <label className="flex cursor-pointer items-start gap-2 rounded-sm border border-hx-blood/50 bg-hx-bg/40 px-2 py-1.5 text-[11px] text-hx-ink">
              <input
                type="checkbox"
                checked={heroJoinsAssault}
                disabled={!canAct}
                onChange={(e) => setHeroJoinsAssault(e.target.checked)}
                className="mt-0.5 accent-hx-blood"
              />
              <span>
                🗡️ <strong>Hero joins the attack</strong> — lends an extra die to the fight.
                Win it and the army lands a free extra kill; lose it and the hero eats real HP damage instead. If that drops them to 0
                <em> here</em>, it&rsquo;s permanent: a fresh level-1 hero replaces them with none of the fallen one&rsquo;s gear, XP, or
                levels — far harsher than an ordinary monster fight&rsquo;s downed-and-retreat.
              </span>
            </label>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              disabled={!canAct}
              onClick={() =>
                onMarchConfirm(
                  origin,
                  assaultTarget.coord,
                  count,
                  originHero && heroJoinsAssault ? originHero.id : undefined,
                  originHero && heroJoinsAssault ? true : undefined
                )
              }
              className={`flex-1 ${BTN_DANGER}`}
            >
              ⚔️ Attack{originHero && heroJoinsAssault ? ' (hero joins)' : ''}
            </button>
            <button
              type="button"
              disabled={!canAct}
              onClick={() => {
                setPendingAssault(null);
                setHeroJoinsAssault(false);
              }}
              className={clsx(BTN_GHOST, 'disabled:cursor-not-allowed disabled:opacity-40')}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function heroRangeLabel(hero: GameState['players'][number]['hero']): number {
  return movementRangeFor(hero);
}

function samePos(a: HexCoord, b: HexCoord) {
  return a.q === b.q && a.r === b.r;
}

/** [DEFAULT — hero battle participation] Whether this player's hero is physically standing on
 *  `coord` — used to decide whether the "hero joins the attack" toggle applies to a march. */
function heroAtCoord(player: Player, coord: HexCoord): Player['hero'] | null {
  return samePos(player.hero.position, coord) ? player.hero : null;
}
