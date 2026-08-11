# HEXREALMS — Rules Reference

Authoritative implementation spec. Every rule below is tagged:

- **[CANON]** — fixed by the design doc. Implement exactly as written; do not retune without a canon change.
- **[DEFAULT]** — not specified in canon. A concrete value is supplied here so the engine is fully implementable and unambiguous. Implement as a named, configurable constant (not a magic number) so the designer can retune it without a code change.

Untagged prose is structural/procedural (how systems connect), derived directly from CANON values.

"Round" = one full cycle in which every seated player takes exactly one turn (Phases 0–5). "Turn" = one player's single pass through Phases 0–5. "Adjacent" = sharing a hex edge on the axial (q,r) grid (6 neighbors per hex).

> **Changelog — resource economy redesign (post-launch, supersedes the original §2/§5/§7 below
> wherever they conflict):** playtesting the first implementation surfaced that "tiles auto-bank
> to the wallet in Phase 0" made buildings pure passive income with no reason to ever visit your
> own territory. The economy was redesigned so tiles instead accumulate a **stockpile** at the
> start of Phase 3, a hero must physically visit and **collect** it (bounded by a **carry
> capacity** that scales with hero level), and carried resources are either spent on the spot
> (building on the hero's own current tile) or hauled home and **deposited** at the Capital
> before they're spendable elsewhere. See the revised §2, §5, and §7.5 (new) below — all still
> tagged [CANON]/[DEFAULT] the same way, just reflecting the current rules instead of the
> original ones.

> **Changelog — balance rework pass 1 (post-launch, supersedes §1.2, §2, §6.3, and §7.1/§7.2/§7.6
> below wherever they conflict):** further playtesting showed a turn-1 starting stockpile let a player
> rush a snowballing production building before anyone else had a foothold, that Farm and Quarry
> had no cost ceiling once built, and that a resource-purchased Militia sink couldn't keep pace
> with a growing army's footprint. Six changes came out of that pass, each tagged **[DEFAULT —
> balance rework]** at the point it applies below: (1) starting resources (§1.2) are now zero
> across the board — class bonuses (§1.3) are unchanged and still layer on top; (2) a sixth
> resource, **Meat**, joins the other five, produced only by the new **Cow Stable** building; (3)
> Farm and Quarry keep their existing +1/turn base rate but can't be built before Round 4, and
> each gained a further upgrade tier (§7.1a — *extended to two tiers in pass 2*); (4) **Barracks**
> is now Plains-only, costs substantially more, and no longer sells Militia for resources — it
> passively produces **Soldiers** into a reserve, moved onto any owned tile via a new **Deploy
> Soldiers** action (§6.3) *(the term "Militia" survives only in this historical note and in the
> field name `Tile.militiaCount`; the units are called **Soldiers** everywhere in the current
> rules)*; (5) the new **Cow Stable** building (Plains-only, cheap, produces Meat,
> upgradable — §7.1) feeds the upkeep this creates; (6) every player's turn now automatically
> charges **Soldier Upkeep** (§6.3a) for every Soldier anywhere on their territory, payable in Food
> and/or Meat from the wallet, with underpayment causing desertion.

> **Changelog — balance rework pass 2 (post-launch, supersedes pass 1 above and §2a, §3.3, §5,
> §6.1/§6.3/§6.3a, §7.1/§7.1a/§7.1b/§7.2/§7.4, and §11 below wherever they conflict):** pass 1
> fixed *what* the economy produced but left *when* it produced, *what the army cost to keep*, and
> *how long the game ran* alone. A measured all-AI sweep of the result showed five residual
> problems: the whole build tree was legal on turn 1–2 so the opening played itself; a single cheap
> building solved the brand-new upkeep economy outright; the army economy ran in reverse, with
> desertions outnumbering successful upkeep payments 2:1 and every wallet drained to zero every
> round; no hero in any game ever reached Level 2; and the game ended before either the hero layer
> or the military layer had come online at all. Twelve changes came out of that pass, each tagged
> **[DEFAULT — balance rework pass 2]** at the point it applies below:
>
> 1. Building upgrades generalized from a single tier-2 step into an ordered **upgrade track** of
>    arbitrary length (§7.1a) — **Cow Stable** now starts at **+1 Meat/turn** and climbs through
>    tiers 2–5 to +5, and **Farm/Quarry** each gained a second upgrade, ending at +3/turn.
> 2. Every production building now carries a **minimum round** before it may be constructed, on a
>    staged schedule (§7.1b) rather than the two ad-hoc Round-4 gates pass 1 added.
> 3. **Barracks**'s Ore share was halved, 4 Ore → 2 Ore (§7.1).
> 4. `TILE_STOCKPILE_CAP` lowered **10 → 5** (§2a).
> 5. `BARRACKS_RESERVE_CAP` lowered **15 → 9** (§6.3).
> 6. **Soldier Upkeep now spends Meat first**, Food only for the remainder — the reverse of pass
>    1's order (§6.3a).
> 7. **Barracks recruitment is throttled**: a Barracks only recruits in a round if the player can
>    currently afford the upkeep bill of the army they *already* have (§2a/§6.3). *(The throttle is
>    still in force; the flat "+3 Soldiers" it applied to was replaced by a territory-scaled rate in
>    pass 3 — see §6.3.)*
> 8. Hero Level-Up cost changed from **1 Food + 1 Gold to 2 Food** (§7.4).
> 9. Tile deck composition: **Ruins raised 6% → 12%**, taken evenly off Forest/Plains/Hills/
>    Mountain (§3.3).
> 10. **Loot Ruins is now once per Ruins tile**, tracked by a new `Tile.hasBeenLooted` flag (§5) —
>     a bug fix promoted to a rule.
> 11. **A Loot rarity can genuinely run dry**, and a draw against an exhausted rarity now resolves
>     empty-handed instead of crashing (§5/§6.1) — the other bug fix promoted to a rule.
> 12. The VP win threshold raised **15 → 30**, and a new **`WIN_MIN_ROUND` = 12** floor added under
>     every threshold-based win — with the eliminate-all-rivals Domination path deliberately exempt
>     (§11/§11.1).

> **Changelog — territory rework + roads (balance rework pass 3; BREAKING. Supersedes §2/§2a, §6,
> §6.3/§6.3a and §7/§7.1 below wherever they conflict):** the first two passes tuned numbers. This
> one replaced two systems outright, on the designer's instruction, because both were structurally
> wrong rather than merely mistuned.
>
> 1. **Territory war is no longer a Phase-4 declared attack.** The old model — a `Fight` action with
>    `combatType: 'ArmyVsTerritory'`, launched *from* a Barracks tile adjacent to the target, taking
>    the tile outright the instant the defender hit 0 units — is **gone**, and `FightTerritoryAction`
>    has been **deleted from the `Action` union** (see Data Model §11). Soldiers now take ground the
>    way an army actually does: by **marching onto it** with a single new action, `MoveSoldiers`
>    (Phase 5, free), which is simultaneously how you reinforce, how you occupy, and how you attack.
>    Full rewrite in §6.3.
> 2. **Ground is taken by occupying it, not by winning one dice roll.** Winning the battle only puts
>    your troops on the hex; ownership transfers at the start of a **later** turn of yours, and only
>    if your troops are still standing there — so a rival always gets a turn in between to march back
>    and contest it (§6.3, "Occupation, not conquest").
> 3. **A Barracks now ONLY unlocks recruitment.** It grants no attack privileges and no adjacency
>    rules of any kind. It is not a launch point, and standing next to one means nothing (§6.3).
> 4. **The dice math did not move.** `resolveArmyVsTerritory` in `engine/combat.ts`, the sorted-pairs
>    comparison, ties-favor-defender, and the Watchtower's +1-per-die (cap 6) are all exactly as
>    they were. Only the trigger and the consequence changed.
> 5. **Recruitment scales with territory, Risk-style.** The flat +3/round is gone: a Barracks now
>    raises `max(1, floor(ownedTiles / 3))` Soldiers per round, still capped by
>    `BARRACKS_RESERVE_CAP` (9) and still subject to pass 2's affordability throttle (§6.3).
> 6. **Upkeep follows the troops, not the border.** Soldiers you own cost upkeep wherever they
>    stand, including parked on foreign ground (§6.3a).
> 7. **Roads are a new subsystem** (§7.7): 1 Wood per segment along a tile edge, a free action, and
>    any owned tile chained back to your Capital by your own roads has its stockpile swept straight
>    into your wallet every round — no hero visit, no carry cap, no deposit trip. This exists because
>    one hero at movement 2 was doing double duty as the empire's entire logistics corps *and* its
>    adventurer, and the hauling crowded out the whole monster/loot layer.

> **Changelog — quick tuning passes + the Munchkin exploration layer (post-launch, supersedes pass 2/
> pass 3 above and §3.3, §6.3/§6.3a, §7.3, and §10/§11 below wherever they conflict):** several
> narrowly-scoped changes landed in quick succession after pass 3, plus one new subsystem. Each is
> tagged **[DEFAULT — direct request]** or **[DEFAULT — Munchkin exploration layer]** at the point it
> applies below:
>
> 1. **The occupation hold time was retuned 1 full round → 3 full rounds** (§6.3, "Occupation, not
>    conquest"; `TERRITORY_CLAIM_ROUNDS` in `engine/constants.ts`). At 1, a raid could plant a flag and
>    walk away with the deed almost immediately — a defender had exactly one turn to notice and react.
>    3 gives real time to notice an incursion and march back before it's permanent, which is the whole
>    point of occupation being a process rather than an instant capture.
> 2. **The VP win threshold was doubled twice: 30 → 60 → 120** (§11). Even at 60, VP was still
>    reported as the game's default ending rather than Domination or Hero-Level-Race ever getting a
>    real chance to land first — every owned tile and every building keeps paying VP every round
>    regardless of how the war is going, so a large, peaceful economy still out-scored a smaller empire
>    that was actually winning the fight for territory. 120 pushes the VP finish line well past what
>    steady tile/building accumulation alone can plausibly reach in a normally-paced game.
> 3. **River tiles are no longer a flat percentage of the tile deck** (§3.3). A fixed count,
>    `riverTileCountFor(playerCount) = floor(1.5 × playerCount)`, is carved out of the deck first;
>    the remaining percentage table (below) applies only to what's left. **Forest was raised
>    20% → 28%** of that remainder, absorbing the share River used to occupy — a live 6-round report
>    found a player with zero Wood the entire game, and Wood is both a near-universal building cost and
>    Roads' one ingredient, so it can least afford to be scarce.
> 4. **The Town (Capital upgrade) path grew from 2 tiers to 5, and tier 1 is now free** (§7.3/§10).
>    Every player's starting tile carries tier 1 from turn one — it is not something anyone spends a
>    Build action to acquire — and the second-hero unlock moved from the old tier 2 to the new **tier
>    4**. Five tiers gives the Town a real investment arc across a game that, at the new VP threshold,
>    routinely runs well past 20 rounds.
> 5. **A troop cap was introduced, scaled by owned River tiles** (new §6.3b; `troopCapFor` in
>    `engine/constants.ts`). Since River tiles produce no resource of their own (§1/§2a), this is their
>    entire value proposition — a deliberately large lever so that securing water is a real strategic
>    choice, not a rounding error.
> 6. **`DeploySoldiers` picked up two rules `MoveSoldiers` already had** (§6.3, "Deploy Soldiers"): it
>    is now adjacency-limited (the Barracks tile itself, or one hex out — soldiers do not teleport,
>    this was a direct bug report) and subject to the same `MIN_SOLDIERS_LEFT_BEHIND` floor as a march,
>    except when the destination is the source tile itself.
> 7. **New subsystem: the Door deck / Munchkin exploration layer** (new §6.4). The first time a hero's
>    move ends on a tile it has never visited, the engine now automatically draws a card from a new,
>    combined Monster+Utility deck — a monster fight (mandatory), or an immediate small non-combat
>    effect. See §6.4 for the full rules; this is the piece of the original three-pillar pitch
>    (Catan + Risk + Munchkin, docs/game-design.md §1) that turns "walk somewhere new" into a real
>    Munchkin beat instead of only a Ruins tile being one.

> **Changelog — hero battle participation (post-launch, supersedes §6 below wherever it conflicts):**
> heroes had never been able to physically enter Army vs Territory combat at all — Risk skirmishes ran
> entirely on Soldier dice, so a hero could be leveled and fully geared for an entire game without that
> investment ever touching the war for territory. The direct brief was: *"find a fair equation between
> risk and the hero. If the hero dies a new one is spawned without any of the items or skills of the
> last one."* Two changes came out of that, each tagged **[DEFAULT — hero battle participation]** at
> the point it applies below:
>
> 1. **A hero standing on either side of a march can lend that side's roll one extra die** — new §6.3c.
>    The attacker opts in with `heroJoins` on the same `MoveSoldiers` action (the hero must be standing
>    on `fromCoord`); a defending hero needs no flag at all, just needs to be standing on `toCoord` when
>    the attack lands. The die itself is computed by the same roll every other Fight-phase encounter
>    uses (§6.1's `d6 + level + attack + gearBonus`, Warrior's extra-die perk included) — it merges into
>    the sorted-and-paired comparison §6.3 already runs as one more entry, and it is never counted as a
>    Soldier, so it can never cost or save a unit of troops.
> 2. **Losing that pairing can permanently kill the hero** — a harsher, entirely separate consequence
>    from the "downed" rule that governs every ordinary HP loss outside this one case (new §6.1a,
>    documented here for the first time — the behavior itself predates this change, it just never made
>    it into this file). HP reaching 0 while fighting IN Army vs Territory combat respawns a brand-new
>    Level 1 hero in the same slot, carrying none of the dead hero's level, XP, gear, Loot, or curses —
>    only the player's own standing investments (class bonus, Town-tier HP, a built Dock) carry over,
>    because those were never the hero's to lose in the first place. See §6.3c, and
>    `docs/game-design.md` §6 for why the trade-off is shaped this way.

> **Changelog — balance rework pass 4: late-game depth + Capital Conquest (post-launch, supersedes
> §7.1/§7.1a/§7.3/§10/§11 below wherever they conflict):** a live 4-seed simulation confirmed Wood
> (and to a lesser extent Stone, Ore, and Gold) had no meaningful late-game sink — a mature economy's
> tile+building production simply outran every one-time build cost, and winners routinely finished
> with 200–700+ idle Wood. Separately, the direct brief was: *"make it so that conquering the capital
> of another player is a win condition,"* confirmed as an **instant win for the conqueror** — the
> moment ANY rival's Capital claim settles, the whole game ends right there, regardless of remaining
> player count — plus *"AI should also be adapted so that protecting capital and borders with troops
> is properly scored,"* and, mid-pass, *"treasure/equipment has a gold value like in Munchkin which
> can be sold for additional troops — higher level equip = more troops,"* and, once Capital Conquest
> made a single lost Capital fatal, *"conquering capital requires 5 rounds of staying on it; not only
> [3] like for normal tiles."* Six changes, each tagged **[DEFAULT — balance rework pass 4]** at the
> point it applies below:
>
> 1. **Watchtower and Barracks each gained a 3-tier upgrade track** (§7.1a), a real Stone+Ore(+Wood)
>    and Wood+Ore+Food sink respectively that also raises a Watchtower's defending-die bonus (+1/+2/+3,
>    cap 6/6/8) and a Barracks's reserve cap and recruiting rate — directly aimed at both the idle-
>    resource problem and "defend your borders" now having something concrete to build toward.
> 2. **The Town gained a 6th tier, "the Grand Bazaar"** (§7.3/§10) — a late-game wonder capstone
>    spending a broad spread of Wood/Stone/Ore/Gold/Food at once for a large one-time VP payout,
>    reusing the existing Capital-tier mechanism rather than a new building (a separate BuildingType
>    restricted to the Capital tile would collide with the Town structure already occupying that
>    tile's one building slot).
> 3. **The Smithy's long-promised "crafts hero gear from Ore + Gold" is now real** (new §7.1c) — a
>    `CraftGear` free action drawing a guaranteed-rarity Loot card from the shared pool for a rarity-
>    scaled Ore+Gold cost, the biggest single sink either resource has.
> 4. **A new `SellLoot` free action is CraftGear's inverse** (§7.1c) — sells a Loot card at a Barracks
>    for Soldiers, scaled by rarity (Common→1 up to Legendary→7), so a hero's trophy case doubles as
>    an army reserve when that's worth more than the gear itself.
> 5. **Capital Conquest is a new, 4th win condition** (§11) — instant, unconditional on remaining
>    player count, and exempt from `WIN_MIN_ROUND` the same way the old "eliminate every rival"
>    Domination clause was — which it replaces outright: a single captured Capital is enough now, so
>    Domination's elimination sub-path is gone (the 60%-tile-share path is untouched).
> 6. **A Capital's own occupation claim takes `CAPITAL_CLAIM_ROUNDS` = 5 full rounds to settle** (§6.3,
>    "Occupation, not conquest"), not the ordinary tile's `TERRITORY_CLAIM_ROUNDS` = 3 — a direct
>    follow-up once Capital Conquest made settling this one claim an instant, whole-game win: its
>    defender earns a genuinely wider window to notice the invasion and march back, not the same
>    three-round grace period as losing a single Farm.

---

## 1. Setup

### 1.1 Player Count
2–6 players. **[CANON]**

### 1.2 Starting Resources
**[DEFAULT — balance rework: zeroed out]** Each player begins with an empty wallet, before class
bonuses:

| Wood | Stone | Food | Ore | Meat | Gold |
|---|---|---|---|---|---|
| 0 | 0 | 0 | 0 | 0 | 0 |

This replaces an earlier small starting stockpile (3 Wood + 2 Stone + 3 Food + 1 Ore + 1 Gold) —
day-1 playtesting showed it let a player rush a snowballing production building before anyone
else had a foothold. Class starting bonuses (§1.3) are unchanged and are still added on top of
this baseline: Woodcutter +2 Wood, Miner +1 Ore, Merchant +2 Gold (Farmer/Warrior/Mage/Rogue
grant no starting-resource bonus — see §1.3's table for their non-resource perks).

### 1.3 Class Draw
7 classes exist. **[CANON]** Shuffle the 7 class cards and deal exactly one, face-down-then-revealed, to each seated player (no duplicates in a single game; with ≤6 players, 1–5 classes go unused). **[DEFAULT: deal method]**

| Class | Starting-Tile / Hero Bonus |
|---|---|
| Woodcutter | Starts with a Sawmill pre-built; permanent +1 Wood on Forest tiles |
| Miner | +1 starting Ore; starting tile biased near Hills/Mountain |
| Farmer | +1 Food/turn baseline; hero starts with +2 max HP |
| Warrior | Hero starts with a weapon giving +2 Attack (base Attack 1 → 3); rolls an extra combat die on Fight-phase rolls — see §6.1 for exact resolution |
| Mage | All building costs −1 resource (each resource type, floor 1); hero has a ranged attack usable before melee |
| Merchant | Bank trade ratio 3:1 instead of 4:1; +2 starting Gold |
| Rogue | Hero may move through unowned/rival tiles without stopping; once per round may steal 1 resource from an adjacent rival tile |

All bonuses **[CANON]**; deal/uniqueness mechanics **[DEFAULT]**.

### 1.4 Starting Tile Placement
1. Determine turn order: each player rolls 1d6, highest first, reroll ties among the tied players only. **[DEFAULT]**
2. In turn order, each player places one Capital starting tile (tile type: Plains) on the shared map. **[DEFAULT: tile type]** A Capital tile must be at axial distance ≥ 3 from every other placed Capital tile. **[DEFAULT: min distance]**
3. Each player's hero token spawns on their own Capital tile: Level 1, 0 XP, Max HP 10, Attack 1, empty inventory, before class bonuses **or the free Town tier-1 HP bonus** are applied. **[DEFAULT: base hero stats]** Tier 1 of the Town (§7.3) is granted automatically at the same moment and adds +2 Max HP on top of this baseline, so a hero's actual starting Max HP is 12 before any class bonus, not the bare 10 above.
4. Class bonuses from 1.3 are applied immediately after spawn.
5. First round begins with the player who rolled highest in step 1.

---

## 2. Phase 0 — Production (now a pass-through — see Changelog)

Automatic, no player choice, and — as of the resource economy redesign — no effect on tile
resources. **[CANON: phase name/order still fixed]** Tile production now accumulates
automatically the instant the active player's **Phase 3** begins instead; see §2a below.

**[DEFAULT — balance rework]** Phase 0 is no longer a pure no-op, though: the instant it opens for
the active player, the engine automatically resolves two things, in this order, before advancing to
Phase 1.

1. **[DEFAULT — territory rework] Held territory is claimed.** Every tile this player's Soldiers are
   standing on, that the player does not own, and that they took in an **earlier** round now becomes
   theirs (§6.3). This runs first so a tile taken last turn is already paying its new owner by the
   time production and upkeep resolve.
2. **Soldier Upkeep** is charged — see §6.3a. This has to run every turn regardless of whether the
   player ever built a Barracks, since a standing army (garrisoned, still sitting in a Barracks
   reserve, or camped on captured ground abroad) eats every round whether or not its owner remembers
   it exists.

### 2a. Tile production (fires automatically at Phase 3 entry)

For every tile the active player owns, add its yield to that **tile's own stockpile** (not the
player's wallet — see §5 for how a hero collects it). Order matters because Windmill consumes
Food produced this same step. **[DEFAULT: resolution order below]**

**Step A — Base + building yield.** Every owned tile produces its base resource by tile type
(Forest→Wood, Hills→Stone, Plains→Food, Mountain→Ore, Desert→Gold, Ashland→Stone; River/Ruins/
Volcano produce nothing — see the tile→resource table in §1) **[DEFAULT: base tile yield now
exists at all — see Changelog]**, PLUS a matching production building's bonus if one is built
there:

```
for each owned tile T:
    if TILE_RESOURCE[T.type] is not null:
        T.stockpile[TILE_RESOURCE[T.type]] += 1                      # base yield
    if T.building exists and T.building has a producesResource:
        T.stockpile[T.building.producesResource] += T.building.produceAmount   # +1, from §7.1
```

Rates come verbatim from the Building Cost Table (§7.1), and are the **tier-1** rates: Sawmill +1
Wood, Hunting Lodge +1 Food, Quarry +1 Stone, Farm +1 Food, Mine +1 Ore, Trade Post +1 Gold,
Cow Stable +1 Meat **[DEFAULT — balance rework pass 2: was +3 at tier 1; the Cow Stable
now climbs to +5 across four upgrades instead of starting near the top — see §7.1a]**. Dock produces
no resource at all — its only effect is unlocking boat movement (§4.3); **[DEFAULT — troop cap
rework: dropped Dock's old +1 Food/turn]** River tiles' whole economic role moved to raising the
troop cap instead (§6.3b), so nothing built on one produces a resource any more. Each tile's
stockpile is capped at **5** per resource type once accumulated — production simply stops adding
past that cap on tiles nobody has visited in a while. **[DEFAULT — balance rework pass 2:
`TILE_STOCKPILE_CAP` lowered 10 → 5]** At 10, an untouched tile quietly banked two full hero-loads,
so territory paid out whether or not anyone ever walked to it. At 5 a tile tops out at roughly one
Level-1 hero's entire carry capacity (§5.1: `4 + level` = 5), which makes collection trips a real
logistical decision again and stops ground you never visit from being free income.

**[DEFAULT — balance rework]** Farm's and Quarry's own base rate above is unchanged (still
+1/turn) — what changed is that neither may be *built* before Round 4 (§7.1b), and each can now be
upgraded **twice**, reaching +3/turn at tier 3 **[DEFAULT — balance rework pass 2: was a single
upgrade to +2/turn]**. See §7.1b for the round gate and §7.1a for the upgrade track. A tile with an
upgraded building simply substitutes that building's **current tier's** `produceAmount` for the
tier-1 one in the loop above — nothing else about accumulation changes. Barracks does NOT go
through this resource loop at all; it produces Soldiers, not a `ResourceType`, it produces a number
that scales with how much ground the player holds, and it produces them conditionally — see §6.3's
recruitment rate and throttle.

**Step B — Converters (Windmill).** For each owned Windmill, drawing from that SAME tile's own
just-produced Food:

```
if T.stockpile[Food] >= 2:
    T.stockpile[Food] -= 2
    T.stockpile[Gold] += 1
else:
    # produces nothing this turn; stockpiles never go negative
```

Windmill's Food conversion happens after Step A so it can spend Food produced this same step.
**[DEFAULT: insufficient-resource handling]**

**Step C — Road supply collection. [DEFAULT — territory rework]** Immediately after Steps A and B,
every owned tile joined to the player's Capital by an unbroken chain of that player's own **roads**
has its entire stockpile swept straight into the **wallet** — no hero visit, no carry-capacity
limit, no deposit trip. The tile is left empty and starts accumulating again next round. This runs
in the same breath as accumulation, so a road-connected tile never sits on a pile for even one
round. Full rules, including exactly which tiles count as connected, in §7.7.

Hunting Lodge's "+1 XP on first hunt each round" clause is NOT part of this accumulation step —
it triggers on a Gather-phase hunt action; see §5.

---

## 3. Phase 1 — Draw & Place Tile

**[CANON: phase name/order]**

### 3.1 Draw
Draw the top tile of the shared tile deck.

### 3.2 Legal Placement — **[CANON]**
A drawn tile may be placed on any empty hex that satisfies both:
1. It is adjacent (shares an edge) to at least one hex the active player already owns.
2. The target hex is unoccupied (no existing tile there).

If no legal hex exists for the active player, the drawn tile is discarded to the bottom of the deck and Phase 1 ends with no placement. **[DEFAULT]** Placing the tile makes it owned by the active player.

### 3.3 Tile Deck Composition & Weighting
Deck size scales with player count: `100 + 20 × (players − 2)` tiles (100 @ 2p, up to 180 @ 6p). **[DEFAULT]**

**[DEFAULT — direct request, supersedes the flat-percentage River row this table used to carry]**
River is built in **two steps**, not one flat percentage, because tying water's share to deck size
(which itself grows 20 tiles per extra player) scaled it wrong: the troop-cap payoff for owning water
(§6.3b) is what it is regardless of player count, so a big game would otherwise flood the map with far
more water than any one empire's cap curve was tuned around.

**Step 1 — carve out River by an absolute per-player count, first:**

```
riverTileCount = floor(1.5 × playerCount)     # RIVER_TILES_PER_PLAYER = 1.5
```

At 2 players that's 3 River tiles; at 6 players, 9 — small and roughly proportional to how much
territory actually exists to hold it, not to the size of the whole deck.

**Step 2 — apply the percentage table below to whatever's left** (`deckSize − riverTileCount`),
rounded to the nearest tile at build time:

| Tile Type | % of remainder | Notes |
|---|---|---|
| Forest | 28% | common ‡ |
| Plains | 20% | common |
| Hills | 17% | common |
| Mountain | 15% | common |
| Desert | 6% | scarce, per canon |
| Ruins/Dungeon | 12% | uncommon § |
| Volcano | 2% | rare, per canon |

River reads 0% in the underlying `TILE_DECK_COMPOSITION` table on purpose — it is excluded from this
percentage step entirely and handled only by Step 1 above. The seven percentages here sum to 100.
**[DEFAULT]** in full (canon only mandates the relative adjectives "scarce"/"special"/"rare"/no
adjective for the rest, which this table satisfies). Shuffle the resulting deck at game start;
reshuffle discards into the deck if it empties.

**Worked example (2 players):** `deckSize = 100`, `riverTileCount = floor(1.5×2) = 3`,
`remainder = 97`. Forest: `round(0.28×97) = 27`. Plains: `round(0.20×97) = 19`. Hills:
`round(0.17×97) = 16`. Mountain: `round(0.15×97) = 15`. Desert: `round(0.06×97) = 6`. Ruins:
`round(0.12×97) = 12`. Volcano: `round(0.02×97) = 2`. Total: `3 + 27+19+16+15+6+12+2 = 100`. ✓

‡ **[DEFAULT — direct request]** Forest was raised **20% → 28%**, absorbing River's old 8% share
outright rather than spreading it thin across every type — a live 6-round report found a player with
zero Wood the entire game, and Wood is both a base building cost across nearly every early structure
AND Roads' one ingredient (§7.7), so it is the resource that can least afford to be scarce.

§ **[DEFAULT — balance rework pass 2]** Ruins/Dungeon was raised **6% → 12%**, the extra 6 points
taken evenly off the four bulk economy terrains (Forest 22 → 20, Plains 22 → 20, Hills 18 → 17,
Mountain 16 → 15 — figures from before the Forest bump directly above). Ruins are the ONLY source of
Monster Dens (§6.1), and therefore the only source of hero XP, levels, and Loot outside a Hunting
Lodge. At 6% a full game put just 2–5 of them on the board, so even a hero that hunted perfectly could
not level more than once or twice and the entire Munchkin layer stayed vestigial. Doubling the share
gives that half of the game enough material to actually be played.

---

## 4. Phase 2 — Move Hero

**[CANON: phase name/order; movement range keyed off "hero stats/gear" per canon, formula below is DEFAULT]**

### 4.1 Movement Range
```
movementPoints = 2                              # base [DEFAULT]
                + (1 if hero.level >= 5 else 0)  # [DEFAULT]
                + sum(loot.movementBonus for loot in hero.equipped)  # Loot special ability, if any [CANON: Loot may carry special abilities]
```
Unused movement points do not carry over between turns. The active hero may submit exactly one
MoveHero action per turn, covering the whole path in one go — not one action per step. Movement
points don't persist as remaining budget across multiple separate move actions in the same
turn. **[DEFAULT: one-move-action-per-turn rule]**

### 4.2 Terrain Costs — **[DEFAULT]**

| Tile Situation | Cost to Enter |
|---|---|
| Forest / Plains / Hills / Mountain / Desert / Ashland (unowned or own) | 1 point |
| Ruins/Dungeon | 1 point |
| River, hero's player has NOT built any Dock | Impassable — cannot enter |
| River, hero's player HAS built at least one Dock | 1 point (boat movement unlocked) |
| Rival-owned tile | Impassable to enter/stop, EXCEPT: Rogue class may move through without stopping (pays normal cost, cannot end movement there) — **[CANON: Rogue ability]**; a hero may always move onto a rival-owned tile that contains a rival hero specifically to initiate a Phase 4 PvP duel (see §6.2), spending its normal terrain cost |
| Unowned/neutral non-River tile | 1 point, freely enterable and may be a stopping point |

### 4.3 Boat Movement
Boat movement is unlocked per-player by owning ≥1 Dock (built per §7.1). Once unlocked, the hero's River terrain cost equals normal land cost (1 point) as shown above. **[CANON: unlock source = Dock; DEFAULT: exact cost]**

River tiles produce no resource of their own (§1/§2a) — a Dock's boat-unlock is about reach, not
income. The real payoff for holding River tiles is the troop cap they unlock for the owning player's
army; see §6.3b.

### 4.4 Arriving somewhere new — **[DEFAULT — Munchkin exploration layer]**
If this turn's Move Hero action **ends** on a hex the acting hero has never stood on before, the
engine automatically draws a Door card the instant the move resolves — before Phase 3 even opens.
This is the trigger for the whole Munchkin exploration layer; see §6.4 for the full rules (what's in
the deck, the three outcomes, and the mandatory-fight consequence that plays out later in Phase 4).

---

## 5. Phase 3 — Gather

**[CANON: phase name; "manual resource-gathering actions ... e.g. looting a Ruins tile, foraging"]**

Tile production (§2a) accumulates automatically the instant this phase begins, before the
active player picks a Gather action. The active hero may then take exactly one Gather action
**[DEFAULT]** at its current tile (post-Phase-2 position). Every action that grants a resource
adds it to the hero's **carried inventory**, capped by carry capacity (§5.1) — never straight
to the player's wallet. **[DEFAULT: redesign — see Changelog]**

| Action | Where | Effect |
|---|---|---|
| Collect Resources | Own tile with a non-empty stockpile | Move as much of the tile's accumulated stockpile into the hero's carried inventory as fits within remaining carry capacity (partial pickup allowed; the rest stays on the tile for a later visit). **[DEFAULT]** A **road-connected** tile (§7.7) will normally have nothing left to collect — its pile was already swept into the wallet at the top of this phase. **[DEFAULT — territory rework]** |
| Forage | Forest/Plains/Hills/Mountain/Desert tile NOT owned by the active player | Gain 1 unit of that tile type's associated resource (§ tile→resource table) into carried inventory. Once per specific tile per round. **[DEFAULT]** |
| Loot Ruins | Ruins/Dungeon tile with no active Monster Den encounter pending, **and not already looted** | Draw 1 Loot card, rarity restricted to Common or Uncommon only (no combat risk). Loot cards are not resources and aren't subject to carry capacity. **Once per Ruins tile, ever** — see §5.2. **[DEFAULT; once-per-tile is DEFAULT — balance rework pass 2]** |
| Hunt | Own Forest tile with a built Hunting Lodge | Gain 1 Food into carried inventory. The FIRST hunt action any hero performs in a round also grants that hero +1 XP. **[CANON: Hunting Lodge XP clause]** |
| Rogue Steal | Any hex adjacent to a rival-owned tile (Rogue class only) | Steal 1 resource (from that adjacent tile's own accumulated stockpile, attacker's choice of type among what's there) into carried inventory. Usable once per round. **[CANON: Rogue ability; DEFAULT: steals from the tile's stockpile, not the rival's wallet — see Changelog]** |

A hero that took no Gather-eligible action available at its tile simply skips the phase. A
Gather action that would add a resource is rejected outright if the hero has zero remaining
carry capacity — visit the Capital and deposit first (§7.5).

### 5.1 Carry Capacity — **[DEFAULT]**

```
carryCapacity(hero) = 4 + hero.level
```

A Level 1 hero carries up to 5 resources total (any mix of types); a Level 5 hero carries 9.
This is the ceiling on everything a hero can be holding across all six resource types
combined (including Meat — **[DEFAULT — balance rework]**), not a per-type limit.

### 5.2 A dungeon's hoard is finite — **[DEFAULT — balance rework pass 2]**

**Loot Ruins may be taken at most once per Ruins tile, for the whole game.** The tile records that
its treasure has been taken (`Tile.hasBeenLooted`, see docs/data-model.md §3) and refuses every
later attempt — including by a different player who captures the hex afterwards. Clearing the tile's
Monster Den (§6.1) does not reset it either; a Monster win and the Ruins' own hoard are two separate
one-time rewards from the same hex.

Previously the action had no such guard, and the wording "a Ruins tile with no active Monster Den"
made it *infinitely* repeatable: a hero could stand on one cleared Ruins hex and loot it every
single turn, and would eventually pull the entire Common and Uncommon Loot supply out of one square
metre of rubble. That is not an edge case — an all-AI integration game livelocked on exactly this,
burning **5,810 consecutive Loot Ruins actions** on a single tile, and a human clicking the same
button would have farmed it just as freely. A dungeon can only be cleaned out once.

### 5.3 An exhausted Loot rarity — **[DEFAULT — balance rework pass 2]**

Loot is the one deck in the game with **no discard cycle**: a drawn Loot card is kept by its hero
permanently, and no rule anywhere returns it to the pile. Each rarity is therefore a hard finite
budget for the whole game rather than a deck that recirculates, and a rarity genuinely can run dry.

When it does, the draw **resolves normally but empty-handed** — the hero gets no card, and nothing
else about the action changes. This applies identically wherever a Loot draw happens: a Monster win
(§6.1) still grants its XP and still clears the Den; a Loot Ruins Gather (§5) still consumes the
Gather action and still marks the tile looted; a successful Volcano tame (§6.1) still converts the
tile to Ashland and still pays its 5 Gold; **and, as of the Munchkin exploration layer (§6.4), a won
Door monster fight or a drawn `FreeTreasure` Utility card** resolve the same way — only the card is
missing.

Running out should be a rare late-game event rather than routine, so the Loot catalog was roughly
doubled in the balance rework pass 2 (31 cards, up from 17), and **[DEFAULT — Munchkin exploration
layer] expanded again** to carry the Door deck's added draw volume (§6.4) — it now totals **60 cards**
(21 Common, 16 Uncommon, 13 Rare, 10 Legendary). See `engine/catalogs.ts` for the printed cards and
`drawLoot` in `engine/decks.ts` for the exhaustion behavior.

---

## 6. Phase 4 — Fight

**[CANON: phase name; three combat types below]** A hero may engage at most one combat resolution
per Phase 4: one Monster fight (§6.1), OR one PvP duel (§6.2), OR one Volcano tame (§6.1's special
case). **[DEFAULT]**

**[DEFAULT — Munchkin exploration layer]** A **mandatory Door-monster fight is exempt from that
once-per-turn cap** — see §6.4. It's forced on the hero by exploration, not chosen, so it doesn't
compete with the turn's one discretionary combat resolution; a hero can resolve a chosen fight from
the paragraph above AND a pending Door monster in the same Phase 4. A pending Door monster also
blocks the turn from leaving Phase 4 or ending at all until it's fought — §6.4 has the full rule.

**[DEFAULT — territory rework]** Army vs Territory is **no longer a Phase-4 action at all** — it is
not one of the things this once-per-turn limit is choosing between, and there is no "declare an
attack" step anywhere in Phase 4. Territory battles happen in **Phase 5**, on contact, when Soldiers
march onto a hex somebody else is holding. §6.3 stays in this chapter because it is still combat and
still shares the dice conventions above, but read it as a Phase-5 rule.

### 6.1 Hero vs Monster

**Trigger:** hero's current tile is a Ruins/Dungeon or Volcano tile hosting an unresolved Monster Den. **[CANON]**

**Setup:** Draw 1 Monster card from the shared Monster deck (Monster Level 1–10, plus a special ability). **[CANON]**

**Die roll — [CANON: Warrior "rolls an extra combat die"; DEFAULT: exact resolution]:** A hero without
the Warrior class's extra-die perk rolls a single d6. A hero WITH the perk (`extraCombatDie: true` on
their ClassDefinition, per §1.3) rolls 2d6 and keeps the higher single die as its `d6` value below. The
perk affects only the die itself, and applies identically in §6.1 and §6.2 — it does NOT apply to the
per-unit dice rolled in §6.3 Army vs Territory, since those are Soldiers acting independently of the
hero, not the hero's own roll. (The hero is not present at a territory battle in any sense: §6.3 is
resolved by marching troops, and the hero's stats, position and class perks never enter it.)

**Roll — [CANON formula]:**
```
attackTotal = d6 + hero.level + hero.attack + gearBonus
    # d6 = 1d6, or 2d6-keep-highest if the hero has the extra-die perk (see above)
    # hero.attack = hero's base Attack stat, 1 at spawn per §1.4, plus any permanent class bonus
    #               (e.g. Warrior's starting weapon raises it to 3 — see §1.3)
    # gearBonus = sum of equipped Loot flat bonuses
```

**Target — [DEFAULT formula, canon specifies only "vs the Monster's Level threshold"]:**
```
threshold = monster.level + 3
```

**Resolution:**
- `attackTotal >= threshold` → **Win [CANON outcome]**: hero gains XP equal to `monster.level` **[DEFAULT amount]**, and draws 1 Loot card at a rarity keyed to Monster Level:

  | Monster Level | Loot Rarity Drawn |
  |---|---|
  | 1–2 | Common |
  | 3–4 | Uncommon |
  | 5–7 | Rare |
  | 8–10 | Legendary |

  **[DEFAULT bracket table; "rarity scales with Monster Level" is CANON]** If that rarity's pile is
  exhausted, the win still stands in full — XP is granted, the Den is cleared — the hero simply
  draws no card. See §5.3. **[DEFAULT — balance rework pass 2]**

- `attackTotal < threshold` → **Lose [CANON outcome]**: hero takes HP damage equal to `monster.level` **[DEFAULT amount]**, and draws 1 Bad Stuff curse card from the shared curse deck (resolved per card text). **[DEFAULT: "and/or" in canon resolved as "always both"]**

**Worked Example 1 (win):** Hero is Level 4, hero.attack = 1 (not Warrior), with one Uncommon Loot equipped (+2). Drawn Monster is Level 5 → threshold = 5 + 3 = 8. Roll 1d6 = 5. `attackTotal = 5 + 4 + 1 + 2 = 12 >= 8` → Win. Hero gains 5 XP (Monster Level) and draws a Rare Loot card (Level 5 falls in the 5–7 bracket).

**Worked Example 2 (loss):** Hero is Level 2, hero.attack = 1, no gear. Drawn Monster is Level 7 → threshold = 7 + 3 = 10. Roll 1d6 = 3. `attackTotal = 3 + 2 + 1 + 0 = 6 < 10` → Lose. Hero takes 7 HP damage (Max HP 10 → 3 HP remaining) and draws 1 Bad Stuff card.

**Worked Example 3 (Warrior extra die):** Hero is a Level 3 Warrior, hero.attack = 3 (base 1 + Warrior's +2 starting weapon), no additional Loot equipped. Drawn Monster is Level 4 → threshold = 4 + 3 = 7. Warrior rolls 2d6-keep-highest: rolls are 2 and 5, keeps 5. `attackTotal = 5 + 3 + 3 + 0 = 11 >= 7` → Win.

**Volcano special case — [CANON: "tame" mechanic, DEFAULT: exact numbers]:** A Volcano tile's encounter uses the same formula with `monster.level` fixed at 10. On a win, instead of the normal reward the hero receives a one-time cache of 5 Gold + 1 guaranteed Legendary Loot card, and the Volcano tile permanently converts to Ashland (a Stone-producing tile). Ashland is treated as Hills for building purposes, but any Quarry built on it produces +1 Stone every 2 turns instead of every turn ("weak"). **[DEFAULT]** "Guaranteed" means guaranteed *Legendary*, not guaranteed to exist: if the Legendary pile has been exhausted, the tame still succeeds and still pays its 5 Gold, but there is no card left to hand over — see §5.3. **[DEFAULT — balance rework pass 2]**

### 6.1a Hero HP reaching 0 outside Army vs Territory — the "downed" rule

**[DEFAULT — documented here for the first time; the behavior itself is not new]** Canon never says
what happens when a hero's HP reaches 0, and until this pass neither did this document — the engine
has always defined an answer (`applyHeroDamage` in `engine/reducers.ts`), it just never made it into
the rulebook. This section writes down the rule that governs every ordinary HP loss: a lost Monster
fight (above), a Bad Stuff curse card resolved per its own text, or a Door card's `DamageHp` Utility
effect (§6.4). A PvP duel (§6.2) never damages HP at all, so it never triggers this rule either way.

Whenever one of those brings a hero to 0 HP or below, the hero is **downed**: it retreats to its
owner's Capital tile and heals to full HP, instantly. Level, XP, Attack, equipped and carried Loot, and
active curses are all untouched — a downed hero loses nothing but the trip home.

**This is deliberately the soft outcome, and it stays the rule for everything listed above.** §6.3c
below defines a second, much harsher HP-reaches-0 rule — permanent death, replaced by a brand-new
Level 1 hero — but it applies ONLY to a hero who was hit while lending its own die to Army vs Territory
combat (§6.3). The two rules never compete for the same loss: which one applies is decided entirely by
which kind of combat the hero was fighting when its HP ran out, not by anything stored on the hero
itself.

### 6.2 Hero vs Hero (PvP / Backstab)

**Trigger:** attacking hero moves onto (or already occupies, per §4.2) the same tile as a rival hero. **[DEFAULT: same-tile requirement]**

**Roll — [CANON formula]:**
```
attackerTotal = attackerD6 + attacker.level + attacker.attack + attackerGearAttack
defenderTotal = defenderD6 + defender.level + defender.attack + defenderGearAttack
    # attackerD6/defenderD6 = 1d6, or 2d6-keep-highest for that hero if they have the
    #                          Warrior extra-die perk (see §6.1's die-roll clause)
    # attacker.attack/defender.attack = that hero's base Attack stat (§1.4/§1.3, as in §6.1)
```
Higher total wins. **[CANON]** On a tie, the defender wins. **[DEFAULT tie-break]**

**Resolution:** winner steals 1 resource (attacker's declared choice of type, if the loser holds any) OR 1 Loot card (winner's choice of which card, if the loser holds any) from the loser — winner picks which category. **[CANON: steals 1 resource or 1 Loot card; DEFAULT: choice mechanics]**

**Worked Example:** Attacker Level 5, attack 1 (not Warrior), with a Rare Loot equipped (+3): rolls 1d6 = 2 → total = 2 + 5 + 1 + 3 = 11. Defender Level 4, attack 1, with a Common Loot equipped (+1): rolls 1d6 = 6 → total = 6 + 4 + 1 + 1 = 12. Defender total (12) > Attacker total (11) → Defender wins and steals 1 resource or 1 Loot card from the Attacker.

### 6.3 Army vs Territory — Soldiers take ground by marching onto it

**[DEFAULT — territory rework] This section was rewritten end to end in balance rework pass 3 and
replaces the previous rule entirely.** What is gone: the requirement to own a Barracks, the rule
that an attack is launched *from* a Barracks tile adjacent to its target, the Phase-4 "declare an
attack" step, and instant capture on a won roll. `FightTerritoryAction` (`combatType:
'ArmyVsTerritory'`) has been **removed from the `Action` union** — see Data Model §11. What did NOT
change: the dice, which are still `resolveArmyVsTerritory` in `engine/combat.ts`, still one d6 per
unit, still sorted-and-paired, still ties-favor-defender, still +1 per defending die (cap 6) for a
Watchtower. Only the trigger and the consequence are new.

**Designer's intent.** Territory should be contested **along the borders, where tiles of two
different colours meet**. A troop attacks a foreign tile by *moving onto it*; if the tile is empty it
becomes yours once your troops have stood on it, uncontested, for `TERRITORY_CLAIM_ROUNDS` (= 3) full
rounds; if enemy troops are there you fight first and then still have to hold the ground for that same
stretch. What that produces at the table is both players
stationing troops along the frontier to protect their own tiles from the enemy's — a live border that
has to be watched and manned, rather than a ranged "attack that hex" button pressed from safety
behind a building. Every rule below exists to make that picture true.

#### Trigger — the march (`MoveSoldiers`)

**One action does all of it.** Reinforcing, occupying and attacking are not three different actions;
they are the same march, and which one happens is decided entirely by what is already standing on the
destination hex.

```
MoveSoldiers(fromCoord, toCoord, count)
```

**Requirements** (all validated by the engine; violating any of them rejects the action outright):

- **Phase 5 — Build.** Not Phase 4. **[DEFAULT — territory rework]**
- **Free action.** It does NOT consume the turn's one Build action (§7), and the engine sets no
  once-per-turn flag for it — a border can be reinforced *and* probed in the same Phase 5, as often
  as a player has Soldiers standing in position to do it.
- `fromCoord` must hold **your** Soldiers. Not "a tile you own" — *your troops*. A stack camped on
  ground you have taken but do not yet own can keep advancing from there (see `garrisonOwnerOf`,
  Data Model §3a).
- `toCoord` must be **adjacent** to `fromCoord` (sharing a hex edge) and must be a **placed tile**.
  Soldiers move one hex per march and cannot march off the edge of the map.
- `count` must be positive and no larger than the Soldiers standing on `fromCoord`. Whatever is not
  committed stays behind and is not involved in the battle.
- **At least `MIN_SOLDIERS_LEFT_BEHIND` (= 1) Soldier must remain on `fromCoord` after the march.**
  **[DEFAULT — territory rework, Risk's classic rule]** A tile can never be marched down to zero in
  one action — `fromCoord.militiaCount − count >= 1` is required, or the action is rejected outright.
  Without this a player could empty every garrison into one all-in strike, which both trivializes
  "defend your border" (nothing would stop a tile from being left at zero) and doesn't match the
  designer's picture of the war: standing garrisons on both sides of a border, not armies that
  evaporate the instant they're needed elsewhere. This floor applies to **every** way Soldiers move —
  `MoveSoldiers` here and `DeploySoldiers` below alike (§6.3's Deploy Soldiers subsection has the
  one-tile exception).
- **No Barracks requirement of any kind** — see "What a Barracks does now" below.

#### The three outcomes

**1. Destination is friendly → plain reinforcement.** The tile is yours, or already holds your
Soldiers. The stack simply grows by `count`. No dice, no combat.

> **[DEFAULT — territory rework]** Note the one wrinkle: reinforcing a tile you are *occupying but do
> not yet own* **restarts that tile's occupation clock** (see below) at the current round. The newly
> arrived troops have not themselves held the ground through a round, and the engine tracks one
> occupation date per tile, not one per soldier. Feeding troops into a contested hex every turn will
> therefore keep postponing the claim.

**2. Destination is hostile or neutral and UNDEFENDED → you occupy it.** Nobody's Soldiers are on it.
Your troops walk on and stand there. `count` Soldiers are now the tile's garrison, flagged as yours,
and the tile's **occupation clock starts** at the current round. Ownership does **not** change yet —
the tile still belongs to whoever it belonged to (or to nobody), still produces into its stockpile for
that owner, and still scores its Victory Point (§10) for them.

**3. Destination is defended by someone else → battle, immediately, on contact.** No declaration, no
separate confirmation step, no once-per-turn combat limit. The §6.3 dice below resolve the moment the
march is submitted.

- **Attacker wins** (defending units reduced to 0): the surviving attackers are now the tile's
  garrison and the occupation clock starts at the current round. **Winning the fight buys the
  ground, not the deed.**
- **Attacker is repulsed** (defenders still hold ≥ 1 unit): the surviving defenders remain, and the
  **attacker's survivors fall back to `fromCoord`** — they rejoin the stack they marched out of
  rather than evaporating. **[DEFAULT — territory rework]** A failed probe costs you casualties and
  a turn, not your entire border garrison.

#### Roll — unchanged

**Setup:** the attacker commits N Soldiers (the `count` marched); the defender has D Soldiers
standing on the destination tile. **[CANON: N = unit count]**

**Roll:** Attacker rolls N d6; defender rolls D d6 — one die per unit, no cap. **[CANON: literal
"N = unit count"]** If the defending tile has a Watchtower, add +1 to each defending die's result,
capped at 6. **[DEFAULT: Watchtower bonus amount — `WATCHTOWER_DIE_BONUS` = 1,
`WATCHTOWER_DIE_CAP` = 6]** The Watchtower belongs to the *tile*, so it defends whoever is currently
holding that tile — including an invader who took it from the player who built it.

**Resolution — [CANON: "Risk-style attacker/defender comparison"; DEFAULT: exact pairing rule]:**
1. Sort both sides' dice descending.
2. Pair the highest attacker die with the highest defender die, second-highest with second-highest, and so on, for `min(N, D)` pairs. Unmatched excess dice (the side with more units) are ignored. **[DEFAULT]**
3. Per pair: attacker die > defender die → defender loses 1 unit. Attacker die <= defender die (ties favor defender) → attacker loses 1 unit. **[DEFAULT tie rule]**

The Warrior's extra-combat-die perk does **not** apply here (§6.1) — these are Soldiers rolling, not
a hero. **If a hero has joined the fight (§6.3c), that is a separate exception:** the hero's own die
is computed by §6.1's formula, not this one, and DOES receive the Warrior perk exactly like any other
Fight-phase roll — only the plain per-Soldier dice above are exempt from it.

**Worked Example (the dice):** Attacker marches 4 Soldiers (4d6) onto a tile held by 3 Soldiers with
a Watchtower (3d6, +1 each, cap 6).
- Attacker rolls: 6, 4, 3, 1 → sorted: 6, 4, 3, (1 unmatched, ignored — Defender only has 3 dice).
- Defender base rolls: 5, 2, 1 → +1 Watchtower each → 6, 3, 2 → sorted: 6, 3, 2.
- Pair 1: Attacker 6 vs Defender 6 → tie → Defender wins → Attacker loses 1 unit.
- Pair 2: Attacker 4 vs Defender 3 → Attacker wins → Defender loses 1 unit.
- Pair 3: Attacker 3 vs Defender 2 → Attacker wins → Defender loses 1 unit.
- Result: the Defender still holds 1 Soldier, so the attack is **repulsed**. The attacker's 3
  survivors march back to the tile they came from; the tile does not change hands and no occupation
  clock starts.

#### Occupation, not conquest — **[DEFAULT — territory rework, hold time tuned per designer feedback]**

**This is the rule the whole system turns on.** Standing on a tile is not owning it. A tile you have
occupied becomes yours only once your Soldiers have stood on it, uncontested, through **`TERRITORY_CLAIM_ROUNDS`
= 3 full rounds** (`engine/constants.ts`) — checked at the start of your own Phase 0 each round:

```
at the start of your Phase 0 (§2), for every tile T:
    if T.ownerId != you
       and the Soldiers on T are yours
       and T.occupationSinceRound is set
       and currentRound >= T.occupationSinceRound + requiredRounds:   # see below for requiredRounds
           T.ownerId = you        # the flag finally changes
```

**[DEFAULT — balance rework pass 4, direct request]** `requiredRounds` is **`CAPITAL_CLAIM_ROUNDS` = 5**
when `T` carries a `Building` of type `'Capital'` (i.e. it's someone's Capital tile, occupied or not —
the check is on the building, not on who currently holds it), and the ordinary **`TERRITORY_CLAIM_ROUNDS`
= 3** for every other tile. A Capital genuinely holds out longer than a Farm: since Capital Conquest
(§11) makes settling THIS one claim an instant win for the whole game, its defender earns a wider
window to notice the invasion and march back before it's over — not the same three-round grace period
as losing a single tile of income.

**[DEFAULT — territory rework, tuned per designer feedback: was effectively 1 round]** At 1 round, a
raid could plant a flag and walk away with the deed almost immediately — a defender had exactly one
turn to notice and react before it was permanent. 3 (5 for a Capital) gives the defender real time to
notice an incursion and march back before it's permanent, which is the whole point of occupation being
a process rather than an instant capture. Because every seated player takes exactly one turn per round,
an ordinary tile taken on your turn in round *N* is not claimed until the start of your turn in round
`N + 3` (a Capital: `N + 5`) — and **every rival gets that many turns of their own in between**
(2 for an ordinary tile, 4 for a Capital — not just one) to march Soldiers back onto the hex and fight
you for it before the deed ever transfers. Nothing about the game is decided by a single dice roll on a
single turn any more; taking ground means taking it *and holding it in front of everyone, for a while*.

Consequences worth stating plainly:
- Until the claim lands, the tile still counts as its old owner's for **Victory Points** (§10),
  **production** (§2a) and **road connectivity** (§7.7). An invader gets nothing but the ground under
  their feet.
- If the occupier is driven off before their next turn, the occupation simply never happened —
  there is nothing to undo.
- **Capturing a Capital still eliminates its owner**, exactly as before — but as of balance rework
  pass 4 it now ALSO ends the whole game immediately in the invader's favor (§11's Capital Conquest).
  Both fire at the moment the claim settles, not at the moment the battle is won — so a player whose
  Capital is standing under enemy troops has `CAPITAL_CLAIM_ROUNDS` (5) full rounds of everyone else's
  turns to take it back before it's over, not the ordinary tile's 3.
- **Reinforcing a tile you're occupying but don't yet own resets its clock.** Any successful march
  onto a non-owned destination — including piling more of your own Soldiers onto ground you're already
  standing on — sets `occupationSinceRound` to the *current* round, not just the first one. Feeding
  troops into a contested hex every turn to keep it safe therefore keeps postponing your own claim to
  it; the wait (3 rounds, or 5 for a Capital) only counts down from whichever march was most recent.

**Worked Example (the timeline, `TERRITORY_CLAIM_ROUNDS` = 3):** Round 6, Blue's turn, Phase 5. Blue
marches 4 Soldiers onto Red's undefended Farm tile — `occupationSinceRound = 6`. The Farm is occupied
but still Red's: Red's Phase 3 every round until the claim settles still accumulates its Food, and Red
still scores its VP. The claim can't land before `currentRound >= 6 + 3 = 9`, so Red gets **two full
rounds (7 and 8)**, not just one, to march Soldiers back and fight for the Farm — say Red marches
5 Soldiers back onto it at any point in round 7 or 8, and the §6.3 dice resolve on contact. If Red
wins, Blue's invasion is over and Red never lost the tile at all. If Red never contests it, Blue's
Phase 0 in round 9 finally reads `currentRound (9) >= occupationSinceRound (6) + 3` — the Farm becomes
Blue's, complete with the building on it. (If Blue had instead marched *more* Soldiers onto the
already-occupied Farm at, say, round 7 to shore it up, that resets `occupationSinceRound` to 7 and the
claim now can't land before round 10 — reinforcing a raid you're not in a hurry to formalize costs you
time, not just Soldiers.)

#### What a Barracks does now — **[DEFAULT — territory rework]**

**A Barracks only unlocks recruitment.** That is the whole of it. Specifically, a Barracks:

- grants **no** attack privileges — attacks are marches, and any Soldier anywhere can make one;
- is **not** a launch point — there is no "attack from" tile, and the engine reads the attacker's
  troops from wherever they are standing;
- imposes **no adjacency rule whatsoever** — being next to a Barracks, your own or anyone's, means
  nothing to combat;
- confers no defensive bonus (that is the Watchtower's job, and it applies to whoever holds the
  tile).

What it does do is passively **recruit into its own tile** each round, as part of §2a's production
step, at a rate that scales with how much ground its owner holds:

```
recruits = max(SOLDIERS_PER_BARRACKS_MIN, floor(ownedTileCount / SOLDIERS_PER_TILES_DIVISOR))
         = max(1, floor(ownedTiles / 3))                      # soldiersPerRoundFor()
tile.militiaCount = min(BARRACKS_RESERVE_CAP, tile.militiaCount + recruits)   # cap 9
```

**[DEFAULT — territory rework: replaces the flat +3/round]** Reinforcements scale with territory,
Risk-style. A flat rate meant a sprawling empire and a three-tile holdout fielded identical armies,
which is exactly the coupling Risk uses reinforcements to express: **holding more ground should BE
the military advantage.** The floor of 1 keeps a Barracks from ever being literally idle; 12 owned
tiles yields 4/round, 27 yields 9. `BARRACKS_RESERVE_CAP` (**9**, lowered 15 → 9 in pass 2) still
bounds what can pile up on the Barracks tile itself — since recruitment is automatic, can't be
declined, and is billed by upkeep whether or not anyone deploys it, that cap is really a bound on a
*forced recurring bill*. At 15 a single Barracks compounded to 5 upkeep groups = 10 food-equivalent
units per round (§6.3a), far more than the tier-1 Cow Stable meant to service it (1 Meat = 2 units)
could offset, and a measured sweep showed it draining every player's Food to zero every turn — which
in turn starved hero level-ups (§7.4) so thoroughly that no hero leveled once all game.

**Recruitment throttle — [DEFAULT — balance rework pass 2, unchanged by pass 3]** A Barracks recruits
in a given round **only if the player can currently afford the upkeep bill of the army they already
have.** At the moment §2a's production step reaches the Barracks tile:

```
currentArmy   = sum(tile.militiaCount for tile in player.ownedTiles)   # before this round's recruits
onHand        = player.wallet.Food + player.wallet.Meat * MEAT_UPKEEP_VALUE
if onHand >= soldierUpkeepUnits(currentArmy):
    tile.militiaCount = min(BARRACKS_RESERVE_CAP, tile.militiaCount + soldiersPerRoundFor(ownedTiles))
# otherwise: no recruits this round. Nothing is queued, owed, or refunded.
```

`soldierUpkeepUnits(count)` is the same shared helper §6.3a's bill uses (exported from
`engine/constants.ts`), so the throttle and the charge can never disagree about what an army costs.
The check reads the **wallet only** and measures the army *before* the new recruits, not after — a
solvent player therefore always keeps growing, and only a player who already can't feed their troops
stops. Note the throttle counts the army standing on **tiles the player owns**, while §6.3a's bill
counts the player's troops **everywhere**, so an expeditionary force abroad is billed but does not
itself hold recruitment back.

Why the throttle exists: production is automatic and cannot be declined, so without it a Barracks
churned Soldiers straight into a famine. A measured sweep found desertion events routinely
**outnumbering successful upkeep payments 2:1** — a recruit-starve-desert cycle that drained every
player's Food to zero every round and starved the rest of the game (buildings, Capital tiers, hero
level-ups) alongside it. Gating on the current bill makes the Barracks self-regulating, and it reads
the way a player would expect: your barracks stops taking recruits when you can't feed the troops
you have.

#### Deploy Soldiers — still here, and still not an attack

**Deploy Soldiers** (Phase 5, free — it does NOT consume the turn's one Build action, §7) is the
*interior* logistics action: it lifts Soldiers out of a Barracks tile's reserve and drops them onto
**the Barracks tile itself, or one hex out**.

```
DeploySoldiers(fromCoord, toCoord, count)
    # fromCoord: a tile you own, with a Barracks, whose GARRISON is yours, holding a reserve >= count
    # toCoord:   the Barracks tile itself, or an ADJACENT tile you own
    #            (fromCoord === toCoord is a harmless no-op — "leave them at the Barracks")
    fromCoord.militiaCount -= count
    toCoord.militiaCount   += count
```

**[DEFAULT — direct report] Soldiers do not teleport.** This action originally allowed *any* owned
tile as the destination, any distance away — fresh recruits assigned to a posting, no physical march
implied — but that let a single Barracks reinforce a tile clear across the map in one free action, the
same complaint a `MoveSoldiers` teleport would draw. It is now the Barracks tile itself (`sameTile` —
the recruits just stay where they trained) or one hex out, the same physical reach `MoveSoldiers` has.
To reach further than one hex, Deploy to the Barracks's own tile (or an adjacent one) and then let
`MoveSoldiers` carry them the rest of the way, one hex per Phase 5 across however many turns it takes.

**[DEFAULT — territory rework, Risk's classic rule] The same `MIN_SOLDIERS_LEFT_BEHIND` floor (= 1)
applies here too**, whenever the destination is *not* the source tile: deploying to any adjacent tile
must leave at least 1 Soldier behind in the Barracks reserve. Deploying to `sameTile` is exempt — the
count nets to the same `militiaCount` either way, so there's nothing to "leave behind" from.

**[BUG FIX — territory rework] The reserve belongs to whoever *garrisons* the Barracks, not whoever
owns the ground under it.** An occupied Barracks still recruits (§6.3, "What a Barracks does now") —
and those recruits are the occupier's. `fromCoord`'s garrison (`garrisonOwnerOf`, Data Model §3a) must
be the actor, not merely `fromCoord.ownerId`; otherwise the rightful owner of an occupied Barracks
could "deploy" an invader's own reserve as if it were theirs, walking off with a free enemy army
without so much as a `MoveSoldiers` march to win it. Symmetrically, `toCoord` must not currently hold
a *rival's* occupying garrison — reinforcements deploying onto a tile you own but a rival's Soldiers
are standing on would otherwise silently donate fresh troops to that garrison; retake the tile with
`MoveSoldiers` first.

The division of labour between the two actions is worth memorizing:

| | Deploy Soldiers | Move Soldiers |
|---|---|---|
| Source | a Barracks tile whose garrison is yours | any tile your Soldiers stand on |
| Destination | the Barracks tile itself, or **one adjacent tile you own** | an **adjacent** placed tile, anyone's |
| Leaves `MIN_SOLDIERS_LEFT_BEHIND`? | yes, unless `toCoord === fromCoord` | yes, always |
| Crosses a border? | never | that is its entire purpose |
| Can start a fight? | no | yes, on contact |
| Phase / cost | Phase 5, free | Phase 5, free |

So Deploy gets a fresh reserve moving toward whichever frontier needs it, one hop from the Barracks,
and Move is what carries it the rest of the way and what happens once it's there. Every Soldier the
player controls — garrisoned, still sitting in a Barracks reserve, or camped on foreign ground — costs
upkeep every round; see §6.3a. And however large that army gets to be in the first place is capped by
how much water the player controls — see §6.3b.

### 6.3a Soldier Upkeep

**[DEFAULT — balance rework, new mechanic]** Once per player-turn — automatically, at that
player's Phase 0 (§2), no player action involved — the engine totals every Soldier the player
**owns**: every garrison of theirs, plus any still-undeployed Barracks reserve. An army eats whether
or not its owner got around to deploying it.

**[DEFAULT — territory rework]** The bill follows the **troops**, not the border. Soldiers are
counted wherever they are standing, **including an invasion force parked on ground somebody else
still owns**. Scanning owned tiles instead would let an army live rent-free the moment it crossed a
frontier, which is precisely the moment sustaining it should be most expensive — and, symmetrically,
enemy troops squatting on *your* tile are not on *your* payroll. Whose Soldiers a tile's
`militiaCount` represents is answered by `garrisonOwnerOf(tile)` (Data Model §3a), never by the
tile's owner.

```
totalSoldiers = sum(tile.militiaCount for every tile where garrisonOwnerOf(tile) == player)
groups        = ceil(totalSoldiers / SOLDIER_UPKEEP_GROUP_SIZE)     # SOLDIER_UPKEEP_GROUP_SIZE = 3
needed        = groups * SOLDIER_UPKEEP_FOOD_PER_GROUP              # food-equivalent units; SOLDIER_UPKEEP_FOOD_PER_GROUP = 2
```

A partial trailing group (1 or 2 extra Soldiers beyond the last full group of 3) still costs a
full group's bill. The bill is paid **from the wallet only** — carried resources on a hero, or a
tile's own uncollected stockpile, do not count; they must be deposited first (§7.6) — in Meat
(`MEAT_UPKEEP_VALUE` = 2 units each) and/or Food (1 unit each), combinable in any mix. **[DEFAULT —
balance rework pass 2] Meat is spent FIRST**, and Food covers only whatever remains:

```
remaining = needed
meatUse   = min(player.wallet.Meat, floor(remaining / MEAT_UPKEEP_VALUE))   # Meat first
remaining -= meatUse * MEAT_UPKEEP_VALUE
foodUse   = min(player.wallet.Food, remaining)                              # Food for the rest
remaining -= foodUse
# Rounding guard: one leftover unit that Food couldn't reach may be covered by one more Meat,
# overpaying by a unit rather than deserting Soldiers over an odd remainder. (Unreachable while
# `needed` is always even, i.e. groups * 2 — it exists so the arithmetic stays safe if
# SOLDIER_UPKEEP_FOOD_PER_GROUP is ever retuned.)
if remaining > 0 and player.wallet.Meat > meatUse:
    meatUse   += 1
    remaining -= MEAT_UPKEEP_VALUE
shortfall = remaining
```

If `shortfall <= 0`, the wallet pays `foodUse` Food and `meatUse` Meat and an `SoldierUpkeepPaid`
event is logged — nothing else happens. If the wallet can't fully cover the bill, **every** Food
and Meat the player holds in the wallet is spent trying, and enough Soldiers desert to fit what
was actually affordable:

```
paidEquivalent      = player.wallet.Food (all of it) + player.wallet.Meat (all of it) * MEAT_UPKEEP_VALUE
sustainableSoldiers  = floor(paidEquivalent / SOLDIER_UPKEEP_FOOD_PER_GROUP) * SOLDIER_UPKEEP_GROUP_SIZE
desertions           = max(0, totalSoldiers - sustainableSoldiers)
```

Desertions are trimmed from the player's **largest garrison first** (ties broken deterministically
by map order; an occupying force abroad is just another garrison and can desert like any other,
which may hand a contested tile straight back), continuing to the next-largest until the desertion
count is used up — a
starving army thins its biggest camps before its smallest outposts. A `SoldiersDeserted` event is
logged with the totals. Both events fire regardless of `totalSoldiers` being 0 for a given
player — except upkeep is skipped entirely (no event) when a player controls zero Soldiers.

**[DEFAULT — balance rework pass 2]** Why Meat goes first: pass 1 charged Food first and Meat for
the remainder, and pass 2 reversed it. **Meat has exactly one use in the entire game — feeding
Soldiers** — while Food also buys buildings (§7.1), building upgrades (§7.1a), Capital tiers (§7.3)
and hero level-ups (§7.4). Charging the multi-purpose currency first meant a standing army quietly
drained the wallet to zero every single turn, and a measured all-AI sweep showed the downstream
effect plainly: heroes banked XP and earned level-ups they could then never pay for, so nobody
leveled past Level 1 all game and the whole Munchkin progression stalled behind the army economy.
Spending the single-purpose resource first is both strictly better play and what a player would
naturally expect, so the engine now does it for them rather than quietly punishing anyone who didn't
think about it.

**Worked Example:** Player has 11 Soldiers total (a Barracks reserve of 5, plus garrisons of 4 and
2 on two other owned tiles). `groups = ceil(11/3) = 4`, `needed = 4*2 = 8` food-equivalent units.
Wallet holds 3 Food and 1 Meat. Meat goes first: `meatUse = min(1, floor(8/2)) = 1`, covering
`1*2 = 2` units and leaving 6. Food covers `min(3, 6) = 3` more, leaving 3 → `shortfall = 3`. Both
Food and Meat are spent to zero. `paidEquivalent = 3 + 1*2 = 5`,
`sustainableSoldiers = floor(5/2)*3 = 2*3 = 6`, `desertions = 11 - 6 = 5`. Trim from the largest
garrison first: the 5-Soldier Barracks reserve loses all 5 before either the 4- or 2-Soldier
garrison is touched, leaving the player with 6 Soldiers total (0 in reserve, 4 and 2 still
garrisoned).

### 6.3b Troop Cap — **[DEFAULT — direct request]**

A player's **total** Soldier count — every tile they garrison anywhere (`garrisonOwnerOf`, Data
Model §3a; the same basis §6.3a's upkeep bill uses, NOT merely tiles they own) — can never exceed a
cap that scales with how many **River tiles** the player controls:

```
troopCapFor(waterTileCount) =
    25   if waterTileCount == 0    # TROOP_CAP_BASE
    100  if waterTileCount == 1
    150  if waterTileCount == 2
    175  if waterTileCount == 3
    200  if waterTileCount >= 4    # TROOP_CAP_MAX, holds flat from here on
```

River tiles produce no resource of their own (§1/§2a: `TILE_RESOURCE.River` is null) — **this cap is
their entire value proposition.** Owning even one jumps the ceiling 4×, from 25 to 100; a second and
third push it to 150 and 175; a fourth and beyond hold it flat at 200. That is a deliberately much
bigger lever than any incremental economy building, so that securing water is a real strategic
choice — worth fighting over, worth a Dock and boat movement (§4.3) to actually reach — rather than a
rounding error next to one more Quarry.

**Enforcement:** the cap is checked in exactly one place — Barracks recruitment
(§6.3, "What a Barracks does now"), the sole point where a new Soldier is ever created. A round's
`recruits` is clamped to `max(0, troopCapFor(waterTiles) − currentArmy)` before it's added to the
Barracks reserve; every other action that touches `militiaCount` (`DeploySoldiers`, `MoveSoldiers`,
desertion) only moves or removes Soldiers that already existed, so none of them can push the total
above whatever was already legal at recruitment time. A player already sitting at or above their cap
(for instance, after losing a River tile that had been backing a larger army) simply stops recruiting
until either their army shrinks back under the new, lower cap or they reclaim enough water to raise it
again — existing Soldiers are never forcibly deserted for being over a cap that only just dropped.

### 6.3c Hero Battle Participation — **[DEFAULT — hero battle participation, direct request]**

A hero can put itself on the line in an Army vs Territory fight without ever leaving the same
`MoveSoldiers` action that started it (§6.3's own trigger section, above).

**Joining.** The attacker opts in with two new optional fields on that same action:

```
MoveSoldiers(fromCoord, toCoord, count, heroId?, heroJoins?)
```

`heroJoins: true` has the named hero (or the player's primary hero, by the same default-to-primary
convention every other action uses, if `heroId` is omitted) lend its own die to the fight — **but
only if that hero is physically standing on `fromCoord`**, the tile the march is departing from;
otherwise the action is rejected outright. The hero's own position is never touched by this — win,
lose, or never get a pairing at all, the hero stays exactly where it was standing. Moving a hero is
still only ever `MoveHeroAction`'s job (§4), a separate action in a separate phase.

A **defending** hero needs no flag at all. It joins automatically just by being physically present on
`toCoord`, the tile under attack, the moment the march lands — symmetric with how Army vs Territory
itself already triggers on contact rather than a declaration. Ignored entirely on an uncontested move
(plain reinforcement or unopposed occupation) — there is nothing to fight.

**The roll.** A joining hero's die is computed by the *exact same formula* every other Fight-phase
roll uses (§6.1): `d6 + hero.level + hero.attack + gearBonus`, including the Warrior's
2d6-keep-highest perk if that hero has it (see the note in §6.3's Roll subsection above). §6.3's own
per-Soldier dice are unaffected either way — only a joining hero's own die uses the richer formula.

That single die is added to its side's pool of dice **before** the sort-and-pair step §6.3 already
runs, as one extra entry — not substituted for a Soldier's. Three consequences fall out of that:

- **The hero is never counted as a unit.** Its die can win or lose its own pairing, but that pairing
  never changes `attackerLosses`/`defenderLosses` — a hero fighting alongside an army can't save or
  cost it a single Soldier either way. A win or a loss here is paid, or earned, in the hero's own
  XP/HP, nothing else.
- **A hero doesn't always get a pairing at all.** Because the hero's die only ever ADDS to its side's
  pool rather than replacing anything, it can do one of two things: claim a brand-new pairing against
  an enemy die that would otherwise have gone unmatched (if the enemy fields more units than this side
  already had), or compete for a pairing this side's dice were already contesting, on equal terms with
  them. If this side's own troop dice already outrank the hero's roll and there was no spare enemy die
  left to open a new slot, the hero's die is never compared to anything this fight — no pairing, no
  risk, no reward. A large enough army can fight an entire skirmish without ever putting its hero on
  the line.
- **Ties still favor the defender** (§6.3's own tie rule, unchanged) — so a defending hero's own
  worst-case roll can never lose to an attacking Soldier's own best-case roll at identical stats; the
  defender only ever loses a pairing it is genuinely out-rolled on.

**Winning a pairing:** the hero gains a flat **2 XP** (`HERO_BATTLE_XP_ON_WIN`) — deliberately modest
next to a Monster kill's level-scaled reward (§6.1), because a Risk skirmish is a frequent, low-stakes
event, not a deliberate Door-card hunt. Nothing changes on HP either way on a win.

**Losing a pairing:** the hero takes HP damage scaled to how badly it lost —
`max(2, winningRoll − losingRoll)` (`heroBattleDamage`, floor = `HERO_BATTLE_DAMAGE_FLOOR` = 2). Even
a near-tie loss still stings, and getting blown out by a much stronger roll hurts proportionally
more — the same "bigger threat, bigger consequence" shape as §6.1's damage-equals-monster-level rule,
just derived from the winning roll instead of a fixed monster stat, since there is no monster card to
read a level off of here.

**HP reaching 0 this way is PERMANENT — not the §6.1a "downed" rule.** A hero whose HP is driven to 0
or below by losing its own Army vs Territory pairing does not retreat and heal. It is replaced
outright by a completely fresh Level 1 hero (`freshHeroState` in `engine/selectors.ts` — the same
factory that builds every hero's starting body, including at spawn) — Level, XP, gear, equipped Loot,
carried Loot, and active curses are all gone, exactly as if this were a brand-new character. What the
fresh hero DOES still carry is whatever the *player* has already permanently invested, independent of
any one hero's body: the player's class bonus (a Farmer's max-HP bonus, a Warrior's starting weapon
bonus), every Town tier's HP bonus the player has already reached (§7.3), and a built Dock's boat
unlock (§4.3) — those are the player's own standing investments, not "the last hero's skills," so they
carry over onto the replacement exactly as they would onto any freshly-spawned hero. The replacement
spawns at the player's Capital tile, at full HP.

**Worked Example:** A Level 2 hero (Attack 1, no gear, 1 HP remaining from an earlier fight) joins an
attack with `heroJoins: true`. Its die comes up `1d6 = 3`, for a total of `3 + 2 + 1 + 0 = 6`. The
defending tile's lone Soldier also rolls `6` — a tie, which favors the defender (§6.3) — so the hero
loses its pairing. Damage is `max(2, 6 − 6) = 2` (the floor, since the margin itself was 0). The
hero's 1 remaining HP can't absorb 2 damage: HP reaches 0, triggering **permadeath**. The player's
hero slot is immediately replaced by a fresh Level 1 hero at the player's Capital tile, at full HP,
carrying only the player's class and Town-tier bonuses — no XP, gear, or Loot survives the loss.

See `docs/game-design.md` §6 for why this trade-off — a real, permanent-loss risk in exchange for a
second axis of value for a leveled, geared hero — is the shape this feature was built to have.

### 6.4 The Door Deck — Munchkin Exploration Layer — **[DEFAULT — Munchkin exploration layer, new subsystem]**

**This section covers a new system end to end.** It sits procedurally across three phases at once —
its *trigger* fires during Phase 2 (Move Hero), its *mandatory consequence* is resolved in Phase 4
(Fight), and its reward is the same Treasure/Loot system §9 already documents — so, like §6.3 before
it, it lives here in the Fight chapter because the fight is the part of it that matters most, with
cross-references to the other two phases below.

#### The trigger — arriving somewhere new

The **first time** a hero's Move Hero action *ends* on a hex it has never stood on before, something
is behind the door. Every `HeroState` tracks a `visitedTiles` list (Data Model §7), seeded at spawn
with the hero's own Capital tile (spawning there is not a fresh arrival), and `applyMoveHero` checks
only the **final destination** of that turn's one consolidated move path against it:

```
resolveDoorCardIfNewTile(hero, destination):
    if hexKey(destination) in hero.visitedTiles: return   # been here before — nothing happens
    hero.visitedTiles.push(hexKey(destination))
    draw the next card from GameState.doorDeck
    ... resolve it (see below)
```

**Only the destination counts, not the tiles merely passed through.** A hero whose move path crosses
three brand-new hexes to reach a fourth doesn't trigger three draws and then a fourth — only arriving
and *stopping* somewhere new opens a door. This matches the physical game's framing (you open the
door of the room you walk into, not every room you glance through on the way) and keeps a single Move
Hero action, however long, to at most one Door draw.

#### One combined deck, not two

`GameState.doorDeck` is a **single shuffled pile mixing Monster and Utility cards together** — as of
this pass, `engine/catalogs.ts` stocks it with 56 Monster cards (drawn from 40 unique monster
templates, target ~40) and 35 Utility cards (target ~35), for 91 cards total; see that file for the
exact current roster and `docs/data-model.md` §6/§6a for the card shapes. **This is one deck by
design, not two decks the engine happens to draw from in sequence** — it mirrors exactly how the
physical Munchkin game shuffles its monsters and its non-monster cards into a single Door pile rather
than dealing separately from each. A player never knows, opening a door, whether they're about to
fight or merely find something — that uncertainty *is* the beat.

The Monster half **reuses the same roster** that stocks the Ruins/Dungeon Monster deck (§6.1) —
`buildDoorCatalog()` calls the exact same `buildMonsterCatalog()` a Ruins Den's deck is built from —
rather than maintaining a parallel monster list. This is safe because a `MonsterCard` is an immutable,
id-keyed lookup with no per-instance mutable state: the same monster (by name and level) can
legitimately be "in play" simultaneously as a Ruins Den guardian on one tile and a freshly-drawn Door
encounter on another, because `Tile.monsterDenCardId` and `GameState.pendingDoorMonster` are two
completely independent positions referencing the same static catalog. The Door deck and the Ruins
Monster deck are still built and shuffled as **two separate piles** at game start (`buildMonsterDeck`
and `buildDoorDeck` each shuffle their own copy) — defeating a monster in one does not remove it from
the other.

Unlike the Loot deck (§5.3/§9), the Door deck **does recirculate**: a resolved card (fought, win or
lose; or an immediately-resolved Utility) goes back to its discard pile rather than being kept, so
genuine exhaustion — both piles momentarily empty at the exact instant of a draw — should be rare. If
it does happen, the draw simply resolves to **no encounter at all**: a legal, if unlikely, outcome
of arriving somewhere new, the same defensive "return null rather than crash" contract `drawLoot`
already established.

#### Three outcomes

1. **Monster.** Sets `GameState.pendingDoorMonster = { heroId, coord, monsterCardId }` and logs a
   `DoorCardDrawn` event. Nothing else happens immediately — see "The mandatory fight" below.
2. **Utility.** Resolves **immediately**, right where the draw happens (no player choice, no waiting
   for Phase 4) — a Door boon is never something the player decides whether or when to engage with.
   The effect is drawn from `UtilityEffectKind`'s small **closed set** (Data Model §6a) so that many
   flavorful cards share a handful of reducer branches instead of each needing bespoke logic:
   - `GainWood` / `GainStone` / `GainFood` / `GainOre` / `GainMeat` / `GainGold` — adds `amount`
     of that resource straight into the hero's **carried inventory** (§5.1's carry-capacity cap is
     NOT enforced here — a Door windfall is never rejected for lack of room, unlike a Gather action).
   - `HealHp` — restores `amount` HP, capped at the hero's max.
   - `DamageHp` — the hero takes `amount` HP damage (via the same path a lost Monster fight or a Bad
     Stuff card uses — HP cannot go negative; heavy damage can send the hero home to respawn at their
     Capital exactly as a Monster-fight loss would).
   - `GainXp` — grants `amount` XP directly, no fight required.
   - `FreeTreasure` — draws **1 Common-rarity** Loot card with no fight at all (Munchkin's "it's a
     small treasure, no monster" card) — deliberately capped at Common, never the escalating
     Uncommon/Rare/Legendary rarities a monster kill can pay out.
   - `Nothing` — pure flavor ("the door was stuck"); not every draw needs to be mechanically loaded.
   The card then goes to `doorDeck.discardPile` and a `DoorCardDrawn` event is logged with the
   resolved effect.
3. **Deck momentarily exhausted.** No card, no event, no encounter (see above) — vanishingly rare
   given the deck recirculates.

#### The mandatory fight, and its exemption from the once-per-Phase-4 cap

A drawn Monster is **not optional**. `GameState.pendingDoorMonster` being non-null for the acting
player's hero:

- **Blocks leaving Phase 4.** `applyAdvancePhase`'s Fight → Build transition is refused while it's
  set — Phase 4 is the last chance to fight it, since phases only move forward.
- **Blocks ending the turn at all**, from *any* phase, via the same guard
  (`requireNoPendingDoorMonster`) that gates the Phase 4 → Build step above — an `EndTurn` shortcut
  can't be used to walk away from an open door either.
- **Is exempt from the "one combat resolution per Phase 4" cap** (§6's intro). It's a forced encounter
  the hero didn't choose, not a discretionary one, so it doesn't compete with — and isn't blocked by —
  a Ruins Den fight, a PvP duel, or a Volcano tame the hero also resolves that same Phase 4. A hero can
  legally resolve **two** Monster fights in one Phase 4 if both a discretionary one and a pending Door
  monster are on the table (see the Ruins interaction below for exactly when that happens).

**Resolving it** uses the *exact same action shape* a Ruins Den fight uses — `{ type: 'Fight',
combatType: 'HeroVsMonster', coord, monsterCardId }` — and the exact same dice math (§6.1's roll,
threshold, win/lose rewards). `applyFightMonster` accepts either source and tells them apart by which
one matches: `coord`+`monsterCardId` against the tile's `monsterDenCardId` (a Ruins Den), or against
`GameState.pendingDoorMonster` for that hero (a Door monster). The hero must be standing exactly on
`coord` to fight a Door monster — the Mage's ranged pre-emptive-strike perk (§6.1, "adjacent to a
Ruins Den") does **not** extend to a Door monster, because a Door card is drawn on arrival, so the
hero is always already standing on it; there is no "seeing it from next door" to have a ranged option
about.

**On resolution — win or lose, either way** (unlike a Ruins Den, which only clears on a win): XP/HP/
Loot/Bad-Stuff resolve exactly per §6.1, `pendingDoorMonster` is cleared, and the card returns to
`doorDeck.discardPile`. A Door monster is a passing encounter, not a permanent guard — there's nothing
left standing on the tile afterward the way an undefeated Ruins Den keeps guarding until it's beaten.

#### Interaction with a Ruins Den — both exist, independently

**Nothing about a Ruins tile's guaranteed Monster Den changes.** §6.1's rule stands exactly as
written: a Ruins tile draws and permanently assigns its own Monster Den card **at placement time**
(Phase 1, `applyPlaceTile`) — before anyone has ever set foot on it, and completely independent of
whether or when a hero ever does.

**The Door draw is a separate, additional check that fires on arrival**, per the trigger rule above,
at **any** first-visited tile — Ruins included. Landing on a Ruins tile nobody has ever visited before
therefore checks *two* completely independent things at once: the Den that's been sitting there since
the tile was placed (`tile.monsterDenCardId`, drawn from the Ruins/Monster deck), and a brand-new Door
card (drawn from the separate Door deck, described above). These can both come up Monster — with
**different** `monsterCardId`s, from two different decks — and if they do, Phase 4 offers the hero two
distinct fights on the same hex in the same turn: the Ruins Den (discretionary, uses up the turn's one
Fight-phase slot) and the Door monster (mandatory, exempt from that slot per the section above). Either
may be fought first; because the Door monster is exempt from the cap the Ruins fight consumes, **both
can be fought in the same Phase 4.** If the Door draw instead comes up Utility, it already resolved
automatically back in Phase 2, and only the Ruins Den's own fight remains as Phase 4's one
discretionary option.

#### Treasure is the Loot system, expanded and doing double duty

**"Treasure" is not a new deck.** A won Door monster fight draws from `GameState.lootDeck` exactly the
way a Ruins Den win does — same `drawLoot` call, same rarity brackets keyed to the defeated monster's
level (§6.1's table) — and a `FreeTreasure` Utility card draws from the same deck at a flat Common
rarity. The Loot catalog (`engine/catalogs.ts`) was expanded specifically to carry this added draw
volume without running dry early: it now totals **60 cards** (21 Common, 16 Uncommon, 13 Rare, 10
Legendary — target ~60), up from the 31 documented in §5.3, which still covers the exhaustion contract
(`drawLoot` returns `card: null` on a genuinely empty rarity, and every draw site — a Monster win, a
Loot Ruins Gather, a Volcano tame, and now a Door-deck win or `FreeTreasure` — resolves normally but
empty-handed when that happens). See §5.3 and §9 for the rarity/exhaustion rules themselves, which
this section doesn't change — only the number of things now drawing from the same pool.

---

## 7. Phase 5 — Build

**[CANON: phase name]** The active player takes exactly one Phase 5 action: EITHER construct one building, OR apply one earned hero level-up (§8), OR advance one eligible building one step up its upgrade track (§7.1a). **[DEFAULT: mutual exclusivity, since canon phrases both as "spend resources to... or...".]** **[DEFAULT — balance rework: added the third option]** Building Upgrade is a full Phase 5 action, not a free one — same footing as constructing a new building. **[DEFAULT — balance rework pass 2]** One action buys exactly **one tier**, so a Cow Stable's climb from tier 1 to tier 5 costs four separate Phase 5 actions across four separate turns — the upgrade track is a sustained commitment, not a single purchase. Equipping/unequipping already-owned Loot cards into the hero's gear slots is a free action, not restricted to Phase 5 and not counted against this one-action limit. **[DEFAULT]**

**Free actions that also live in Phase 5** — none of these consume the one Build action, and none of
them is capped at one per turn:

| Free action | Gating | Cost | Rule |
|---|---|---|---|
| **Deploy Soldiers** — Barracks reserve → the Barracks tile itself or one adjacent tile you own | Phase 5 | none | §6.3 |
| **Move Soldiers** — march one hex; reinforce, occupy, or attack | Phase 5 | none | §6.3 |
| **Build Road** — one segment along one tile edge | **not phase-gated at all** — any point in your own turn | 1 Wood | §7.7 |
| **Equip / Unequip Loot** | not phase-gated | none | §7.4 |
| **Deposit Resources** — at your Capital | not phase-gated | none | §7.6 |

**[DEFAULT — territory rework]** Move Soldiers being free and uncapped is deliberate: a frontier that
could only be adjusted once per turn, at the cost of the turn's construction, would not be a frontier
anybody bothers to man. Marching is manoeuvre, not investment.

Every cost below (buildings, building upgrades, Capital tiers) can draw from **two pools** — see §7.6 for exactly how they combine. Hero Level-Up (§7.4) has no tile of its own and is always paid from the wallet. Deploy Soldiers and Move Soldiers have no resource cost at all — they only reposition Soldiers that already exist.

### 7.1 Building Cost Table — restated exactly from canon **[CANON]**

Effects and rates below are the building's **tier-1** state; see §7.1a for upgrade tracks and §7.1b
for the round each building unlocks.

| Tile Type | Building | Effect | Cost |
|---|---|---|---|
| Forest | Sawmill | +1 Wood/turn; not before Round 3 § | 5 Wood + 3 Stone ✦ |
| Forest | Hunting Lodge | +1 Food/turn; hero gains +1 XP on first hunt each round; not before Round 5 § | 4 Wood + 2 Food ✦ |
| Hills | Quarry | +1 Stone/turn; not before Round 4 §; upgradable through tier 3 to +3/turn (§7.1a) † | 5 Stone + 3 Wood ✦ |
| Plains | Farm | +1 Food/turn; not before Round 4 §; upgradable through tier 3 to +3/turn (§7.1a) † | 4 Food + 2 Wood ✦ |
| Plains | Windmill (requires Farm built first) | Converts 2 Food into 1 Gold/turn; not before Round 6 § | 4 Stone + 3 Wood ✦ |
| Plains | Cow Stable ‡ | +1 Meat/turn at tier 1 (feeds Soldier Upkeep, §6.3a); upgradable through tier 5 to +5/turn (§7.1a) † | 5 Food + 3 Wood ✦ |
| Mountain | Mine | +1 Ore/turn; not before Round 3 § | 5 Ore + 3 Stone ✦ |
| Mountain | Smithy | Crafts hero gear from Ore + Gold via `CraftGear` (§7.1c) — real as of balance rework pass 4; not before Round 5 § | 3 Ore + 2 Stone |
| Desert | Trade Post | +1 Gold/turn; unlocks 2:1 bank trade instead of default 4:1; not before Round 3 § | 4 Gold + 3 Stone ✦ |
| River | Dock | Unlocks boat movement; not before Round 3 §; produces no resource — see §6.3b for what a River tile is actually worth ¤ | 2 Wood + 1 Stone |
| Any owned tile | Watchtower | +1 to each defending die (cap 6) in territory combat, for whoever is holding the tile (§6.3); upgradable through tier 3 to +3 (cap 8) (§7.1a) ** | 2 Stone + 2 Ore |
| Plains only ‡ | Barracks | **Unlocks Soldier recruitment, and nothing else.** Recruits `max(1, floor(ownedTiles / tilesPerSoldier))` Soldiers/round into its own tile (capped at its tier's reserve cap) and only while the current army's upkeep is affordable (§6.3); move them out with Deploy Soldiers (interior) or Move Soldiers (the frontier). Confers **no** attack privilege and no adjacency rule ¶; upgradable through tier 3 for a bigger reserve and faster recruiting (§7.1a) ** | 3 Wood + 2 Ore + 5 Food ‡ |
| Starting tile only | Capital upgrade (the Town) | Increases hero max HP every tier — tier 1 is free, granted at spawn; 6 tiers total as of balance rework pass 4 (tier 6, "the Grand Bazaar," is a late-game wonder capstone); see §7.3 | Cost scales with tier |

✦ **[DEFAULT — balance rework pass 5, direct request: "make buildings more expensive .. e.g. a
sawmill .. auto collecting of resources is way too OP for early game"]** Every basic production
building's tier-1 cost roughly doubled — Smithy, Dock, Watchtower, and Barracks (already priced as
its own gate, per § below) are unchanged. See `engine/constants.ts`'s Building Cost Table for the
exact before/after on each.

**Roads** are not in this table because they are not buildings — they sit on a tile *edge*, not on a
tile. **[DEFAULT — balance rework pass 5]** Cost raised from a flat 1 Wood to 2 Wood + 1 Stone, and
roads now additionally require Capital Tier 2 — see §7.7 for the full changelog note.

† **[DEFAULT — balance rework]** Round gate and upgrade track are new; the +1/turn base rate itself
is unchanged from the original table for Farm and Quarry. **[DEFAULT — balance rework pass 2]** The
Cow Stable's tier-1 rate dropped from +3 to +1, and all three of these buildings now have a
multi-step upgrade track rather than a single tier-2 step — see §7.1a.
‡ **[DEFAULT — balance rework]** Cow Stable is an entirely new building. Barracks's tile restriction
(was "any owned tile") and cost (originally 3 Ore + 2 Food, then 3 Wood + 4 Ore + 5 Food in pass 1)
are both new — see §6.3/§6.3a/§7.2 for why. **[DEFAULT — balance rework pass 2]** Barracks's Ore
share was then halved, 4 → 2, bringing the total from 12 resources down to 10 — still roughly four
rounds of a developing economy's income, so the Barracks stays a real commitment. Ore comes only from
Mountain tiles, so an Ore-heavy price meant "no Mountain in your draws, no army, no Risk layer at
all" — the bill should measure how much you've built, not whether one specific terrain happened to
show up in your tile draws.
§ **[DEFAULT — balance rework pass 2]** Round gates — see §7.1b for the full schedule and the
reasoning. Watchtower, Barracks, Cow Stable and the Capital upgrade are deliberately ungated.
¶ **[DEFAULT — territory rework]** The Barracks's old role as the launch point for territory attacks
is **gone**, along with the rule that an attack had to originate on a Barracks tile adjacent to its
target. Recruitment is now the building's entire function, and its rate scales with owned tiles
rather than being a flat +3 — see §6.3.
¤ **[DEFAULT — troop cap rework]** Dock used to also produce +1 Food/turn; that was dropped when
River's economic role moved entirely to raising the troop cap (§1/§2a's `TILE_RESOURCE.River = null`;
§6.3b). Building a Dock is purely about reach (boat movement) now, not income.
** **[DEFAULT — balance rework pass 4]** Watchtower and Barracks each gained their own 3-tier
upgrade track — see §7.1a for the exact costs and resulting rates. Both were previously single-tier;
a mature economy having no meaningful sink for Stone/Ore(/Wood) or Wood/Ore/Food was the direct
motivation, alongside giving "defend your borders" and "field a bigger army" something concrete to
build toward.

### 7.1a Building Upgrade Tracks

**[DEFAULT — balance rework, new mechanic; generalized in balance rework pass 2]** Farm, Quarry,
and Cow Stable each define an ordered **upgrade track** — a list of tiers above tier 1, climbed one
step at a time. Every other building stays single-tier. A building starts at tier 1 (an untracked/
undefined tier is treated as tier 1); each **Upgrade Building** Phase 5 action pays the cost of the
*next* step and advances the building exactly one tier, which becomes its production rate for the
rest of the game or until upgraded again.

Pass 2 replaced pass 1's single tier-1 → tier-2 step with these tracks. Farm and Quarry gained a
second step (ending at +3/turn instead of +2); the Cow Stable was rebuilt entirely — it now *starts*
at +1 Meat/turn and reaches its +5 ceiling only at tier 5, four upgrades later.

**Quarry — 2 upgrades, maxes at tier 3**

| Step | Cost | Resulting rate |
|---|---|---|
| tier 1 (built) | — (2 Stone + 1 Wood to construct) | +1 Stone/turn |
| tier 1 → 2 | 4 Stone + 2 Ore | +2 Stone/turn |
| tier 2 → 3 | 6 Stone + 4 Ore | +3 Stone/turn |

**Farm — 2 upgrades, maxes at tier 3**

| Step | Cost | Resulting rate |
|---|---|---|
| tier 1 (built) | — (2 Food + 1 Wood to construct) | +1 Food/turn |
| tier 1 → 2 | 4 Food + 2 Wood | +2 Food/turn |
| tier 2 → 3 | 6 Food + 4 Wood | +3 Food/turn |

**Cow Stable — 4 upgrades, maxes at tier 5**

| Step | Cost | Resulting rate |
|---|---|---|
| tier 1 (built) | — (3 Food + 2 Wood to construct) | +1 Meat/turn |
| tier 1 → 2 | 3 Food + 2 Wood | +2 Meat/turn |
| tier 2 → 3 | 4 Food + 3 Wood | +3 Meat/turn |
| tier 3 → 4 | 6 Food + 4 Wood + 2 Stone | +4 Meat/turn |
| tier 4 → 5 | 8 Food + 6 Wood + 4 Stone | +5 Meat/turn |

**[DEFAULT — balance rework pass 2]** Why the Cow Stable was re-scaled: opening at +3 Meat/turn
meant one cheap Plains building covered a 9-Soldier army's entire upkeep bill (§6.3a: 9 Soldiers =
3 groups = 6 food-equivalent units = 3 Meat) the moment it was finished, so the upkeep economy pass
1 had just introduced was solved outright by a single build action. Starting at +1 and charging
four separate Phase 5 actions (plus escalating Wood/Stone) to reach +5 makes feeding an army a
sustained investment that has to scale alongside the army itself.

Upgrading costs the turn's one Phase 5 action, same as constructing a new building or applying a
hero level-up (§7) — it is NOT a free action like Deploy Soldiers, and one action buys one tier
only. It draws from the same two resource pools as a normal Build action (carried-then-wallet if
the hero stands on that tile, wallet-only otherwise — see §7.6), and is subject to the Mage
discount (§7.2) the same way, applied per step. A building already at its track's top tier, or one
with no upgrade track defined at all, cannot be targeted. Upgrading is NOT round-gated: §7.1b's
`minRound` governs when a building may first be *constructed*, not how fast it may then climb.

**[DEFAULT — balance rework pass 4]** Watchtower and Barracks gained their own tracks in this pass —
unlike the three above, what scales per tier isn't a `producesResource` rate but a defensive die
bonus and a recruitment reserve cap/rate respectively.

**Watchtower — 2 upgrades, maxes at tier 3**

| Step | Cost | Resulting effect |
|---|---|---|
| tier 1 (built) | — (2 Stone + 2 Ore to construct) | +1 to each defending die, capped at 6 |
| tier 1 → 2 | 3 Wood + 5 Stone + 3 Ore | +2 to each defending die, capped at 6 |
| tier 2 → 3 | 6 Wood + 9 Stone + 6 Ore | +3 to each defending die, capped at 8 |

**Barracks — 2 upgrades, maxes at tier 3**

| Step | Cost | Reserve cap | Recruitment rate |
|---|---|---|---|
| tier 1 (built) | — (3 Wood + 2 Ore + 5 Food to construct) | 9 | `max(1, floor(ownedTiles / 3))`/round |
| tier 1 → 2 | 6 Wood + 4 Ore + 4 Food | 15 | `max(1, floor(ownedTiles / 2))`/round |
| tier 2 → 3 | 10 Wood + 8 Ore + 8 Food | 21 | `max(1, floor(ownedTiles / 1))`/round |

A player may own more than one Barracks (one per owned Plains tile) and upgrade each independently —
the total Wood/Ore/Food sink, and the total army a player can field and feed, both scale with how
large the empire already is.

### 7.1b Build Unlock Schedule

**[DEFAULT — balance rework pass 2, new mechanic]** Every production building now carries a
**minimum round** before it may be constructed. Attempting one earlier is rejected outright — no
partial or queued construction, and no refund path, since nothing is spent.

| Round unlocked | Buildings | Rationale |
|---|---|---|
| 3 | Sawmill, Mine, Trade Post, Dock | Basic single-resource producers — the first industrial step, but not the opening move |
| 4 | Farm, Quarry | Upgradable producers whose output compounds fastest (§7.1a) |
| 5 | Hunting Lodge, Smithy | Hunting Lodge pays Food *and* feeds the hero XP engine (§5), so an early one is free income plus free leveling; Smithy's gear crafting is a mid-game power spike |
| 6 | Windmill | Second-order building — its Farm prerequisite (Round 4+) has to exist and pay out first |
| — (ungated) | Watchtower, Barracks, Cow Stable, Capital upgrade | See below |

Pass 1 had gated only Farm and Quarry, at Round 4. That left the rest of the tree legal from turn 1,
and the opening played itself: grab whatever tile came up, stack its producer immediately, compound
from there. Staging the unlocks gives the early rounds an actual shape — explore and collect first,
industrialize second — and stops a lucky first tile draw from deciding the game.

The four ungated entries are deliberate, not oversights:
- **Barracks** — its cost (§7.1) is already its gate, and delaying it further would push the Risk
  layer even later into the game, which is the opposite of what pass 2 was trying to achieve.
- **Cow Stable** — it exists to service Barracks upkeep (§6.3a); gating it behind a round the
  Barracks isn't gated behind would leave a window where an army can exist but can't be fed.
- **Watchtower** — purely defensive, produces nothing, and cannot compound.
- **Capital upgrade** — not a normal Build action at all; it runs on §7.3's tier table and its own
  VP prerequisite.

### 7.1c The gear economy: CraftGear and SellLoot — **[DEFAULT — balance rework pass 4, new mechanics]**

Two free actions (neither consumes the turn's one Phase 5 Build slot, §7 — same footing as Deploy
Soldiers/Move Soldiers/Build Road) turn Loot into the game's other new resource sink and its newest
source of Soldiers.

**Craft Gear** — at an owned Smithy, with the hero standing on it: pay an Ore+Gold cost scaled to a
chosen rarity, and draw ONE card of exactly that rarity from the same shared Loot pool every other
draw site uses (§9), subject to the same exhaustion rule (§5.3) — a genuinely exhausted rarity still
spends the resources but resolves empty-handed, never throws.

| Rarity | Cost |
|---|---|
| Common | 3 Ore + 2 Gold |
| Uncommon | 6 Ore + 4 Gold |
| Rare | 10 Ore + 8 Gold |
| Legendary | 16 Ore + 14 Gold |

Unlike a monster kill's level-scaled odds, this is guaranteed — the trade-off is cost, and it can be
repeated every turn the wallet allows, which is what makes it a genuine late-game Ore/Gold sink
rather than a one-off purchase.

**Sell Loot** — Craft Gear's inverse, and the direct answer to *"treasure/equipment has a gold value
like in Munchkin which can be sold for additional troops."* At an owned Barracks, with the hero
standing on it: sell one owned Loot card (equipped or not — an equipped card is unequipped as part of
the sale) for Soldiers straight into that Barracks's reserve, scaled by rarity — **higher rarity =
more troops** — and clamped by the Barracks's own tier reserve cap and the player's overall troop cap
(§6.3b) the same way ordinary recruitment is.

| Rarity sold | Soldiers granted |
|---|---|
| Common | 1 |
| Uncommon | 2 |
| Rare | 4 |
| Legendary | 7 |

Selling into a Barracks currently occupied by a rival garrison is rejected — retake it with Move
Soldiers first, same rule Deploy Soldiers already follows (§6.3).

### 7.2 Prerequisites & Restrictions
- Windmill requires an owned Farm on the same or another owned Plains tile before it may be built. **[CANON]**
- Ruins/Dungeon tiles cannot host any economic building — the only building legal there is Watchtower. **[CANON]**
- Volcano tiles host no buildings until tamed into Ashland (§6.1); Ashland then follows Hills placement rules (Quarry legal, at half rate). **[CANON tame mechanic / DEFAULT rate]**
- Buildings other than Windmill (Farm prereq) and Capital upgrade have no additional prerequisite beyond correct tile type + resource payment.
- **[DEFAULT — balance rework, extended in pass 2]** Every production building additionally cannot be constructed before its unlock round — Sawmill/Mine/Trade Post/Dock from Round 3, Farm/Quarry from Round 4, Hunting Lodge/Smithy from Round 5, Windmill from Round 6. A naive resource-cost gate alone doesn't stop a turn-1 rush once a player has any income at all. Pass 1 gated only Farm and Quarry (the fastest-compounding pair); pass 2 staged the rest of the tree behind it. Attempting any of them earlier is rejected outright (no partial/queued construction). Watchtower, Barracks and Cow Stable are ungated — see §7.1b for the full schedule and why those three are exempt.
- **[DEFAULT — balance rework]** Barracks is now Plains-only (previously any owned tile) — matching Cow Stable and Farm, so the Plains-heavy economic tiles are also where a player's military buildup competes for space.
- One building per tile, except the starting Capital tile which may separately hold Capital-upgrade tiers.
- Mage class: every building cost above is reduced by 1 of EACH listed resource, floor 1 per resource. **[CANON]** Example: Sawmill (2 Wood + 1 Stone) costs a Mage 1 Wood + 1 Stone (Stone already at floor). Applies equally to a building's upgrade cost (§7.1a).

### 7.3 The Town (Capital Upgrade Tiers) — **[DEFAULT — canon states "cost scales with tier" without giving values; territory rework: 2 tiers → 5, tier 1 now free]**

Every player's starting tile carries a **Town** from turn one — it is not an empty hex waiting for a
Build action, it is a real `Building` of type `'Capital'` present in `GameState.map` at game start
(`engine/setup.ts`), already at **tier 1**. `Player.capitalTier` begins at `1` for every player and
climbs to a maximum of `5`, one tier at a time, each reached by a `'Build'` action with
`buildingType: 'Capital'` targeting the player's own Capital tile (§7.6's normal cost rules apply,
Mage discount included) — `applyBuild` indexes `CAPITAL_TIERS[capitalTier]` to find the next tier, so
attempting a seventh tier is rejected with "Town is already at max tier (6)".

| Tier | Cost | Effect |
|---|---|---|
| 1 | — *(free; already built at spawn, never actually paid for)* | +2 hero Max HP |
| 2 | 3 Wood + 3 Stone + 3 Food | +3 hero Max HP |
| 3 | 4 Stone + 3 Ore + 4 Food | +3 hero Max HP |
| 4 | 5 Ore + 5 Gold | +3 hero Max HP |
| 5 | 8 Gold + 6 Ore + 6 Stone | +5 hero Max HP |
| 6 — "the Grand Bazaar" | 15 Wood + 12 Stone + 10 Ore + 15 Gold + 8 Food | +4 hero Max HP |

**[DEFAULT — territory rework]** The table was a 2-tier ladder, both tiers purchased. It's now
5 tiers, with **tier 1 granted free at spawn** rather than bought. Stretching it to 5 tiers keeps
the Town a real, ongoing investment choice deep into a game that, at the current VP win threshold
(§11: 120), routinely runs well past 20 rounds — a 2-tier ladder would have been fully spent long
before the game itself was.

**[DEFAULT — balance rework pass 4]** A 6th tier, "the Grand Bazaar," was added on top — a genuine
late-game wonder rather than a new building type (a separate BuildingType restricted to the Capital
tile would collide with the Town/Capital `Building` already occupying that tile's one building slot).
Its cost deliberately spans five of the six resources at once (only Meat excluded, since Meat's whole
purpose is Soldier upkeep, §6.3a) specifically to give Wood, Stone, Ore, and Gold — the four resources
with no other reliable late-game sink — one big, satisfying, one-time drain each, alongside the
recurring sinks Watchtower/Barracks upgrades and Craft Gear provide (§7.1a/§7.1c). It also pays a
larger VP row than a flat continuation of the tier 1–5 pattern would (§10).

Every tier's `heroMaxHpBonus` applies **the moment it's bought**, immediately raising both the hero's
`maxHp` and current `hp` by that amount (§8.2's "level up heals to new max" rule does NOT apply here —
a Town upgrade is not a level-up, and the hero is topped up by the bonus amount, not fully healed).
Tier 1's +2 applies automatically at spawn, on top of the base 10 Max HP from §1.4 and before any
class bonus (e.g. Farmer's own +2) — so in practice **every** hero's true starting Max HP is 12, not
the bare 10 that §1.4 states as the pre-Town, pre-class baseline.

### 7.4 Hero Level-Up & Equip
When a hero's accumulated XP meets the threshold for its next level (§8.1), the level-up is "earned" but not applied until the player spends a Phase 5 action and pays **2 Food** (subject to the Mage discount, §7.2) to apply it, drawn from the wallet only — see §7.6. **[DEFAULT — balance rework pass 2: was 1 Food + 1 Gold]** Equipping a Loot card places it into one of the hero's 3 gear slots (Weapon / Armor / Trinket); a slot's prior occupant returns to unequipped inventory (no combat bonus while unequipped). **[DEFAULT: slot count]**

**[DEFAULT — balance rework pass 2]** Why the Gold half was dropped: Gold comes from exactly three
places — a Desert tile's base yield, a Trade Post built on one, or a Windmill (§7.1) — and Desert is
6% of the tile deck (§3.3). A player who simply never drew a Desert had no Gold income at all, so
hero progression was hostage to terrain luck on top of the XP grind. A measured sweep caught exactly
that: one seat sat on an earned level-up for **23 consecutive Build phases** holding 6–8 Food and 0
Gold, and no hero in any game ever reached Level 2. XP is meant to be the gate on leveling; the
resource cost should be a modest tax in a currency everyone actually earns, not a second lottery
stacked on the first. Note the Mage discount floors each listed resource at 1, so a Mage pays 1 Food
where everyone else pays 2.

### 7.5 Bank Trade
Any player may trade resources with the shared bank on their turn: default ratio 4:1 (4 of one resource for 1 of another). **[CANON: "default 4:1"]** A player who owns a Trade Post uses 2:1 instead; **[CANON]** a Merchant-class player uses 3:1 instead. **[CANON]** If both apply, use the better ratio (2:1); ratios do not stack. **[DEFAULT]** Bank Trade always operates on the wallet — carried resources aren't tradeable until deposited (§7.6).

### 7.6 Spending carried resources, and depositing at the Capital — **[DEFAULT, see Changelog]**

A player has two resource pools: the **wallet** (`Player.resources`, spendable from anywhere)
and each hero's **carried inventory** (`HeroState.carriedResources`, gathered per §5, capped by
§5.1's carry capacity). They combine as follows:

- **Building, upgrading a building (§7.1a), or upgrading the Capital on the tile the hero is
  currently standing on**: pays from carried resources first, then tops up any remainder from
  the wallet. Affordability counts both pools together. **[DEFAULT — balance rework]** Deploy
  Soldiers and Move Soldiers (§6.3) aren't purchases at all — they have no cost and so no pool to
  draw from.
- **Building a road (§7.7)**: same two-pool rule, applied to the *edge's endpoints* — if the hero is
  standing on either end of the segment, the 1 Wood is paid carried-first and topped up from the
  wallet; otherwise it comes out of the wallet alone. **[DEFAULT — territory rework]**
- **Any of the above targeting a tile the hero is NOT standing on, or Hero Level-Up (which has
  no tile at all)**: wallet only. Carried resources sitting on a hero halfway across the map
  aren't reachable for that purchase.
- **Deposit Resources** (free action, not phase- or once-per-turn-gated, like Equip/Unequip):
  available only while the hero is standing on the player's Capital tile. Moves everything the
  hero is carrying into the wallet, clearing carried inventory to zero. This is the only way
  resources collected out in the field become spendable anywhere other than where they were
  picked up — **unless the tile is on a road** (§7.7).

### 7.7 Roads and the supply network — **[DEFAULT — territory rework, new subsystem]**

#### Why roads exist

The resource-economy redesign made a hero physically walk to every tile, collect a bounded load, and
haul it home to the Capital before any of it was spendable. That is a good economy and a terrible
allocation of the one token a player has. A hero at **movement 2** was simultaneously the empire's
**entire logistics corps** and its **adventurer**, and logistics always won: there is always another
tile with a pile on it, and the pile is guaranteed while a Monster Den is a coin flip. Hauling
crowded out the whole monster/loot/XP layer — the Munchkin third of the design — not because that
layer was weak but because nobody could afford the turns to go and play it.

Roads are the release valve. They let a player **buy their way out of the hauling loop** for the part
of their territory they choose to invest in, which frees the hero to do the thing the hero is for.
And because the network only reaches where it has been paid for, and severs when a link is taken,
it stays a real decision rather than a blanket upgrade.

#### Building a road

A road sits on the **edge between two adjacent hexes**, not on a tile. It is keyed by that edge
(`edgeKey(a, b)`, canonically ordered so the same border yields the same key from either side — Data
Model §1), so a border can carry **at most one road, ever, belonging to exactly one player**: whoever
lays it first owns that edge, and nobody can lay a second road there or take it over.

```
BuildRoad(from, to)      # cost ROAD_COST = 2 Wood + 1 Stone; requires Capital Tier >= ROAD_MIN_CAPITAL_TIER (2)
```

> **Changelog — balance rework pass 5 (post-launch, supersedes this section's cost/gate figures
> wherever they conflict):** direct feedback that roads made the road-connected auto-collect sweep
> below available too early — a player could afford ROAD_COST almost immediately, well before the
> hero-carries-it-home economy this whole subsystem exists to relieve (see "Why roads exist" above)
> had done any real work, so the hands-off income arrived before the manual economy ever got to
> matter. Two changes: (1) **ROAD_COST raised 1 Wood → 2 Wood + 1 Stone**; (2) **roads now require
> Capital Tier 2** (`ROAD_MIN_CAPITAL_TIER`, `engine/constants.ts`) — enforced in
> `applyBuildRoad` (`engine/reducers.ts`). No roads can exist at all before Tier 2, so there is
> nothing for the auto-collect sweep to run on yet; every early resource has to be carried home by
> hand, exactly as the pre-roads economy intended. Building costs across the early production tier
> (Sawmill, Quarry, Farm, Mine, TradePost, HuntingLodge, CowStable, Windmill — §7.1) were raised
> alongside this, same direct feedback ("make buildings more expensive .. e.g. a sawmill").

- **Cost: 2 Wood + 1 Stone per segment.** [DEFAULT — balance rework pass 5] Raised from a flat 1
  Wood — see the changelog note above for why. (The Mage's −1-per-resource discount floors at 1 per
  resource, §7.2.)
- **Requires Capital Tier 2 or higher** (§7.3) — see the changelog note above.
- **A free action, and NOT phase-gated at all.** Unlike Deploy/Move Soldiers, which are Phase 5, a
  road may be laid at any point during the player's own turn, and any number of segments may be laid
  in one turn if they can all be paid for. Making road-building compete with constructing a building
  would mean nobody ever builds the supply network the economy is now designed around.
- **Both endpoints must be placed tiles**, and they must be **adjacent** (sharing an edge).
- **At least one endpoint must be a tile the actor owns.** You may extend your network out to a
  neutral frontier hex you intend to claim, but you cannot lay track between two hexes you have no
  stake in.
- **The edge must be free** — an edge that already carries a road, yours or anyone's, is rejected.
- Paid carried-first when the hero stands on either endpoint, otherwise from the wallet (§7.6).

#### The payoff — automatic collection

Every round, as part of §2a's production step (Step C), **every owned tile joined to that player's
Capital by an unbroken chain of that player's own roads has its entire stockpile moved straight into
the wallet.** No hero visit. No carry-capacity limit — the sweep takes the whole pile regardless of
size. No deposit trip: the resources land already spendable, anywhere. A `RoadSupplyCollected` event
is logged with the tiles and amounts.

This is a genuine second economy running alongside the hero's, and it is the difference between a
tile you own and a tile you own *and have connected*.

#### Three subtleties that decide how a network is worth building

1. **The Capital is the anchor, not a member.** The connected set is built by walking outward *from*
   the Capital, and the Capital itself is deliberately excluded from it. The rule is "a tile with a
   road connecting it to your town" — the town is not something a road connects to anything.
   Including it would hand every player free automatic income on their starting tile before they had
   laid a single segment, quietly repealing the collect-and-deposit economy for the one tile everyone
   is guaranteed to own. (The Capital's own stockpile is still collected the ordinary way: a hero
   standing there Gathers it, and a hero standing there can Deposit — §7.6.)
2. **Traversal only crosses tiles you own.** The walk steps from tile to tile across your roads, and
   refuses to enter a hex you do not own — a supply line running through neutral or rival ground
   would be collecting resources across a border nobody controls. A road whose far end is a neutral
   tile you have not claimed yet therefore pays nothing until you own that tile.
3. **Losing a mid-chain tile severs everything beyond it.** Because the walk cannot pass through a
   tile you no longer own, a single tile lost to an occupation (§6.3) cuts off the entire branch
   behind it — every downstream tile silently drops out of the sweep and goes back to needing a hero.
   This is the point, not a flaw: it makes a road network **a thing worth attacking**, and it means
   the frontier garrisons of §6.3 are defending an economy, not just a scoreboard. In the limit, if
   the **Capital itself** falls, the entire network is dead at once — there is no anchor left to walk
   from.

A consequence worth naming: the shortest militarily-defensible chain is usually better than the
longest greedy one, and a chain that runs along your own interior is worth more than one that darts
out through a contested frontier tile.

---

## 8. Hero Leveling

### 8.1 XP Formula — **[CANON]**
```
xpToReachNextLevel(currentLevel) = currentLevel × 3
```

Per-level cost and cumulative total XP since Level 1 (mathematically derived from the CANON formula, not an independent invention):

| From → To | XP for this level-up | Cumulative XP to reach level |
|---|---|---|
| 1 → 2 | 3 | 3 |
| 2 → 3 | 6 | 9 |
| 3 → 4 | 9 | 18 |
| 4 → 5 | 12 | 30 |
| 5 → 6 | 15 | 45 |
| 6 → 7 | 18 | 63 |
| 7 → 8 | 21 | 84 |
| 8 → 9 | 24 | 108 |
| 9 → 10 | 27 | 135 |

### 8.2 Level-Up Effects
- Hero Level feeds directly into every combat roll (`1d6 + level + ...`) per §6.1/§6.2. **[CANON]**
- Each level gained increases hero Max HP by +2 and fully heals current HP to the new max. **[DEFAULT]**
- Reaching a hero level may also award Victory Points — see §10.

---

## 9. Loot Rarity Table

### 9.1 Rarity → Combat Bonus — **[CANON]**

| Rarity | Flat Combat Bonus | Special Ability |
|---|---|---|
| Common | +1 | Occasional (card-defined) |
| Uncommon | +2 | Occasional (card-defined) |
| Rare | +3 | Occasional (card-defined) |
| Legendary | +5 | Occasional (card-defined) |

`gearBonus` used in §6.1/§6.2 formulas = sum of the flat bonuses of all currently equipped Loot cards (up to 3, per §7.4).

### 9.2 Rarity Draw Odds by Monster Level
See §6.1 bracket table (Monster Level 1–2 → Common, 3–4 → Uncommon, 5–7 → Rare, 8–10 → Legendary). **[DEFAULT]**

---

## 10. Victory Point Scoring Table

**Not specified numerically in canon beyond the win threshold (§11). Full table below is [DEFAULT] and must be implemented as tunable constants.**

| Source | VP Awarded | When |
|---|---|---|
| Owned tile (any type, including Ruins/Dungeon and Ashland) | +1 each | Continuously, recount each round-end check. **[DEFAULT — territory rework]** *Owned*, not occupied: a tile you have marched onto but not yet claimed (§6.3) still scores for its current owner, and only moves to your column when the occupation settles at the start of one of your later turns |
| Building constructed (any type except Capital upgrade) | +1 each | On construction, persists while owned |
| Town (Capital upgrade) Tier 1 | +1 | Already true at spawn — tier 1 is free (§7.3) and still scores, not a discount |
| Town (Capital upgrade) Tier 2 | +2 | On construction |
| Town (Capital upgrade) Tier 3 | +3 | On construction |
| Town (Capital upgrade) Tier 4 | +4 | On construction |
| Town (Capital upgrade) Tier 5 | +6 | On construction |
| Town (Capital upgrade) Tier 6 — "the Grand Bazaar" | +8 | On construction. **[DEFAULT — balance rework pass 4]** |
| Hero reaches Level 3 | +1 | Once, on first reaching |
| Hero reaches Level 5 | +2 | Once, on first reaching |
| Hero reaches Level 7 | +3 | Once, on first reaching |
| Hero reaches Level 10 | +5 | Once, on first reaching |
| Legendary Loot card owned (equipped or in inventory) | +2 each | Continuously while owned |

**[DEFAULT — territory rework: extended to 5 tiers, alongside §7.3]** The Town VP row grew from 2
entries to 5 in step with the Capital tier table itself, and the per-tier values were re-picked
(`VP_CAPITAL_TIER` in `engine/constants.ts`) rather than simply extending the old +2/+3 pattern —
tier 5 in particular is worth **+6**, a bigger jump than a flat progression would give, so the last
tier of a 5-tier commitment pays off proportionally to how late-game and expensive it is.

Common/Uncommon/Rare Loot grant no direct VP (combat power only). A player's total VP = live sum of all applicable rows at the moment of the round-end check (§11).

---

## 11. Win Conditions

Checked at the end of every round, after all seated players have completed their turn for that round —
**except Capital Conquest, condition 4 below, which is checked and can trigger the instant its own
event happens, mid-round.** **[CANON: "at the end of a round", for conditions 1–3]**

| # | Condition | Exact Threshold |
|---|---|---|
| 1 | Victory Points | Player's total VP >= **120** **[DEFAULT — doubled twice per direct feedback: 30 → 60 → 120; `WIN_VP_THRESHOLD` in `engine/constants.ts`]** |
| 2 | Domination | Player controls >= 60% of all tiles currently placed on the shared map. **[DEFAULT — balance rework pass 4]** The old alternate trigger here — "OR all rival heroes/capitals have been eliminated" — is gone; see condition 4, which supersedes it outright |
| 3 | Hero Level Race | Any of the player's heroes reaches Level 10 |
| 4 | **Capital Conquest** | The instant ANY rival's Capital tile's occupation claim settles (§6.3, held uncontested for `CAPITAL_CLAIM_ROUNDS` = 5 full rounds — longer than an ordinary tile's `TERRITORY_CLAIM_ROUNDS` = 3, direct request) in a player's favor, that player **wins the entire game immediately** — regardless of how many other players remain seated. **[DEFAULT — balance rework pass 4, direct request: "make it so that conquering the capital of another player is a win condition," confirmed as an instant win for the conqueror]** |

Condition *shapes* **[CANON]**; the VP number itself, and condition 4 in full, are **[DEFAULT]**.
Always read `WIN_VP_THRESHOLD` straight from `engine/constants.ts` before quoting it elsewhere in the
codebase or docs — it has moved more than once in quick succession and a stale copy is an easy trap.

**[DEFAULT — balance rework pass 4]** Capital Conquest replaces what used to be Domination's
alternate "eliminate every rival" trigger. That old path was already effectively an elimination race;
this pass made it explicit, instant, and no longer contingent on being the LAST player standing — a
single captured Capital is enough, at any point in the game, regardless of how many other players are
still seated. Capturing a Capital still flags its former owner `isEliminated` exactly as before
(`engine/reducers.ts`'s `claimHeldTerritory`), but now ALSO ends the whole match right there in the
same breath — the two used to be the same fact viewed from two different angles ("this player is out"
vs. "if everyone is out but one, that one wins"); now the capture event itself is the win, full stop.

**[DEFAULT — balance rework pass 2, then doubled twice more]** Why 30 in the first place: owned tiles
alone pay 1 VP each (§10) and every player places one tile per round essentially unopposed, so VP
accrued at a near-fixed ~1/round metronome regardless of how anyone actually played. At 15 that clock
ran out around round 12–14 — before heroes had leveled enough to matter (the Munchkin layer) and long
before anyone had the economy to field and feed an army (the Risk layer), so games were effectively
decided by pure tile-laying. 30 pushed the finish line past the point where both of those systems come
online — but not far enough past it: even at the next step, **60**, VP was still reported as the
game's default ending rather than Domination or Hero-Level-Race ever getting a real chance to land
first, because every owned tile and every building keeps paying VP every round regardless of how the
war is going, so a large, peaceful economy still out-scored a smaller empire that was actually winning
the fight for territory. **120** — reached by doubling again — pushes the VP finish line well past
what steady tile/building accumulation alone can plausibly reach in a normally-paced game, so a war
has to actually be won (or a hero actually has to hit Level 10) before VP becomes the tiebreaker
instead of the headline.

### 11.1 Minimum Round — **[DEFAULT — balance rework pass 2, new mechanic]**

No threshold-based win may trigger before **Round 12** (`WIN_MIN_ROUND` in `engine/constants.ts`).
Below that round, conditions 1 (Victory Points), 2 (Domination's 60% tile share), and 3 (Hero Level
Race) are simply not evaluated — no combination of lucky tile draws, a rushed hero, or an early
snowball can end the game before the mid-game systems exist at all. Raising the VP threshold alone
wouldn't have covered this: the Hero Level Race and the tile-share path have their own fast,
luck-sensitive routes to a very early finish.

**Condition 4, Capital Conquest, is deliberately EXEMPT from this floor** — the same reasoning that
used to justify exempting Domination's old eliminate-all-rivals trigger, now sharpened: capturing a
Capital is a decisive military result that has earned its ending whenever it lands, at any round.
It is also checked in a completely different place from the other three — see the procedure below.

**[DEFAULT — post-launch fix]** The 60% share only evaluates once the shared map has at least
`8 × seatedPlayers` tiles placed in total (`WIN_DOMINATION_MIN_TILES_PER_PLAYER` in
`engine/constants.ts`). Without this gate, a fresh 2-player game where one side has simply
placed one more tile than the other already clears 60% of a 2-3-tile board — a real bug an
AI-vs-AI integration test caught within the first turn of play, not a hypothetical edge case.

**Trigger check procedure:**

Capital Conquest (condition 4) is checked separately from the other three, and first in sequence —
the instant a Capital's occupation claim settles (`engine/reducers.ts`'s `claimHeldTerritory`, which
runs at the start of the claimant's own Phase 0, not necessarily at a round boundary), the game ends
immediately in that player's favor and no further action by anyone is legal. Conditions 1–3 never get
the chance to fire afterward for that match, and their own round-end check (below) simply never runs
again once `winnerId` is set.

Conditions 1–3, unchanged in shape from before this pass:
1. At round end, evaluate Victory Points, Domination's 60% share, and Hero Level Race for every
   player simultaneously, subject to §11.1's Round-12 floor and the board-size gate above.
2. If exactly one player triggers any condition, that player wins immediately. **[CANON: "first to trigger ... wins"]**
3. If multiple players trigger a condition in the same round-end check, the player with the highest total VP (§10) among them wins. **[CANON: "ties broken by highest total Victory Points"]**
4. If VP is also tied, the winner is whichever tied player is earlier in the current round's turn order. **[DEFAULT: secondary tie-break, not specified in canon]**