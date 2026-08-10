'use client';

import { useMemo, useState } from 'react';
import Image from 'next/image';
import { SCREEN_ART } from '@/components/screenArt';
import {
  Phase,
  RESOURCE_TYPES,
  ROAD_COST,
  applyMageDiscount,
  checkMovePath,
  classDefFor,
  edgeKey,
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
  type ResourceCost,
  type Tile,
  type WinCondition,
} from '@/engine';
import { HexBoard } from '@/components/board/HexBoard';
import { HeroPanel } from '@/components/hero/HeroPanel';
import { HeroBattleBanner } from '@/components/hero/HeroBattleBanner';
import { DoorCardPanel, PendingDoorMonsterBanner, isDoorMonsterPendingFor, unvisitedHighlightKeys } from '@/components/hero/DoorCardPanel';
import { PhaseTracker } from '@/components/hud/PhaseTracker';
import { ResourceBar } from '@/components/hud/ResourceBar';
import { BuildMenu } from '@/components/build/BuildMenu';
import { TradePanel } from '@/components/hud/TradePanel';
import { BTN_DANGER, BTN_GHOST, BTN_PRIMARY, BTN_SECONDARY, INPUT, PANEL } from '@/components/uiClasses';
import { useAiTurn } from '@/hooks/use-ai-turn';

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
  reinforce: {
    icon: '🛡️',
    label: 'Reinforce',
    className: 'border-hx-moss/60 bg-hx-moss/15 hover:bg-hx-moss/25',
  },
  occupy: {
    icon: '🚩',
    label: 'Occupy',
    className: 'border-hx-copper/70 bg-hx-copper/15 hover:bg-hx-copper/25',
  },
  battle: {
    icon: '⚔️',
    label: 'Battle',
    className: 'border-hx-blood/70 bg-hx-blood/20 hover:bg-hx-blood/35',
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

/** [DEFAULT — roads] Hexes that can serve as an end of a NEW road segment. With an anchor
 *  picked, this narrows to the neighbours that would complete a legal segment; without one it's
 *  every hex that has at least one such segment left in it. Mirrors applyBuildRoad's rules:
 *  both ends placed, at least one end owned by the actor, edge not already carrying a road. */
function roadEndpointOptions(state: GameState, player: Player, anchor: HexCoord | null): Set<string> {
  const options = new Set<string>();
  const legal = (a: HexCoord, b: HexCoord) => {
    const ta = state.map[hexKey(a)];
    const tb = state.map[hexKey(b)];
    if (!ta || !tb) return false;
    if (ta.ownerId !== player.id && tb.ownerId !== player.id) return false;
    return !state.roads?.[edgeKey(a, b)];
  };

  if (anchor) {
    for (const n of hexNeighbors(anchor)) if (legal(anchor, n)) options.add(hexKey(n));
    return options;
  }
  for (const tile of Object.values(state.map)) {
    for (const n of hexNeighbors(tile.coord)) {
      if (legal(tile.coord, n)) {
        options.add(hexKey(tile.coord));
        break;
      }
    }
  }
  return options;
}

function costLabel(cost: ResourceCost): string {
  return (
    RESOURCE_TYPES.filter((r) => (cost[r] ?? 0) > 0)
      .map((r) => `${cost[r]} ${r}`)
      .join(' + ') || 'free'
  );
}

export function GameBoardApp({ state, dispatch, error, isMyTurn, aiPlayerIds = NO_AI_PLAYERS }: GameBoardAppProps) {
  const [selectedCoord, setSelectedCoord] = useState<HexCoord | null>(null);
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

  const player = state.players.find((p) => p.id === state.currentPlayerId)!;
  const hero = player.hero;
  const isAiTurn = aiPlayerIds.has(state.currentPlayerId);
  const canAct = isMyTurn && !isAiTurn && !state.winnerId;

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
  useAiTurn(state, aiPlayerIds, dispatch);

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
      <div className="grid h-full grid-cols-1 gap-4 lg:grid-cols-[1fr_380px]">
      <div className="min-h-[50vh] overflow-hidden rounded-sm border border-hx-border-strong bg-hx-panel shadow-[0_4px_20px_-6px_rgba(0,0,0,0.6)]">
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

      <div className="flex flex-col gap-3 overflow-y-auto">
        <div className={PANEL}>
          <PhaseTracker state={state} />
        </div>
        <ResourceBar player={player} />
        {error && (
          <div className="rounded-sm border border-hx-blood/60 bg-hx-blood/15 px-2.5 py-1.5 text-xs text-hx-ink">⚠️ {error}</div>
        )}
        {isAiTurn && (
          <div className="flex items-center gap-1.5 rounded-sm border border-hx-arcane/50 bg-hx-arcane/15 px-2.5 py-1.5 text-xs text-hx-arcane">
            <span className="motion-safe:animate-pulse">🤖</span>
            <span style={{ color: player.color }}>{player.name}</span> is thinking…
          </div>
        )}
        {!isAiTurn && !isMyTurn && (
          <div className="rounded-sm border border-hx-border bg-hx-panel-2 px-2.5 py-1.5 text-xs text-hx-ink-dim">
            Waiting for <span style={{ color: player.color }}>{player.name}</span>&rsquo;s turn…
          </div>
        )}

        <HeroBattleBanner state={state} />

        <HeroPanel player={player} hero={hero} dispatch={dispatch} canAct={canAct} />

        <DoorCardPanel state={state} />

        <div className={PANEL}>
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
        </div>

        <RoadPanel
          state={state}
          player={player}
          roadMode={roadMode}
          roadAnchor={roadAnchor}
          connectedCount={roadConnectedKeys.size}
          canAct={canAct}
          onArm={() => {
            setMarchFrom(null);
            setPendingAssault(null);
            setRoadAnchor(null);
            setRoadMode(true);
          }}
          onCancel={() => {
            setRoadMode(false);
            setRoadAnchor(null);
          }}
        />

        <TradePanel player={player} dispatch={dispatch} canAct={canAct} />

        {doorMonsterPendingForMe && (
          <div className="rounded-sm border border-hx-blood/60 bg-hx-blood/15 px-2.5 py-1.5 text-xs text-hx-ink motion-safe:animate-shimmer">
            🚪👹 A Door monster is still standing in the way — resolve it in the Fight phase before you can end this turn.
          </div>
        )}

        <button
          type="button"
          disabled={!canAct || (doorMonsterPendingForMe && state.currentPhase === Phase.Fight)}
          title={doorMonsterPendingForMe && state.currentPhase === Phase.Fight ? 'Fight the Door monster before leaving this phase' : undefined}
          onClick={() => {
            setSelectedCoord(null);
            setPendingPath([]);
            clearModes();
            void dispatch({ type: 'AdvancePhase', actorId: player.id });
          }}
          className={BTN_PRIMARY}
        >
          {state.currentPhase === Phase.Build ? 'End Turn ▶' : 'Next Phase ▶'}
        </button>

        {state.currentPhase !== Phase.Build && (
          <button
            type="button"
            disabled={!canAct || doorMonsterPendingForMe}
            title={doorMonsterPendingForMe ? 'Fight the Door monster before ending your turn' : undefined}
            onClick={() => {
              setSelectedCoord(null);
              setPendingPath([]);
              clearModes();
              void dispatch({ type: 'EndTurn', actorId: player.id });
            }}
            className={BTN_GHOST}
          >
            ⏭️ End Turn (skip remaining phases)
          </button>
        )}
      </div>
      </div>
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
  const { state, player, selectedCoord, pendingPath, setPendingPath, dispatch, canAct } = props;
  const hero = player.hero;

  switch (state.currentPhase) {
    case Phase.DrawAndPlaceTile:
      if (state.hasPlacedTileThisTurn) {
        return <p className="text-xs text-hx-ink-faint">Tile placed for this turn — advance to the next phase.</p>;
      }
      if (!state.pendingTileDraw) {
        return (
          <button type="button" disabled={!canAct} onClick={() => void dispatch({ type: 'DrawTile', actorId: player.id })} className={BTN_SECONDARY}>
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
              className="flex-1 rounded-sm border border-hx-arcane bg-hx-arcane/25 px-2 py-1.5 text-xs font-semibold text-hx-ink transition hover:bg-hx-arcane/40 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Confirm Move
            </button>
            <button type="button" disabled={pendingPath.length === 0} onClick={() => setPendingPath([])} className={BTN_GHOST}>
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
            <p className="rounded-sm border border-hx-copper/50 bg-hx-copper/10 px-2 py-1.5 text-xs text-hx-copper">
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
      return (
        <div className="flex flex-col gap-3">
          <ArmyPanel {...props} />
          <div className="border-t border-hx-border pt-3">
            <BuildMenu state={state} player={player} selectedCoord={selectedCoord} dispatch={dispatch} canAct={canAct} />
          </div>
        </div>
      );

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
                onClick={() => {
                  setSelectedCoord(t.coord);
                  setMarchFrom(null);
                  setPendingAssault(null);
                  setHeroJoinsAssault(false);
                  setMarchCount(t.militiaCount ?? 1);
                }}
                className={`w-full rounded-sm border px-2 py-1 text-left text-[11px] transition ${
                  isOrigin ? 'border-hx-gold bg-hx-gold/15 text-hx-ink' : 'border-hx-border bg-hx-panel-2 text-hx-ink-dim hover:border-hx-gold/50'
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span>
                    <span className="font-mono font-bold" style={{ color: player.color }}>
                      {foreign ? '⚑' : '⚔'} {t.militiaCount}
                    </span>{' '}
                    {t.type} <span className="font-mono text-hx-ink-faint">({t.coord.q},{t.coord.r})</span>
                  </span>
                  {foreign && (
                    <span className="font-mono text-[9px] uppercase tracking-wide text-hx-copper">
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
              value={count}
              onChange={(e) => setMarchCount(Math.max(1, Math.min(available, Number(e.target.value) || 1)))}
              className={`w-14 ${INPUT}`}
            />
            <span className="text-[11px] text-hx-ink-faint">of {available}</span>
            <button type="button" onClick={() => setMarchCount(available)} className="ml-auto rounded-sm border border-hx-border px-1.5 py-0.5 text-[10px] text-hx-ink-dim transition hover:border-hx-gold/50 hover:text-hx-ink">
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
                <span className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-semibold text-hx-ink">
                    {meta.icon} {meta.label} → {t.tile.type}
                  </span>
                  <span className="font-mono text-[10px] text-hx-ink-dim">
                    ({t.coord.q},{t.coord.r})
                  </span>
                </span>
                <span className="text-[11px] text-hx-ink-faint">{marchBlurb(t, count)}</span>
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
              onClick={() => {
                setPendingAssault(null);
                setHeroJoinsAssault(false);
              }}
              className={BTN_GHOST}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** [DEFAULT — roads] Road laying and the supply network it produces. A free, un-phase-gated
 *  action, so it lives outside the phase panel — and an explicit armed mode with a visible
 *  cancel, because a hidden shift-click would never be found. */
function RoadPanel({
  state,
  player,
  roadMode,
  roadAnchor,
  connectedCount,
  canAct,
  onArm,
  onCancel,
}: {
  state: GameState;
  player: Player;
  roadMode: boolean;
  roadAnchor: HexCoord | null;
  connectedCount: number;
  canAct: boolean;
  onArm: () => void;
  onCancel: () => void;
}) {
  const isMage = classDefFor(player).startingBonus.kind === 'Mage';
  const cost = isMage ? applyMageDiscount(ROAD_COST) : ROAD_COST;
  const woodNeeded = cost.Wood ?? 0;
  const carried = player.hero.carriedResources.Wood;
  const affordable = player.resources.Wood + carried >= woodNeeded;
  const anyEdgeLeft = roadEndpointOptions(state, player, null).size > 0;

  return (
    <div className={PANEL}>
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="font-display text-sm font-bold text-hx-ink">🛣️ Roads &amp; supply</h3>
          <span className="font-mono text-[10px] uppercase tracking-wide text-hx-ink-faint">free action</span>
        </div>

        <p className="text-[11px] text-hx-ink-dim">
          {connectedCount > 0 ? (
            <>
              <strong className="text-hx-gold">{connectedCount}</strong> tile{connectedCount === 1 ? '' : 's'} joined to your Capital — their
              stockpiles are collected straight into your wallet each round, no hero trip needed.
            </>
          ) : (
            <>No tile is joined to your Capital yet. A chain of your own roads over your own tiles auto-collects everything along it each round.</>
          )}
        </p>

        <p className="font-mono text-[10px] uppercase tracking-wide text-hx-ink-faint">
          {costLabel(cost)} per segment · you hold {player.resources.Wood} Wood{carried > 0 ? ` (+${carried} carried)` : ''}
        </p>

        {!roadMode ? (
          <button
            type="button"
            disabled={!canAct || !affordable || !anyEdgeLeft}
            onClick={onArm}
            className={BTN_SECONDARY}
            title={!affordable ? 'Not enough Wood' : !anyEdgeLeft ? 'Every eligible border already has a road' : undefined}
          >
            🛠️ Lay a road ({costLabel(cost)})
            {!affordable && <span className="text-hx-blood"> — not enough Wood</span>}
            {affordable && !anyEdgeLeft && <span className="text-hx-ink-faint"> — no free borders left</span>}
          </button>
        ) : (
          <div className="flex flex-col gap-2 rounded-sm border border-hx-gold/60 bg-hx-gold/10 p-2">
            <p className="text-[11px] text-hx-ink">
              {roadAnchor ? (
                <>
                  Anchored at <span className="font-mono">({roadAnchor.q},{roadAnchor.r})</span> — click a highlighted neighbour to lay the segment
                  along that border. Click the anchor again to drop it.
                </>
              ) : (
                <>Road mode armed — click a highlighted hex to anchor, then its neighbour. Each segment costs {costLabel(cost)}.</>
              )}
            </p>
            <button type="button" onClick={onCancel} className={BTN_GHOST}>
              ✖ Done laying roads
            </button>
          </div>
        )}
      </div>
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
