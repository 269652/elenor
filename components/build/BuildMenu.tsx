'use client';

import { useState } from 'react';
import {
  BUILDING_DEFINITIONS,
  CAPITAL_TIERS,
  LOOT_SELL_TROOPS,
  Phase,
  ROAD_COST,
  ROAD_MIN_CAPITAL_TIER,
  RESOURCE_TYPES,
  SMITHY_CRAFT_COSTS,
  applyMageDiscount,
  classDefFor,
  edgeKey,
  effectiveTileType,
  hexKey,
  hexNeighbors,
  maxTierFor,
  nextUpgradeFor,
  produceAmountForTier,
  tierOf,
  type Action,
  type BuildingType,
  type GameState,
  type HexCoord,
  type LootRarity,
  type Player,
  type ResourceCost,
} from '@/engine';
import { INPUT, PANEL } from '@/components/uiClasses';

interface BuildMenuProps {
  state: GameState;
  player: Player;
  selectedCoord: HexCoord | null;
  dispatch: (action: Action) => boolean | Promise<boolean>;
  canAct: boolean;
  // [DEFAULT — UI feedback change, direct request: "this should also go in the buildings panel"
  // (re: the Roads & supply panel, which used to be its own standalone sidebar panel)] Road-mode
  // is armed/anchored state that lives in GameBoardApp (it drives the hex board's highlight
  // overlay too, not just this panel), so it's threaded in as props rather than owned here.
  roadMode: boolean;
  roadAnchor: HexCoord | null;
  roadConnectedCount: number;
  onRoadArm: () => void;
  onRoadCancel: () => void;
}

function costLabel(cost: ResourceCost): string {
  return RESOURCE_TYPES.filter((r) => (cost[r] ?? 0) > 0)
    .map((r) => `${cost[r]} ${r}`)
    .join(' + ') || 'free';
}

/** [DEFAULT — roads] Hexes that can serve as an end of a NEW road segment. With an anchor
 *  picked, this narrows to the neighbours that would complete a legal segment; without one it's
 *  every hex that has at least one such segment left in it. Mirrors applyBuildRoad's rules:
 *  both ends placed, at least one end owned by the actor, edge not already carrying a road.
 *
 *  Exported (not GameBoardApp-local) because GameBoardApp's board-highlight logic ALSO needs it
 *  (to show which hexes are legal road endpoints while road mode is armed) — importing it from
 *  here, rather than duplicating it, keeps the two panels' idea of "a legal edge" from drifting
 *  apart. GameBoardApp already imports BuildMenu itself, so this direction avoids a circular
 *  import (BuildMenu never imports back from GameBoardApp). */
export function roadEndpointOptions(state: GameState, player: Player, anchor: HexCoord | null): Set<string> {
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

/** [DEFAULT — direct request: "extra panel with icons for every structure that can be built"]
 *  One glyph per BuildingType, chosen to be visually distinct from the RESOURCE icons already
 *  established elsewhere (ResourceBar's 🪵🪨🌽⛏️🥩🪙) so a building tile never gets mistaken for a
 *  resource readout at a glance, even though a few buildings share a terrain/resource theme. */
const BUILDING_ICON: Record<BuildingType, string> = {
  Sawmill: '🪚',
  HuntingLodge: '🏹',
  Quarry: '🧱',
  Farm: '🚜',
  Windmill: '🎐',
  Mine: '⚒️',
  Smithy: '🛠️',
  TradePost: '🏪',
  Dock: '⚓',
  Watchtower: '🗼',
  Barracks: '🏕️',
  CowStable: '🐄',
  Capital: '🏰',
};

/** Human-readable terrain requirement, for the info modal — mirrors the same allowedTileTypes
 *  union BuildMenu's own candidate filter already reads, just phrased for a sentence instead of
 *  a filter check. */
function terrainLabel(def: (typeof BUILDING_DEFINITIONS)[BuildingType]): string {
  if (def.allowedTileTypes === 'any') return 'Any owned tile';
  if (def.allowedTileTypes === 'starting-tile-only') return 'Starting tile only';
  return def.allowedTileTypes.join(' or ');
}

export function BuildMenu({
  state,
  player,
  selectedCoord,
  dispatch,
  canAct,
  roadMode,
  roadAnchor,
  roadConnectedCount,
  onRoadArm,
  onRoadCancel,
}: BuildMenuProps) {
  const [deployCount, setDeployCount] = useState(1);
  // [DEFAULT — direct request: "a '?' button on the build CTAs which opens a small modal
  // explaining what the building does"] Which structure's info modal is open, if any — a single
  // piece of state is enough since only one can be open at a time.
  const [infoBuilding, setInfoBuilding] = useState<BuildingType | null>(null);
  const isMage = classDefFor(player).startingBonus.kind === 'Mage';
  const tile = selectedCoord ? state.map[hexKey(selectedCoord)] : undefined;
  const ownsTile = tile && tile.ownerId === player.id;

  const hero = player.hero; // v1 simplification: BuildMenu always reasons about the primary hero
  const isLocal = !!selectedCoord && hexKey(selectedCoord) === hexKey(hero.position);

  // [DEFAULT — UI feedback change, direct request: "All building actions should be in an extra
  // panel ... it should also not be at the bottom of sidebar but rather more prominent"] Every
  // action this panel offers (Build, UpgradeBuilding, CraftGear, DeploySoldiers, SellLoot) is a
  // requirePhase(Phase.Build) action in the engine (reducers.ts) — now that this panel stands on
  // its own instead of living inside PhaseActions' already-phase-gated Build case, it has to
  // enforce that itself.
  const isBuildPhase = state.currentPhase === Phase.Build;
  const canBuild = canAct && isBuildPhase;

  /** Mirrors the engine's combinedAfford (engine/reducers.ts): wallet always counts, carried
   *  resources only count when building on the tile the hero is standing on. Purely a UI
   *  preview — the engine re-validates and is the actual source of truth. */
  function canAffordHere(cost: ResourceCost): boolean {
    return RESOURCE_TYPES.every((r) => player.resources[r] + (isLocal ? hero.carriedResources[r] : 0) >= (cost[r] ?? 0));
  }

  const nextCapitalTier = CAPITAL_TIERS[player.capitalTier];
  const isCapitalTile = selectedCoord && hexKey(selectedCoord) === hexKey(player.capitalTile);

  /** [DEFAULT — UI feedback change, direct request: "show all buildable buildings ... render
   *  them disabled if anything can't be built (lvl gate, resources) whatsoever"] Every building
   *  type whose ALLOWED TILE TYPE matches this tile — that's the one filter that stays a hard
   *  exclusion, because a Sawmill can categorically never go on a Mountain tile no matter what
   *  phase or round it is, so listing it there would just be noise, not a "gate" the player is
   *  waiting out. Everything else that used to be a silent filter (round gate, missing
   *  prerequisite building, insufficient resources) is now a per-candidate reason list instead,
   *  so every building the tile could EVER host is visible, with the button disabled and an
   *  explicit "why" the moment it isn't buildable right now. */
  interface BuildCandidate {
    type: BuildingType;
    cost: ResourceCost;
    reasons: string[]; // empty = buildable right now
  }

  const buildCandidates: BuildCandidate[] =
    !tile || !ownsTile || tile.building
      ? []
      : (Object.keys(BUILDING_DEFINITIONS) as BuildingType[])
          .filter((type) => {
            if (type === 'Capital') return false; // handled separately above
            const def = BUILDING_DEFINITIONS[type];
            const effType = effectiveTileType(tile);
            return def.allowedTileTypes === 'any' || (Array.isArray(def.allowedTileTypes) && def.allowedTileTypes.includes(effType));
          })
          .map((type) => {
            const def = BUILDING_DEFINITIONS[type];
            const cost = isMage ? applyMageDiscount(def.cost) : def.cost;
            const reasons: string[] = [];

            if (def.minRound !== undefined && state.roundNumber < def.minRound) {
              reasons.push(`Unlocks round ${def.minRound} (now round ${state.roundNumber})`);
            }
            if (def.requiresBuilding && !player.ownedTiles.some((c) => state.map[hexKey(c)]?.building?.type === def.requiresBuilding)) {
              reasons.push(`Requires a ${def.requiresBuilding} built somewhere first`);
            }
            const missing = RESOURCE_TYPES.filter((r) => (cost[r] ?? 0) > player.resources[r] + (isLocal ? hero.carriedResources[r] : 0));
            if (missing.length > 0) {
              reasons.push(
                `Need ${missing
                  .map((r) => `${(cost[r] ?? 0) - (player.resources[r] + (isLocal ? hero.carriedResources[r] : 0))} more ${r}`)
                  .join(', ')}`
              );
            }

            return { type, cost, reasons };
          })
          // Buildable-right-now first, so the useful options aren't buried below a wall of
          // locked ones; ties keep the catalog's own declaration order.
          .sort((a, b) => Number(a.reasons.length > 0) - Number(b.reasons.length > 0));

  /** Multi-tier buildings (Farm/Quarry run 1→3, CowStable 1→5). Every bit of tier arithmetic
   *  goes through the engine helpers so this panel can never disagree with what
   *  applyUpgradeBuilding will actually charge and grant. `upgradableDef` is only set for
   *  definitions that HAVE tiers above 1 — a Sawmill shouldn't advertise a max-tier badge it
   *  was never eligible for. */
  const buildingOnTile = tile?.building ?? undefined;
  const buildingDef = buildingOnTile && ownsTile ? BUILDING_DEFINITIONS[buildingOnTile.type] : undefined;
  const upgradableDef = buildingDef && maxTierFor(buildingDef) > 1 ? buildingDef : undefined;
  const currentTier = buildingOnTile ? tierOf(buildingOnTile) : 1;
  const nextUpgrade = upgradableDef ? nextUpgradeFor(upgradableDef, currentTier) : null;
  const upgradeCost = nextUpgrade ? (isMage ? applyMageDiscount(nextUpgrade.cost) : nextUpgrade.cost) : undefined;
  const currentProduceAmount = upgradableDef ? produceAmountForTier(upgradableDef, currentTier) : 0;

  const isBarracksTile = !!(buildingOnTile?.type === 'Barracks' && ownsTile);
  const barracksReserve = isBarracksTile ? (tile?.militiaCount ?? 0) : 0;

  // [DEFAULT — balance rework pass 4] CraftGear/SellLoot both require the hero to be physically
  // standing on the tile (same as any action paid carried-first — see the "Paying with..." note
  // above), not just the player owning it, so both are gated on isLocal in addition to the
  // matching building being here.
  const isSmithyTile = !!(buildingOnTile?.type === 'Smithy' && ownsTile && isLocal);
  const RARITIES: LootRarity[] = ['Common', 'Uncommon', 'Rare', 'Legendary'];

  const sellableLoot = isBarracksTile && isLocal ? hero.inventory.filter((c) => !hero.equippedLootIds.includes(c.id)) : [];

  // Road bits — see the props doc comment above for why roadMode/roadAnchor live in GameBoardApp
  // instead of local state.
  const isRoadMage = classDefFor(player).startingBonus.kind === 'Mage';
  const roadCost = isRoadMage ? applyMageDiscount(ROAD_COST) : ROAD_COST;
  // [BUG FIX — direct request: "should be disabled if player doesn't have the resources"] Used to
  // check Wood alone — ROAD_COST gained a Stone leg in balance rework pass 5
  // (engine/constants.ts) and this was never updated to match, so a player with plenty of Wood
  // but no Stone still saw an enabled button the engine would then reject. Mirrors
  // canAffordHere's own across-every-resource check; carried resources count unconditionally
  // (not gated on which endpoint the hero ends up choosing, since that isn't picked yet at this
  // preview stage) — same loose-upper-bound approximation the Wood-only version already used.
  const roadMissing = RESOURCE_TYPES.filter((r) => (roadCost[r] ?? 0) > player.resources[r] + hero.carriedResources[r]);
  const anyRoadEdgeLeft = roadEndpointOptions(state, player, null).size > 0;
  // [BUG FIX — same direct request] The Capital Tier 2 gate (engine/reducers.ts's
  // applyBuildRoad, ROAD_MIN_CAPITAL_TIER) was never reflected here either — the button could
  // show enabled for a Tier 0/1 player right up until the engine rejected the dispatch.
  const roadTierLocked = player.capitalTier < ROAD_MIN_CAPITAL_TIER;
  const roadReasons: string[] = [];
  if (roadTierLocked) roadReasons.push(`Requires Capital Tier ${ROAD_MIN_CAPITAL_TIER} (currently Tier ${player.capitalTier})`);
  if (roadMissing.length > 0) {
    roadReasons.push(
      `Need ${roadMissing.map((r) => `${(roadCost[r] ?? 0) - (player.resources[r] + hero.carriedResources[r])} more ${r}`).join(', ')}`
    );
  }
  if (!anyRoadEdgeLeft) roadReasons.push('No free borders left to road');
  const roadLocked = roadReasons.length > 0;

  const infoDef = infoBuilding ? BUILDING_DEFINITIONS[infoBuilding] : null;
  const infoCost = infoDef ? (isMage ? applyMageDiscount(infoDef.cost) : infoDef.cost) : undefined;

  return (
    <div className={PANEL}>
      {/* [DEFAULT — direct request: "The build actions panel should not be visible outside build
          phase"] GameBoardApp only mounts this component during Phase.Build now, so the
          "locked"/"Build phase only" variant this header and canBuild used to render is gone —
          isBuildPhase stays as a defensive true-when-mounted check, not a visible state. */}
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <h3 className="font-display text-sm font-bold text-hx-ink">🏗️ Build Actions</h3>
        <span className="font-mono text-[10px] uppercase tracking-wide text-hx-ink-faint">Phase 5</span>
      </div>

      {!selectedCoord && <p className="text-xs text-hx-ink-faint">Select a tile you own on the map to build.</p>}

      {selectedCoord && (
        <div className="flex flex-col gap-3">
          <p className="flex items-center gap-1.5 rounded-sm border border-hx-border bg-hx-panel-2 px-2.5 py-1.5 text-[11px] text-hx-ink-dim">
            {isLocal ? (
              <>💰 Paying with carried resources first, wallet for the rest.</>
            ) : (
              <>🏦 Paying from hometown stock only — hero isn&rsquo;t standing here.</>
            )}
          </p>

          {isCapitalTile && nextCapitalTier && (
            <button
              type="button"
              disabled={!canBuild || !canAffordHere(nextCapitalTier.cost)}
              onClick={() => void dispatch({ type: 'Build', actorId: player.id, buildingType: 'Capital', coord: player.capitalTile })}
              className="flex flex-col gap-1 rounded-sm border border-hx-gold bg-hx-gold px-3 py-2.5 text-left shadow-[0_0_16px_-4px_rgba(217,164,65,0.8)] transition hover:bg-hx-gold-bright disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
            >
              <span className="flex items-center justify-between gap-2">
                <span className="font-display text-base font-bold text-hx-bg">🏰 Upgrade Capital</span>
                <span className="font-mono text-[10px] uppercase tracking-wide text-hx-bg/70">Tier {nextCapitalTier.tier}</span>
              </span>
              <span className="text-xs font-medium text-hx-bg/80">{costLabel(isMage ? applyMageDiscount(nextCapitalTier.cost) : nextCapitalTier.cost)}</span>
            </button>
          )}

          {upgradableDef &&
            buildingOnTile &&
            (nextUpgrade && upgradeCost ? (
              <button
                type="button"
                disabled={!canBuild || !canAffordHere(upgradeCost)}
                onClick={() => void dispatch({ type: 'UpgradeBuilding', actorId: player.id, coord: selectedCoord })}
                className="flex flex-col gap-1 rounded-sm border border-hx-gold bg-hx-gold px-3 py-2.5 text-left shadow-[0_0_16px_-4px_rgba(217,164,65,0.8)] transition hover:bg-hx-gold-bright disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-display text-base font-bold text-hx-bg">
                    {BUILDING_ICON[buildingOnTile.type]} Upgrade {buildingOnTile.type}
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-wide text-hx-bg/70">
                    Tier {currentTier} / {maxTierFor(upgradableDef)}
                  </span>
                </span>
                <span className="text-xs font-medium text-hx-bg/80">{costLabel(upgradeCost)}</span>
                <span className="font-mono text-[10px] uppercase tracking-wide text-hx-bg/70">
                  +{currentProduceAmount}/turn → +{nextUpgrade.produceAmount}/turn (tier {currentTier + 1})
                </span>
              </button>
            ) : (
              /* Deliberately a static badge, not a hidden button: a max-tier building that simply
                 stops rendering its upgrade row reads as a bug rather than as "done". */
              <div
                aria-disabled="true"
                className="flex flex-col gap-1 rounded-sm border border-hx-gold/40 bg-hx-gold/10 px-3 py-2.5 text-left"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-display text-sm font-bold text-hx-gold">
                    ✨ {buildingOnTile.type} fully upgraded
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-wide text-hx-gold/80">
                    Tier {currentTier} / {maxTierFor(upgradableDef)}
                  </span>
                </span>
                <span className="text-[11px] text-hx-ink-faint">Max tier reached — producing +{currentProduceAmount}/turn.</span>
              </div>
            ))}

          {isSmithyTile && (
            <div className="flex flex-col gap-2 rounded-sm border border-hx-arcane/40 bg-hx-arcane/10 p-2.5">
              {/* [DEFAULT — direct feedback: "a lot of text doesn't have enough contrast to be
                  readable"] Was text-hx-arcane on bg-hx-arcane/10 — same-hue-on-itself, well
                  under WCAG's 4.5:1 minimum. Border keeps the color cue; text goes to full ink. */}
              <span className="font-mono text-[10px] uppercase tracking-wide text-hx-ink">🛠️ Smithy — Craft Gear</span>
              <div className="grid grid-cols-2 gap-1.5">
                {RARITIES.map((rarity) => {
                  const cost = isMage ? applyMageDiscount(SMITHY_CRAFT_COSTS[rarity]) : SMITHY_CRAFT_COSTS[rarity];
                  return (
                    <button
                      key={rarity}
                      type="button"
                      disabled={!canBuild || !canAffordHere(cost)}
                      onClick={() => void dispatch({ type: 'CraftGear', actorId: player.id, coord: selectedCoord, rarity })}
                      className="flex flex-col gap-0.5 rounded-sm border border-hx-arcane bg-hx-arcane px-2 py-1.5 text-left transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <span className="text-xs font-semibold text-hx-ink">{rarity}</span>
                      <span className="font-mono text-[10px] text-hx-ink">{costLabel(cost)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {isBarracksTile && (
            <div className="flex flex-col gap-2 rounded-sm border border-hx-copper/40 bg-hx-copper/10 p-2.5">
              <span className="font-mono text-[10px] uppercase tracking-wide text-hx-ink">Barracks — Deploy (reserve: {barracksReserve})</span>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={barracksReserve}
                  value={deployCount}
                  onChange={(e) => setDeployCount(Math.max(1, Math.min(barracksReserve || 1, Number(e.target.value))))}
                  disabled={barracksReserve === 0}
                  className={`w-14 ${INPUT}`}
                />
                {/* toCoord defaults to the Barracks tile itself — garrisoning it in place is a
                    legitimate, useful action on its own. Deploying to a different owned tile would
                    need a second tile-picker this component doesn't support yet; could be added
                    later if the app grows one. */}
                <button
                  type="button"
                  disabled={!canBuild || barracksReserve === 0}
                  onClick={() =>
                    void dispatch({
                      type: 'DeploySoldiers',
                      actorId: player.id,
                      fromCoord: selectedCoord,
                      toCoord: selectedCoord,
                      count: Math.min(deployCount, barracksReserve),
                    })
                  }
                  className="flex-1 rounded-sm border border-hx-copper bg-hx-copper px-2 py-1.5 text-left text-xs font-semibold text-hx-ink transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  🛡️ Deploy {Math.min(deployCount, barracksReserve)} to garrison
                </button>
              </div>

              {sellableLoot.length > 0 && (
                <div className="flex flex-col gap-1.5 border-t border-hx-copper/30 pt-2">
                  <span className="font-mono text-[10px] uppercase tracking-wide text-hx-ink">Sell Loot for Soldiers</span>
                  <div className="flex flex-col gap-1">
                    {sellableLoot.map((card) => (
                      <button
                        key={card.id}
                        type="button"
                        disabled={!canBuild}
                        onClick={() => void dispatch({ type: 'SellLoot', actorId: player.id, lootCardId: card.id, coord: selectedCoord })}
                        className="flex items-center justify-between gap-2 rounded-sm border border-hx-copper bg-hx-copper/80 px-2 py-1 text-left transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <span className="truncate text-[11px] text-hx-ink">
                          {card.name} <span className="text-hx-ink-dim">({card.rarity})</span>
                        </span>
                        <span className="shrink-0 font-mono text-[10px] text-hx-ink">+{LOOT_SELL_TROOPS[card.rarity]} 🪖</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {buildCandidates.length === 0 && !isCapitalTile && !upgradableDef && (
            <p className="text-xs text-hx-ink-faint">
              {tile?.building
                ? `A ${tile.building.type} already occupies this tile — one building per tile.`
                : !tile || !ownsTile
                  ? 'Select an owned tile to see what can be built there.'
                  : 'Nothing can ever be built on this tile type.'}
            </p>
          )}

          {/* [DEFAULT — direct request: "extra panel with icons for every structure that can be
              built"] Icon-grid palette instead of a single-column text list — each structure gets
              a large glyph up top so the whole set reads at a glance, with name/cost/lock-reason
              underneath. Each tile also carries a "?" info button (direct request: "a '?' button
              on the build CTAs which opens a small modal explaining what the building does") —
              a separate nested button, not the tile's own title tooltip, since a tooltip alone
              isn't reachable on touch and the ask was specifically for a modal.
              [DEFAULT — direct request: "Lay roads should not be an extra panel.. just an icon
              button like the other buildings"] Road is appended as one more tile in this SAME
              grid instead of its own bordered "Roads & supply" section below — it isn't a real
              BuildingType (it doesn't occupy the selected tile's building slot, or even
              necessarily target the selected tile at all — see roadEndpointOptions), so it's a
              synthetic entry rather than one more member of buildCandidates, but it gets the
              identical card treatment: icon, cost, and a locked-reason list built from the exact
              same checks (resources across every ROAD_COST resource, not just Wood; the Capital
              Tier gate; whether any legal edge is even left) applyBuildRoad itself enforces. The
              grid always renders now (used to be gated on buildCandidates.length, back when Road
              lived in its own separate section) since Road guarantees at least one tile. */}
          <div className="grid grid-cols-2 gap-2">
            {buildCandidates.map(({ type, cost, reasons }) => {
              const locked = reasons.length > 0;
              return (
                <div key={type} className="relative">
                  <button
                    type="button"
                    disabled={!canBuild || locked}
                    title={locked ? reasons.join(' · ') : undefined}
                    onClick={() => void dispatch({ type: 'Build', actorId: player.id, buildingType: type, coord: selectedCoord })}
                    className="flex w-full flex-col items-center gap-1 rounded-sm border border-hx-border bg-hx-panel-2 p-2.5 text-center transition hover:border-hx-gold/50 hover:bg-hx-panel disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <span className="text-2xl leading-none" aria-hidden="true">
                      {BUILDING_ICON[type]}
                    </span>
                    <span className="flex items-center gap-1 text-xs font-semibold text-hx-ink">
                      {locked && <span aria-hidden="true">🔒</span>}
                      {type}
                    </span>
                    <span className="font-mono text-[10px] text-hx-ink-dim">{costLabel(cost)}</span>
                    {/* [DEFAULT — direct feedback: "a lot of text doesn't have enough contrast
                        to be readable"] Was text-hx-copper on this tile's neutral dark
                        bg-hx-panel-2 — copper alone (not tinted) still measured well under
                        WCAG's 4.5:1 here, and disabled:opacity-40 above only made it worse. */}
                    {locked && <span className="text-[10px] font-semibold text-hx-gold-bright">{reasons.join(' · ')}</span>}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setInfoBuilding(type);
                    }}
                    title={`What does ${type} do?`}
                    aria-label={`What does ${type} do?`}
                    className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full border border-hx-border-strong bg-hx-panel text-[10px] font-bold text-hx-ink-dim transition hover:border-hx-gold hover:text-hx-gold"
                  >
                    ?
                  </button>
                </div>
              );
            })}

            <button
              type="button"
              disabled={!canBuild || roadMode || roadLocked}
              title={roadLocked ? roadReasons.join(' · ') : roadConnectedCount > 0 ? `${roadConnectedCount} tile(s) already road-connected` : undefined}
              onClick={onRoadArm}
              className="flex w-full flex-col items-center gap-1 rounded-sm border border-hx-border bg-hx-panel-2 p-2.5 text-center transition hover:border-hx-gold/50 hover:bg-hx-panel disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span className="text-2xl leading-none" aria-hidden="true">
                🛣️
              </span>
              <span className="flex items-center gap-1 text-xs font-semibold text-hx-ink">
                {roadLocked && <span aria-hidden="true">🔒</span>}
                Road
              </span>
              <span className="font-mono text-[10px] text-hx-ink-dim">{costLabel(roadCost)}</span>
              {roadLocked && <span className="text-[10px] font-semibold text-hx-gold-bright">{roadReasons.join(' · ')}</span>}
              {!roadLocked && roadConnectedCount > 0 && (
                <span className="text-[10px] text-hx-moss">{roadConnectedCount} connected</span>
              )}
            </button>
          </div>

          {/* [DEFAULT — direct request: "Lay roads should not be an extra panel"] Only appears
              once road mode is actually armed — this is live in-progress interaction feedback
              (which hex is anchored, how to cancel), not a standing panel duplicating what the
              grid tile above already says. */}
          {roadMode && (
            <div className="flex items-center justify-between gap-2 rounded-sm border border-hx-gold/60 bg-hx-gold/10 px-2.5 py-1.5">
              <p className="text-[11px] text-hx-ink">
                {roadAnchor ? (
                  <>
                    Anchored at <span className="font-mono">({roadAnchor.q},{roadAnchor.r})</span> — click a highlighted neighbour to complete
                    the segment.
                  </>
                ) : (
                  <>Click a highlighted hex to anchor a road.</>
                )}
              </p>
              <button type="button" onClick={onRoadCancel} className="shrink-0 font-mono text-[10px] font-semibold text-hx-ink-faint transition hover:text-hx-blood">
                ✖ Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {/* [DEFAULT — direct request: "a '?' button on the build CTAs which opens a small modal
          explaining what the building does"] A minimal, self-contained modal — dismissed by the
          backdrop, the ✖ button, or picking a different building's "?". */}
      {infoDef && infoCost && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close"
            onClick={() => setInfoBuilding(null)}
            className="absolute inset-0 cursor-pointer bg-hx-bg/70 backdrop-blur-[1px]"
          />
          <div className="relative z-10 flex w-full max-w-xs flex-col gap-2 rounded-sm border border-hx-gold/60 bg-hx-panel p-4 shadow-[0_8px_28px_-6px_rgba(0,0,0,0.8)]">
            <div className="flex items-start justify-between gap-2">
              <span className="flex items-center gap-2">
                <span className="text-2xl" aria-hidden="true">
                  {BUILDING_ICON[infoBuilding!]}
                </span>
                <span className="font-display text-base font-bold text-hx-ink">{infoBuilding}</span>
              </span>
              <button
                type="button"
                onClick={() => setInfoBuilding(null)}
                aria-label="Close"
                className="shrink-0 text-hx-ink-faint transition hover:text-hx-ink"
              >
                ✖
              </button>
            </div>
            <p className="text-xs text-hx-ink-dim">{infoDef.effectDescription}</p>
            <div className="flex flex-col gap-1 border-t border-hx-border pt-2 font-mono text-[11px] text-hx-ink-faint">
              <span>
                💰 Cost: <span className="text-hx-ink-dim">{costLabel(infoCost)}</span>
              </span>
              <span>
                🗺️ Terrain: <span className="text-hx-ink-dim">{terrainLabel(infoDef)}</span>
              </span>
              {infoDef.minRound !== undefined && (
                <span>
                  🔓 Unlocks: <span className="text-hx-ink-dim">round {infoDef.minRound}+</span>
                </span>
              )}
              {infoDef.requiresBuilding && (
                <span>
                  🏗️ Requires: <span className="text-hx-ink-dim">{infoDef.requiresBuilding} built somewhere first</span>
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
