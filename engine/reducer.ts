/** The public `Reducer`: one `(state, action) => state` entry point, dispatching to the
 *  per-phase implementations in reducers.ts. This is the only function server/client
 *  transports call — see docs/architecture.md §3 "One Engine, Three Modes." */

import {
  applyAdvancePhase,
  applyBuild,
  applyBuildRoad,
  applyCraftGear,
  applySellLoot,
  applyDeploySoldiers,
  applyMoveSoldiers,
  applyDepositResources,
  applyDrawTile,
  applyEndTurn,
  applyEquipLoot,
  applyFight,
  applyGather,
  applyLevelUpHero,
  applyMoveHero,
  applyPlaceTile,
  applyTradeWithBank,
  applyUnequipLoot,
  applyUpgradeBuilding,
} from './reducers';
import type { Action, GameState } from './types';

export function applyAction(state: GameState, action: Action): GameState {
  switch (action.type) {
    case 'DrawTile':
      return applyDrawTile(state, action);
    case 'PlaceTile':
      return applyPlaceTile(state, action);
    case 'MoveHero':
      return applyMoveHero(state, action);
    case 'Gather':
      return applyGather(state, action);
    case 'Fight':
      return applyFight(state, action);
    case 'Build':
      return applyBuild(state, action);
    case 'DeploySoldiers':
      return applyDeploySoldiers(state, action);
    case 'MoveSoldiers':
      return applyMoveSoldiers(state, action);
    case 'UpgradeBuilding':
      return applyUpgradeBuilding(state, action);
    case 'BuildRoad':
      return applyBuildRoad(state, action);
    case 'CraftGear':
      return applyCraftGear(state, action);
    case 'SellLoot':
      return applySellLoot(state, action);
    case 'LevelUpHero':
      return applyLevelUpHero(state, action);
    case 'EquipLoot':
      return applyEquipLoot(state, action);
    case 'UnequipLoot':
      return applyUnequipLoot(state, action);
    case 'TradeWithBank':
      return applyTradeWithBank(state, action);
    case 'DepositResources':
      return applyDepositResources(state, action);
    case 'AdvancePhase':
      return applyAdvancePhase(state, action);
    case 'EndTurn':
      return applyEndTurn(state, action);
    default: {
      const exhaustive: never = action;
      throw new Error(`Unknown action type: ${JSON.stringify(exhaustive)}`);
    }
  }
}
