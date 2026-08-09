'use client';

import { useState } from 'react';
import {
  BUILDING_DEFINITIONS,
  CAPITAL_TIERS,
  RESOURCE_TYPES,
  applyMageDiscount,
  classDefFor,
  computeAllVictoryPoints,
  effectiveTileType,
  hexKey,
  maxTierFor,
  nextUpgradeFor,
  produceAmountForTier,
  tierOf,
  type Action,
  type BuildingType,
  type GameState,
  type HexCoord,
  type Player,
  type ResourceCost,
} from '@/engine';
import { BTN_SECONDARY, INPUT } from '@/components/uiClasses';

interface BuildMenuProps {
  state: GameState;
  player: Player;
  selectedCoord: HexCoord | null;
  dispatch: (action: Action) => boolean | Promise<boolean>;
  canAct: boolean;
}

function costLabel(cost: ResourceCost): string {
  return RESOURCE_TYPES.filter((r) => (cost[r] ?? 0) > 0)
    .map((r) => `${cost[r]} ${r}`)
    .join(' + ') || 'free';
}

export function BuildMenu({ state, player, selectedCoord, dispatch, canAct }: BuildMenuProps) {
  const [deployCount, setDeployCount] = useState(1);
  const isMage = classDefFor(player).startingBonus.kind === 'Mage';
  const tile = selectedCoord ? state.map[hexKey(selectedCoord)] : undefined;
  const ownsTile = tile && tile.ownerId === player.id;

  const hero = player.hero; // v1 simplification: BuildMenu always reasons about the primary hero
  const isLocal = !!selectedCoord && hexKey(selectedCoord) === hexKey(hero.position);

  /** Mirrors the engine's combinedAfford (engine/reducers.ts): wallet always counts, carried
   *  resources only count when building on the tile the hero is standing on. Purely a UI
   *  preview — the engine re-validates and is the actual source of truth. */
  function canAffordHere(cost: ResourceCost): boolean {
    return RESOURCE_TYPES.every((r) => player.resources[r] + (isLocal ? hero.carriedResources[r] : 0) >= (cost[r] ?? 0));
  }

  const nextCapitalTier = CAPITAL_TIERS[player.capitalTier];
  const isCapitalTile = selectedCoord && hexKey(selectedCoord) === hexKey(player.capitalTile);

  const buildableTypes = (Object.keys(BUILDING_DEFINITIONS) as BuildingType[]).filter((type) => {
    if (type === 'Capital') return false; // handled separately below
    const def = BUILDING_DEFINITIONS[type];
    if (!tile || !ownsTile || tile.building) return false;
    const effType = effectiveTileType(tile);
    const allowed = def.allowedTileTypes === 'any' || (Array.isArray(def.allowedTileTypes) && def.allowedTileTypes.includes(effType));
    if (!allowed) return false;
    if (def.requiresBuilding && !player.ownedTiles.some((c) => state.map[hexKey(c)]?.building?.type === def.requiresBuilding)) return false;
    if (def.minRound !== undefined && state.roundNumber < def.minRound) return false;
    return true;
  });

  /** Same eligibility as buildableTypes but specifically the ones held back only by
   *  minRound — surfaced below so players understand why, e.g., Farm is missing rather than
   *  assuming a bug. Sorted by unlock round so the compact list reads as a schedule.
   *  [DEFAULT — balance rework] Now that nearly every producer is round-gated, this list can
   *  hold as many entries as the buildable list does on an early-round tile, so it renders as
   *  a single condensed "coming later" block rather than a stack of full-height rows. */
  const roundGatedTypes = (Object.keys(BUILDING_DEFINITIONS) as BuildingType[])
    .filter((type) => {
      if (type === 'Capital') return false;
      const def = BUILDING_DEFINITIONS[type];
      if (!tile || !ownsTile || tile.building) return false;
      if (def.minRound === undefined || state.roundNumber >= def.minRound) return false;
      const effType = effectiveTileType(tile);
      const allowed = def.allowedTileTypes === 'any' || (Array.isArray(def.allowedTileTypes) && def.allowedTileTypes.includes(effType));
      if (!allowed) return false;
      if (def.requiresBuilding && !player.ownedTiles.some((c) => state.map[hexKey(c)]?.building?.type === def.requiresBuilding)) return false;
      return true;
    })
    .sort((a, b) => (BUILDING_DEFINITIONS[a].minRound ?? 0) - (BUILDING_DEFINITIONS[b].minRound ?? 0));

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

  if (!selectedCoord) {
    return <p className="text-xs text-hx-ink-faint">Select a tile you own on the map to build.</p>;
  }

  return (
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
          disabled={
            !canAct ||
            !canAffordHere(nextCapitalTier.cost) ||
            ('requiresVp' in nextCapitalTier && computeAllVictoryPoints(state, player) < nextCapitalTier.requiresVp)
          }
          onClick={() => void dispatch({ type: 'Build', actorId: player.id, buildingType: 'Capital', coord: player.capitalTile })}
          className="flex flex-col gap-1 rounded-sm border border-hx-gold bg-hx-gold px-3 py-2.5 text-left shadow-[0_0_16px_-4px_rgba(217,164,65,0.8)] transition hover:bg-hx-gold-bright disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
        >
          <span className="flex items-center justify-between gap-2">
            <span className="font-display text-base font-bold text-hx-bg">🏰 Upgrade Capital</span>
            <span className="font-mono text-[10px] uppercase tracking-wide text-hx-bg/70">Tier {nextCapitalTier.tier}</span>
          </span>
          <span className="text-xs font-medium text-hx-bg/80">{costLabel(isMage ? applyMageDiscount(nextCapitalTier.cost) : nextCapitalTier.cost)}</span>
          {'requiresVp' in nextCapitalTier && (
            <span className="font-mono text-[10px] uppercase tracking-wide text-hx-bg/70">Requires ≥{nextCapitalTier.requiresVp} VP</span>
          )}
        </button>
      )}

      {upgradableDef &&
        buildingOnTile &&
        (nextUpgrade && upgradeCost ? (
          <button
            type="button"
            disabled={!canAct || !canAffordHere(upgradeCost)}
            onClick={() => void dispatch({ type: 'UpgradeBuilding', actorId: player.id, coord: selectedCoord })}
            className="flex flex-col gap-1 rounded-sm border border-hx-gold bg-hx-gold px-3 py-2.5 text-left shadow-[0_0_16px_-4px_rgba(217,164,65,0.8)] transition hover:bg-hx-gold-bright disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
          >
            <span className="flex items-center justify-between gap-2">
              <span className="font-display text-base font-bold text-hx-bg">⬆️ Upgrade {buildingOnTile.type}</span>
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
              <span className="font-display text-sm font-bold text-hx-gold">✨ {buildingOnTile.type} fully upgraded</span>
              <span className="font-mono text-[10px] uppercase tracking-wide text-hx-gold/80">
                Tier {currentTier} / {maxTierFor(upgradableDef)}
              </span>
            </span>
            <span className="text-[11px] text-hx-ink-faint">Max tier reached — producing +{currentProduceAmount}/turn.</span>
          </div>
        ))}

      {isBarracksTile && (
        <div className="flex flex-col gap-2 rounded-sm border border-hx-copper/40 bg-hx-copper/10 p-2.5">
          <span className="font-mono text-[10px] uppercase tracking-wide text-hx-copper">Barracks — Deploy (reserve: {barracksReserve})</span>
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
              disabled={!canAct || barracksReserve === 0}
              onClick={() =>
                void dispatch({
                  type: 'DeploySoldiers',
                  actorId: player.id,
                  fromCoord: selectedCoord,
                  toCoord: selectedCoord,
                  count: Math.min(deployCount, barracksReserve),
                })
              }
              className="flex-1 rounded-sm border border-hx-copper/70 bg-hx-copper/20 px-2 py-1.5 text-left text-xs font-semibold text-hx-ink transition hover:bg-hx-copper/35 disabled:cursor-not-allowed disabled:opacity-40"
            >
              🛡️ Deploy {Math.min(deployCount, barracksReserve)} to garrison
            </button>
          </div>
        </div>
      )}

      {buildableTypes.length === 0 && !isCapitalTile && <p className="text-xs text-hx-ink-faint">Nothing buildable here right now.</p>}

      {buildableTypes.length > 0 && (
        <div className="flex flex-col gap-2">
          {buildableTypes.map((type) => {
            const def = BUILDING_DEFINITIONS[type];
            const cost = isMage ? applyMageDiscount(def.cost) : def.cost;
            return (
              <button
                key={type}
                type="button"
                disabled={!canAct || !canAffordHere(cost)}
                onClick={() => void dispatch({ type: 'Build', actorId: player.id, buildingType: type, coord: selectedCoord })}
                className={`${BTN_SECONDARY} flex flex-col gap-1`}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold text-hx-ink">{type}</span>
                  <span className="font-mono text-[11px] text-hx-ink-dim">{costLabel(cost)}</span>
                </span>
                <span className="text-[11px] text-hx-ink-faint">{def.effectDescription}</span>
              </button>
            );
          })}
        </div>
      )}

      {roundGatedTypes.length > 0 && (
        /* One condensed block instead of N full-height disabled buttons. With almost every
           producer now round-gated, the old one-row-per-building treatment made round-1 tiles
           read as mostly-locked walls that out-weighed the things you can actually do. This
           keeps the same "here's why it's missing" answer — name, unlock round, price, current
           round — at roughly a sixth of the height, with the full effect text on hover/title
           for anyone planning ahead. */
        <div className="flex flex-col gap-1.5 rounded-sm border border-hx-border bg-hx-panel-2/60 px-2.5 py-2">
          <span className="font-mono text-[10px] uppercase tracking-wide text-hx-ink-faint">
            🔒 Unlocks here later — round {state.roundNumber} now
          </span>
          <ul className="flex flex-col gap-1">
            {roundGatedTypes.map((type) => {
              const def = BUILDING_DEFINITIONS[type];
              return (
                <li key={type} title={def.effectDescription} className="flex items-baseline justify-between gap-2 text-[11px]">
                  <span className="text-hx-ink-dim">
                    <span className="font-mono text-hx-ink-faint">R{def.minRound}</span> {type}
                  </span>
                  <span className="font-mono text-[10px] text-hx-ink-faint">{costLabel(def.cost)}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
