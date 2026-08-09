import clsx from 'clsx';
import { RESOURCE_TYPES, carryCapacityFor, gearBonus, hexKey, totalCarried, GEAR_SLOT_COUNT, type Action, type HeroState, type Player, type LootCard } from '@/engine';
import { RESOURCE_COLOR, RESOURCE_ICON } from '@/components/board/tileTheme';
import { BTN_PILL, BTN_PRIMARY, PANEL } from '@/components/uiClasses';

interface HeroPanelProps {
  player: Player;
  hero: HeroState;
  dispatch: (action: Action) => boolean | Promise<boolean>;
  canAct: boolean;
}

const RARITY_COLOR: Record<LootCard['rarity'], string> = {
  Common: 'text-hx-ink-dim',
  Uncommon: 'text-hx-moss',
  Rare: 'text-hx-arcane',
  Legendary: 'text-hx-gold-bright',
};

export function HeroPanel({ player, hero, dispatch, canAct }: HeroPanelProps) {
  const hpPct = Math.max(0, Math.min(100, (hero.hp / hero.maxHp) * 100));
  const bonus = gearBonus(hero);
  const capacity = carryCapacityFor(hero);
  const carried = totalCarried(hero);
  const atCapital = hexKey(hero.position) === hexKey(player.capitalTile);

  return (
    <div className={clsx(PANEL, 'flex flex-col gap-3')}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-display text-lg font-bold leading-tight" style={{ color: player.color }}>
          {player.name}&rsquo;s Hero {hero.isSecondHero ? '(2nd)' : ''}
        </span>
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-hx-gold bg-gradient-to-b from-hx-gold-bright to-hx-gold font-display text-xs font-bold text-hx-bg shadow-[0_0_8px_-1px_rgba(217,164,65,0.8)]">
          {hero.level}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between font-mono text-[10px] uppercase tracking-wide text-hx-ink-faint">
          <span>
            HP <span className="text-hx-ink">{hero.hp}</span>/{hero.maxHp}
          </span>
          <span>
            Attack {hero.attack} (+{bonus} gear) · XP {hero.xp}/{hero.level < 10 ? hero.level * 3 : '—'}
          </span>
        </div>
        <div className="h-2.5 w-full overflow-hidden rounded-sm border border-hx-border bg-hx-bg">
          <div
            className="h-full bg-hx-blood shadow-[0_0_6px_0_rgba(178,58,58,0.7)] motion-safe:transition-[width] motion-safe:duration-500 motion-safe:ease-out"
            style={{ width: `${hpPct}%` }}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-wide text-hx-ink-faint">
          <span>
            🎒 Carrying ({carried}/{capacity})
          </span>
          {carried > 0 && atCapital && (
            <button
              type="button"
              disabled={!canAct}
              onClick={() => void dispatch({ type: 'DepositResources', actorId: player.id, heroId: hero.isSecondHero ? hero.id : undefined })}
              className={BTN_PILL}
            >
              🏠 Deposit at Capital
            </button>
          )}
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-sm border border-hx-border bg-hx-bg">
          <div
            className="h-full bg-hx-gold motion-safe:transition-[width] motion-safe:duration-500 motion-safe:ease-out"
            style={{ width: `${capacity > 0 ? (carried / capacity) * 100 : 0}%` }}
          />
        </div>
        {carried > 0 && (
          <div className="mt-0.5 flex flex-wrap gap-2">
            {RESOURCE_TYPES.filter((r) => hero.carriedResources[r] > 0).map((r) => (
              <span key={r} className="text-[10px]" style={{ color: RESOURCE_COLOR[r] }}>
                {RESOURCE_ICON[r]} {hero.carriedResources[r]}
              </span>
            ))}
          </div>
        )}
        {carried > 0 && !atCapital && (
          <p className="mt-0.5 text-[10px] text-hx-ink-faint">Usable to build right here, or carry it home to bank it.</p>
        )}
      </div>

      {hero.pendingLevelUp && (
        <button
          type="button"
          disabled={!canAct}
          onClick={() => void dispatch({ type: 'LevelUpHero', actorId: player.id, heroId: hero.isSecondHero ? hero.id : undefined })}
          className={clsx(BTN_PRIMARY, 'text-center')}
        >
          ⭐ Apply Level Up (costs 1 Food + 1 Gold)
        </button>
      )}

      {hero.activeCurses.length > 0 && (
        <div className="flex items-start gap-1.5 rounded-sm border border-hx-arcane/60 bg-hx-arcane/10 px-2 py-1.5 text-xs text-hx-arcane shadow-[0_0_10px_-4px_rgba(140,108,208,0.8)]">
          <span aria-hidden="true">💀</span>
          <span>Cursed: {hero.activeCurses.map((c) => c.name).join(', ')}</span>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <div className="font-mono text-[10px] uppercase tracking-wide text-hx-ink-faint">
          Gear ({hero.equippedLootIds.length}/{GEAR_SLOT_COUNT})
        </div>
        <ul className="flex flex-col gap-1">
          {hero.inventory.length === 0 && <li className="text-xs text-hx-ink-faint">No loot yet.</li>}
          {hero.inventory.map((loot) => {
            const equipped = hero.equippedLootIds.includes(loot.id);
            return (
              <li
                key={loot.id}
                className={clsx(
                  'flex items-center justify-between gap-2 rounded-sm border px-2 py-1 text-xs',
                  equipped ? 'border-hx-gold/50 bg-hx-panel-2' : 'border-hx-border bg-hx-panel-2/60'
                )}
              >
                <span className="truncate">
                  <span className={clsx('font-semibold', RARITY_COLOR[loot.rarity])}>{loot.name}</span>{' '}
                  <span className="text-hx-ink-faint">
                    ({loot.rarity} +{loot.combatBonus})
                  </span>
                </span>
                <button
                  type="button"
                  disabled={!canAct}
                  onClick={() =>
                    void dispatch(
                      equipped
                        ? { type: 'UnequipLoot', actorId: player.id, lootCardId: loot.id, heroId: hero.isSecondHero ? hero.id : undefined }
                        : { type: 'EquipLoot', actorId: player.id, lootCardId: loot.id, heroId: hero.isSecondHero ? hero.id : undefined }
                    )
                  }
                  className={BTN_PILL}
                >
                  {equipped ? 'Unequip' : 'Equip'}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
