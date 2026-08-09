/**
 * Flavor catalogs for Monster / Loot / Bad Stuff cards. The mechanical numbers (level ->
 * threshold, rarity -> combat bonus) are canon/DEFAULT constants in constants.ts; this file is
 * just "what's actually printed on the cards." IDs are stable strings (not generated at
 * runtime) so a card is identifiable across a reshuffle.
 *
 * Monster deck level distribution is a [DEFAULT] gap the rules reference didn't cover at all —
 * skewed toward low levels so early dungeon-diving is survivable and Legendary-tier threats
 * are rare, mirroring how the loot rarity brackets already scale (docs/rules-reference.md §6.1).
 */

import { lootRarityForMonsterLevel } from './constants';
import type { BadStuffCard, DoorCard, LootCard, LootRarity, MonsterCard, UtilityCard, UtilityEffectKind } from './types';

interface MonsterTemplate {
  name: string;
  level: number;
  specialAbility?: string;
  count: number; // how many copies go in the deck
}

const MONSTER_TEMPLATES: MonsterTemplate[] = [
  { name: 'Bramble Rat', level: 1, count: 3 },
  { name: 'Squabbling Goblin', level: 1, specialAbility: 'Steals 1 Wood if it wins.', count: 2 },
  { name: 'Cave Slime', level: 2, count: 3 },
  { name: 'Ruin Jackal', level: 2, specialAbility: 'Hunts in pairs — no mechanical effect, just menacing.', count: 2 },
  { name: 'Moss Troll', level: 3, count: 2 },
  { name: 'Bog Hag', level: 3, specialAbility: 'Draw a Bad Stuff even on a win.', count: 1 },
  { name: 'Iron-Plated Boar', level: 4, count: 2 },
  { name: 'Wailing Specter', level: 4, specialAbility: 'Ignore Loot combat bonus for this fight.', count: 1 },
  { name: 'Ashfang Wolf', level: 5, count: 2 },
  { name: 'Crypt Warden', level: 5, specialAbility: 'Hero takes +2 extra HP damage on a loss.', count: 1 },
  { name: 'Stoneback Chimera', level: 6, count: 2 },
  { name: 'Marsh Wyrmling', level: 6, specialAbility: 'On win, draw 2 Loot cards instead of 1.', count: 1 },
  { name: 'Barrow King', level: 7, count: 1 },
  { name: 'Frost Revenant', level: 7, specialAbility: 'On loss, hero also loses its next Move phase.', count: 1 },
  { name: 'Obsidian Drake', level: 8, count: 1 },
  { name: 'The Hollow Knight', level: 9, specialAbility: 'On win, all rivals see it in the event log immediately.', count: 1 },
  { name: 'The Devourer Below', level: 10, specialAbility: 'The deck\'s apex predator.', count: 1 },
  // [DEFAULT — Munchkin exploration layer] This same roster now also stocks the Door deck's
  // monster half (see buildDoorCatalog below) alongside its original Ruins-Den job, so the
  // target size grew from "enough Ruins encounters" to "enough that the Door deck doesn't feel
  // repetitive too" — starter batch here, filled out toward ~40 templates separately.
  { name: 'Thistle Sprite', level: 1, specialAbility: 'Harmless-looking. Mostly.', count: 2 },
  { name: 'Muck Crawler', level: 2, count: 2 },
  { name: 'Highwayman\'s Ghost', level: 3, specialAbility: 'Steals 1 Gold if it wins.', count: 1 },
  { name: 'Quarry Golem', level: 4, count: 1 },
  { name: 'Sable Lynx', level: 5, count: 1 },
  { name: 'Rootbound Ent', level: 6, specialAbility: 'Immune to Loot combat bonus from bladed weapons — flavor only.', count: 1 },
  { name: 'Chained Wraith', level: 7, specialAbility: 'On win, hero also gains 1 extra XP.', count: 1 },
  { name: 'Brackish Leviathan', level: 8, count: 1 },
  // [DEFAULT — Munchkin exploration layer, pass 2] Second expansion batch, bringing the total to
  // ~40 unique templates as scoped in the task. Same level-distribution shape as before (flat
  // density across 1-6, thinning out 7-10) and the same flavor-only specialAbility convention —
  // grep engine/reducers.ts's applyFightMonster for confirmation nothing here is mechanically
  // hooked up; a card that reads as mechanical (e.g. "discards 1 carried resource") is exactly as
  // inert as one that says so outright, matching the existing roster's mix of both styles.
  { name: 'Ditch Weasel', level: 1, count: 2 },
  { name: 'Molting Grub', level: 1, count: 2 },
  { name: 'Tanglevine Serpent', level: 2, count: 2 },
  { name: 'Rot-Tusked Boar', level: 2, count: 2 },
  { name: 'Gravel Wisp', level: 3, count: 1 },
  { name: 'Sump Leech', level: 3, specialAbility: 'Drains a little resolve on the way down — no mechanical effect.', count: 1 },
  { name: 'Bramblehorn Stag', level: 4, count: 1 },
  { name: 'Cinderback Adder', level: 4, specialAbility: 'On win, hero also takes 1 HP of scorch damage.', count: 1 },
  { name: 'Hollow Reaver', level: 5, count: 1 },
  { name: 'Tideclaw Crab', level: 5, count: 1 },
  { name: 'Charnel Owl', level: 6, specialAbility: 'Screeches before it strikes — purely for atmosphere.', count: 1 },
  { name: 'Deepfen Hydra', level: 6, count: 1 },
  { name: 'Gallows Knight', level: 7, specialAbility: 'On loss, hero discards 1 carried resource of their choice.', count: 1 },
  { name: 'Ashmaw Serpent', level: 8, count: 1 },
  { name: 'The Weeping Colossus', level: 9, specialAbility: 'Its grief has outlasted every kingdom that made it.', count: 1 },
];

export function buildMonsterCatalog(): MonsterCard[] {
  const cards: MonsterCard[] = [];
  for (const t of MONSTER_TEMPLATES) {
    for (let i = 0; i < t.count; i++) {
      cards.push({
        id: `monster-${t.name.toLowerCase().replace(/\s+/g, '-')}-${i}`,
        name: t.name,
        level: t.level,
        specialAbility: t.specialAbility,
        lootRarityOnWin: lootRarityForMonsterLevel(t.level),
      });
    }
  }
  return cards;
}

/** Monster IDs are stable/deterministic (unlike shuffled deck order), so a defeated-or-not
 *  card can always be looked up by id straight from the static catalog — reducers don't need
 *  to hunt through drawPile/discardPile to find the full MonsterCard behind a
 *  Tile.monsterDenCardId. Built once and memoized. */
let monsterCatalogById: Map<string, MonsterCard> | null = null;
export function getMonsterById(id: string): MonsterCard {
  if (!monsterCatalogById) {
    monsterCatalogById = new Map(buildMonsterCatalog().map((m) => [m.id, m]));
  }
  const card = monsterCatalogById.get(id);
  if (!card) throw new Error(`Unknown monster id: ${id}`);
  return card;
}

interface LootTemplate {
  name: string;
  specialAbility?: string;
  movementBonus?: number;
}

/** [DEFAULT — balance rework pass 2] Roughly doubled in size. A drawn Loot card is kept by its
 *  hero permanently — nothing ever returns it to a discard pile — so every rarity here is a hard
 *  finite budget for the whole game, not a cycling deck. The original 17 cards across all four
 *  rarities were sized for a game where, as it turned out, the AI never actually reached a
 *  Monster Den; once heroes started adventuring, Common and Uncommon ran dry mid-game. drawLoot
 *  now degrades gracefully when that happens (returning null rather than crashing), but running
 *  out should be a rare late-game event, not the norm — hence the deeper catalog. */
const LOOT_TEMPLATES: Record<LootRarity, LootTemplate[]> = {
  Common: [
    { name: 'Rusty Shortsword' },
    { name: 'Dented Buckler' },
    { name: 'Traveler\'s Boots', movementBonus: 1 },
    { name: 'Lucky Rabbit\'s Foot' },
    { name: 'Sharpened Stake' },
    { name: 'Chipped Hatchet' },
    { name: 'Padded Jerkin' },
    { name: 'Sling of Small Stones' },
    { name: 'Tin Signet Ring' },
    { name: 'Frayed Rope Belt' },
  ],
  Uncommon: [
    { name: 'Watchman\'s Halberd' },
    { name: 'Chainmail Vest' },
    { name: 'Swiftstep Sandals', movementBonus: 1 },
    { name: 'Amulet of Minor Fortitude' },
    { name: 'Bronze Warhammer' },
    { name: 'Hunter\'s Longbow' },
    { name: 'Bracers of the Steady Hand' },
    { name: 'Pathfinder\'s Compass', movementBonus: 1 },
  ],
  Rare: [
    { name: 'Flametongue Blade' },
    { name: 'Tower Shield of the Vigil' },
    { name: 'Cloak of the Long Road', movementBonus: 2 },
    { name: 'Ring of the Bloodied Duelist', specialAbility: 'Ignore the defender-wins tie rule once.' },
    { name: 'Stormcaller\'s Pike' },
    { name: 'Helm of the Iron Vow' },
    { name: 'Serpentine Whip', specialAbility: 'Strikes before the enemy closes.' },
  ],
  Legendary: [
    { name: 'The Sundering Greataxe', specialAbility: 'Combat bonus doubles vs Monsters only.' },
    { name: 'Crown of the Last Chieftain', specialAbility: '+1 permanent Victory Point while equipped.' },
    { name: 'Wyrmscale Aegis' },
    { name: 'Boots of the Devourer\'s Bane', movementBonus: 2 },
    { name: 'Banner of the Unbroken Line', specialAbility: 'Rallies the faithful — the bearer is never routed.' },
    { name: 'Heartseeker, the Kingsbane' },
  ],
};

// [DEFAULT — Munchkin exploration layer] "Treasure" is this same Loot pool now doubling as the
// Door deck's reward — see reducers.ts's applyFightMonster and applyUtilityEffect. Target is
// ~60 total across the four rarities; starter batch added here, filled out separately.
LOOT_TEMPLATES.Common.push(
  { name: 'Bent Fishhook' },
  { name: 'Worn Leather Gloves' },
  { name: 'Cracked Spectacles' },
  { name: 'Bag of Marbles' },
  { name: 'Whetstone' }
);
LOOT_TEMPLATES.Uncommon.push({ name: 'Wolfskin Cloak' }, { name: 'Iron Buckler' }, { name: 'Huntsman\'s Horn' });
LOOT_TEMPLATES.Rare.push({ name: 'Duelist\'s Rapier' }, { name: 'Circlet of Clear Sight' });
LOOT_TEMPLATES.Legendary.push({ name: 'The Last Ember, Warden\'s Blade' });

// [DEFAULT — Munchkin exploration layer, pass 2] Second expansion batch, bringing the total to
// ~60 across all four rarities, same proportions as before (Common/Uncommon stay the bulk,
// Legendary stays the rarest).
LOOT_TEMPLATES.Common.push(
  { name: 'Notched Kitchen Knife' },
  { name: 'Patched Wineskin' },
  { name: 'Mismatched Sandals', movementBonus: 1 },
  { name: 'Tarnished Brass Whistle' },
  { name: 'Stubby Tallow Candle' },
  { name: 'Moth-Eaten Scarf' }
);
LOOT_TEMPLATES.Uncommon.push(
  { name: 'Riveted Splint Mail' },
  { name: 'Falcon-Feather Cap' },
  { name: 'Wayfarer\'s Walking Stick', movementBonus: 1 },
  { name: 'Coil of Waxed Cord' },
  { name: 'Brass-Bound Crossbow' }
);
LOOT_TEMPLATES.Rare.push(
  { name: 'Wolfsbane Poniard', specialAbility: 'A scratch is enough, the stories say.' },
  { name: 'Gauntlets of the Standing Wall' },
  { name: 'Windsworn Cape' },
  { name: 'Executioner\'s Maul' }
);
LOOT_TEMPLATES.Legendary.push(
  { name: 'The Widow\'s Lantern', specialAbility: 'No rival ever finds this bearer by surprise at night. Flavor only.' },
  { name: 'Gravebinder\'s Chain', specialAbility: 'The bearer\'s Loot is never the one lost in a duel. Flavor only.' },
  { name: 'Aegis of the First Wall' }
);

export function buildLootCatalog(rarity: LootRarity): LootCard[] {
  const bonus = { Common: 1, Uncommon: 2, Rare: 3, Legendary: 5 } as const;
  return LOOT_TEMPLATES[rarity].map((t, i) => ({
    id: `loot-${rarity.toLowerCase()}-${i}`,
    name: t.name,
    rarity,
    combatBonus: bonus[rarity],
    specialAbility: t.specialAbility,
    movementBonus: t.movementBonus,
  }));
}

const BAD_STUFF_TEMPLATES: { name: string; effectDescription: string; hpDamage?: number }[] = [
  { name: 'Twisted Ankle', effectDescription: 'Lose 1 extra HP from the fall.', hpDamage: 1 },
  { name: 'Robbed Blind', effectDescription: 'Lose 1 Gold (or the highest-value resource you hold).' },
  { name: 'Cursed Whisper', effectDescription: 'Discard 1 equipped Loot card of your choice back to the shared discard pile.' },
  { name: 'Swarm of Stirges', effectDescription: 'Lose 2 extra HP.', hpDamage: 2 },
  { name: 'Humiliating Retreat', effectDescription: 'Your hero\'s next Move phase movement range is halved (round down).' },
  { name: 'Spilled Rations', effectDescription: 'Lose 1 Food.' },
  { name: 'Broken Bowstring', effectDescription: 'No mechanical effect — but tell the table what happened.' },
  { name: 'Nightmares', effectDescription: 'Lose 1 extra HP.', hpDamage: 1 },
  { name: 'Fleeced by a Merchant', effectDescription: 'Lose 1 Wood and 1 Stone.' },
  { name: 'Marked by the Deep', effectDescription: 'Lose 3 extra HP — but keep any Loot drawn from this encounter (there was none).', hpDamage: 3 },
];

export function buildBadStuffCatalog(): BadStuffCard[] {
  return BAD_STUFF_TEMPLATES.map((t, i) => ({
    id: `badstuff-${i}`,
    name: t.name,
    effectDescription: t.effectDescription,
    hpDamage: t.hpDamage,
  }));
}

// ── Door deck: Utility cards [DEFAULT — Munchkin exploration layer] ────────────────────────
// The non-monster half of what's behind a door — small boons, the odd hazard, and the rare
// no-fight "small Treasure" find (FreeTreasure), all drawn from UtilityEffectKind's closed set
// (types.ts) so N flavorful cards share a handful of reducer branches. Target ~35 total;
// starter batch here, filled out separately.
interface UtilityTemplate {
  name: string;
  flavor: string;
  effectKind: UtilityEffectKind;
  amount?: number;
}

const UTILITY_TEMPLATES: UtilityTemplate[] = [
  { name: 'Abandoned Cache', flavor: 'Someone left in a hurry.', effectKind: 'GainWood', amount: 2 },
  { name: 'Overgrown Quarry', flavor: 'The old cut stone is still good.', effectKind: 'GainStone', amount: 2 },
  { name: 'Wild Orchard', flavor: 'Fruit for the taking.', effectKind: 'GainFood', amount: 2 },
  { name: 'Rusted Vein', flavor: 'A seam of ore, easy to work.', effectKind: 'GainOre', amount: 2 },
  { name: 'Startled Deer', flavor: 'It didn\'t get far.', effectKind: 'GainMeat', amount: 2 },
  { name: 'Loose Coinpurse', flavor: 'Not yours, but nobody\'s arguing.', effectKind: 'GainGold', amount: 1 },
  { name: 'Clear Spring', flavor: 'Cold, clean water — a real rest.', effectKind: 'HealHp', amount: 3 },
  { name: 'Wayside Shrine', flavor: 'A quiet moment pays off.', effectKind: 'HealHp', amount: 2 },
  { name: 'Rotten Footbridge', flavor: 'Should have looked down first.', effectKind: 'DamageHp', amount: 1 },
  { name: 'Swarm of Gnats', flavor: 'Miserable, not dangerous.', effectKind: 'DamageHp', amount: 1 },
  { name: 'Old War Story', flavor: 'A veteran shares a lesson.', effectKind: 'GainXp', amount: 1 },
  { name: 'Half-Buried Strongbox', flavor: 'Somebody\'s rainy-day fund.', effectKind: 'FreeTreasure' },
  { name: 'Forgotten Cellar', flavor: 'Small, dry, and worth a look.', effectKind: 'FreeTreasure' },
  { name: 'Empty Room', flavor: 'Nothing here. Onward.', effectKind: 'Nothing' },
  { name: 'Locked Door, No Key', flavor: 'Some doors stay shut.', effectKind: 'Nothing' },
  // [DEFAULT — Munchkin exploration layer, pass 2] Second expansion batch, bringing the total to
  // ~35, same rough mix as the starter batch (a spread across all six resource gains, a couple
  // more heal/hazard cards, one more XP card, a couple more FreeTreasure, one more pure-flavor
  // Nothing). Every effectKind below is still drawn from the existing closed UtilityEffectKind
  // set — see types.ts and applyUtilityEffect in reducers.ts.
  { name: 'Toppled Timber Cart', flavor: 'The axle gave out; the load didn\'t.', effectKind: 'GainWood', amount: 2 },
  { name: 'Charcoal Burner\'s Stash', flavor: 'Cured and ready to build with.', effectKind: 'GainWood', amount: 2 },
  { name: 'Collapsed Cairn', flavor: 'Somebody\'s marker, now yours.', effectKind: 'GainStone', amount: 2 },
  { name: 'Split Boulder', flavor: 'Frost did the hard work already.', effectKind: 'GainStone', amount: 2 },
  { name: 'Root Cellar Cache', flavor: 'Cool, dark, and still good.', effectKind: 'GainFood', amount: 2 },
  { name: 'Wild Berry Thicket', flavor: 'Worth the scratches.', effectKind: 'GainFood', amount: 2 },
  { name: 'Exposed Ore Seam', flavor: 'The rain washed the topsoil clean off it.', effectKind: 'GainOre', amount: 2 },
  { name: 'Miner\'s Dropped Satchel', flavor: 'He\'ll be back for it. Probably.', effectKind: 'GainOre', amount: 2 },
  { name: 'Fresh Game Trail', flavor: 'Tracks too easy to ignore.', effectKind: 'GainMeat', amount: 2 },
  { name: 'Abandoned Snare Line', flavor: 'Someone else set the trap; you collect.', effectKind: 'GainMeat', amount: 2 },
  { name: 'Buried Toll Box', flavor: 'The road\'s forgotten its own rules.', effectKind: 'GainGold', amount: 1 },
  { name: 'Pickpocket\'s Dropped Purse', flavor: 'Their loss.', effectKind: 'GainGold', amount: 1 },
  { name: 'Warm Campfire Ashes', flavor: 'Still faintly warm. A moment to breathe.', effectKind: 'HealHp', amount: 2 },
  { name: 'Herbalist\'s Abandoned Satchel', flavor: 'The salves still work.', effectKind: 'HealHp', amount: 2 },
  { name: 'Loose Scree Slope', flavor: 'Every step is a small bet.', effectKind: 'DamageHp', amount: 1 },
  { name: 'Startled Hive', flavor: 'You didn\'t see it until it was too late.', effectKind: 'DamageHp', amount: 1 },
  { name: 'Weathered Battle Map', flavor: 'Someone\'s mistakes, laid out plainly.', effectKind: 'GainXp', amount: 1 },
  { name: 'Sunken Supply Chest', flavor: 'Waterlogged, but the contents held.', effectKind: 'FreeTreasure' },
  { name: 'Peddler\'s Lost Pack', flavor: 'He won\'t be missing it anymore.', effectKind: 'FreeTreasure' },
  { name: 'Boarded-Up Window', flavor: 'Whatever was behind it isn\'t anymore.', effectKind: 'Nothing' },
];

export function buildUtilityCatalog(): UtilityCard[] {
  return UTILITY_TEMPLATES.map((t, i) => ({
    id: `utility-${t.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${i}`,
    name: t.name,
    flavor: t.flavor,
    effectKind: t.effectKind,
    amount: t.amount,
  }));
}

/** [DEFAULT — Munchkin exploration layer] Builds the Door deck's full unshuffled card list —
 *  decks.ts's buildDoorDeck shuffles it. Reuses buildMonsterCatalog() directly for the Monster
 *  half rather than a parallel catalog: the same monster ids can legitimately exist "in" both
 *  the Ruins deck and the Door deck at once (a Ruins Den and a Door encounter are independent
 *  positions — tile.monsterDenCardId vs GameState.pendingDoorMonster), which is safe because
 *  MonsterCard data is an immutable, id-keyed lookup (getMonsterById) with no per-instance
 *  mutable state ever stored on the card itself. */
export function buildDoorCatalog(): DoorCard[] {
  const monsters: DoorCard[] = buildMonsterCatalog().map((monster) => ({ kind: 'Monster', monster }));
  const utilities: DoorCard[] = buildUtilityCatalog().map((utility) => ({ kind: 'Utility', utility }));
  return [...monsters, ...utilities];
}
