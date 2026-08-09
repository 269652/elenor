'use client';

import { useState } from 'react';
import { RESOURCE_TYPES, type Action, type Player, type ResourceType } from '@/engine';
import { BTN_SECONDARY, PANEL } from '@/components/uiClasses';

const SELECT_CLASS = 'rounded-sm border border-hx-border bg-hx-bg px-1.5 py-1 text-xs text-hx-ink';

export function TradePanel({ player, dispatch, canAct }: { player: Player; dispatch: (a: Action) => boolean | Promise<boolean>; canAct: boolean }) {
  const [give, setGive] = useState<ResourceType>('Wood');
  const [receive, setReceive] = useState<ResourceType>('Gold');
  const ratio = player.bankTradeRatio;
  const canAfford = player.resources[give] >= ratio[0];

  return (
    <div className={`${PANEL} flex flex-col gap-1.5`}>
      <span className="font-mono text-[10px] uppercase tracking-wide text-hx-ink-faint">
        🏦 Bank Trade ({ratio[0]}:{ratio[1]})
      </span>
      <div className="flex items-center gap-1.5 text-xs">
        <select value={give} onChange={(e) => setGive(e.target.value as ResourceType)} className={SELECT_CLASS}>
          {RESOURCE_TYPES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <span className="text-hx-ink-faint">→</span>
        <select value={receive} onChange={(e) => setReceive(e.target.value as ResourceType)} className={SELECT_CLASS}>
          {RESOURCE_TYPES.filter((r) => r !== give).map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!canAct || !canAfford}
          onClick={() => void dispatch({ type: 'TradeWithBank', actorId: player.id, give, giveAmount: ratio[0], receive })}
          className={`${BTN_SECONDARY} ml-auto`}
        >
          Trade {ratio[0]}→{ratio[1]}
        </button>
      </div>
    </div>
  );
}
