# Elenor — Game Design Document

*(working title, placeholder — renameable)*

**Genre:** Browser-based, turn-based hex world-builder
**Players:** 2–6
**Session length:** 45–90 minutes (target, placeholder — tunable)
**Platform:** Web app (Next.js), playable realtime, async, or hotseat

---

## 1. Narrative Pitch

A handful of rival chieftains wake up on the edges of the same unmapped hex world. There is no
board per player, no private kingdom off in a corner — there is one shared map, and every tile
anyone places grows into it. Your territory butts up against theirs from the very first few
turns, not the last few. You are simultaneously a settler laying down farms and quarries, a
general probing the frontier for a weak flank, and a scrappy dungeon-diver sending your one hero
out to kick down the door of whatever's living in the Ruins two tiles over.

Elenor is the game that results from asking "what if Catan's resource tiles, Risk's contested
borders, and Munchkin's greedy little power-fantasy hero all had to live on the same board at
the same time?" You will build an economy, because you need Wood and Ore and Gold to do anything
at all. You will pick fights, because your neighbor's undefended Hills tile is right there. And
you will send a single hero — your hero, with a name, a level, a growing pile of loot, and a
tendency to get cursed at the worst possible moment — out into the unknown, because Monsters
don't loot themselves.

## 2. Player Experience Goals

- **Every turn has three different kinds of decisions, not one.** A turn should never feel like
  "just" an economy turn or "just" a combat turn — the Production, Build, and Fight phases keep
  pulling the player between long-term development and short-term opportunism.
- **The map is a conversation, not a spreadsheet.** Because all players place tiles on one shared
  world, reading the board — where the frontiers are, whose hero is exposed, which Ruins tile is
  worth the risk — is as important as optimizing your own tile count.
- **The hero is the player's face on the board.** Leveling, loot, and curses should generate
  stories ("I rolled a 1 into the Volcano and lost my sword") that players want to tell each
  other mid-game, not just numbers that go up.
- **Multiple viable paths to winning.** A quiet economic builder, an aggressive territorial
  conqueror, and a reckless dungeon-diving hero-leveler should all be racing toward a win
  condition that rewards their style, and all three paths should feel live for most of the game.
- **Session length is a design constraint, not an accident.** The turn structure and win
  conditions are built so a 2–6 player game resolves in roughly the length of a single sitting,
  even though the map, classes, and loot pool aim for a lot of replay variety within that time.

## 3. Turn Structure

Every active player's turn moves through six phases, always in this order, always using these
names: **Phase 0 — Production**, **Phase 1 — Draw & Place Tile**, **Phase 2 — Move Hero**,
**Phase 3 — Fight**, **Phase 4 — Gather**, **Phase 5 — Build**. *(Fight and Gather swapped places
post-launch — see the note at the end of Phase 3 below for why.)*

**Phase 0 — Production.** The turn opens with no decisions at all — it's the payoff for
everything built so far. Every tile the active player owns that has a resource-producing
building on it (a Sawmill, a Quarry, a Farm, a Mine, a Trade Post, a Dock, and so on) generates
its resource automatically, dropped straight into the player's stockpile. This is the moment
that rewards earlier turns' Build-phase choices and sets the resource budget for everything the
player is about to try to do this turn. It's also, as of the balance rework, the moment any
standing army gets fed: before anything else happens, every Soldier the player owns — garrisoned at
home, still sitting in a Barracks reserve, or camped on ground they've taken from a rival —
automatically costs its upkeep, charged against Meat first and Food for whatever's left, with
desertion if the player can't cover the bill (see §6).

Phase 0 is also where **conquest is finally recognised**. Ground taken by marching troops onto it
doesn't change hands the moment the fighting stops — it changes hands at the start of a later turn,
if and only if the invader's soldiers are still standing on it. So a player's turn opens by looking
at every hex their army is squatting on and asking which of them they actually held onto while
everyone else had a turn to take them back. Whatever survived that scrutiny becomes theirs, flag and
buildings and all.

**Phase 1 — Draw & Place Tile.** The player draws one hex tile from the shared tile deck and
places it on the shared world map. The only placement rule is that it must touch at least one
tile the player already owns, and it can't overlap a hex that's already occupied — otherwise the
player chooses where, which means choosing *how their territory grows and in which direction the
frontier with a rival gets pushed.* This is the phase where the shared map actually expands, and
where a player decides whether to grow toward open land, toward a juicy Ruins tile, or
aggressively toward a rival's border.

**Phase 2 — Move Hero.** The hero token moves across owned tiles and/or adjacent tiles, with how
far it can go set by the hero's current stats and gear (a Rogue's mobility, a Dock granting boat
movement across water, and so on). The decision here is where the hero is going to *be* for the
rest of the turn — toward a Monster Den to fight, toward a rival's hero for a risky duel, or
staying home to defend. If the hero's move ends somewhere it has never been before, a Door card
turns over the instant the move resolves — see §6 — which can hand the player a small windfall on
the spot, or a monster that the very next phase confronts them with, whether they wanted one or not.

**Phase 3 — Fight.** This is the hero's phase, and the Munchkin half of the game lives in it.
Depending on where the hero is standing, the active player may resolve a **hero vs. Monster**
encounter on a Ruins/Dungeon tile, a **hero vs. rival hero** duel or backstab if another hero is on
the same tile, or a **Volcano tame** — one of those, at most, per turn. A player isn't forced into a
discretionary Ruins Den fight just because one is available, but skipping a winnable fight usually
means skipping the XP and loot that would have come with it. A Monster that turned up behind a door
in Phase 2 (see §6) is a different story: it has to be *resolved* here, on top of anything else,
before the turn can move on — fought, or **fled**. Fleeing sends the hero back to wherever it was
standing before this turn's move, which is *why Fight now runs before Gather*: a hero who flees (a
Door monster, or a Ruins Den it just walked onto) is no longer standing on that tile once Gather
opens, forfeiting whatever it would have gathered there this turn. Neither a fight nor a flee counts
against the once-per-turn discretionary-combat limit above when it's the mandatory Door encounter
being resolved. Territory battles are deliberately *not* here any more: armies fight in Phase 5, when
they march (see §6).

**Phase 4 — Gather.** Once the hero has arrived somewhere — and survived, or fled, whatever was
waiting for it — manual resource-gathering actions become available at its current tile: looting a
Ruins tile, foraging on the terrain the hero is standing on, and similar hands-on actions that
Production alone doesn't cover. This is the hero's chance to top up the stockpile in ways a passive
building can't — assuming it's still standing on the tile to do it.

**Phase 5 — Build.** The turn closes with the spending phase: resources banked from Production and
Gather get converted into a building on an owned tile, or into leveling up the hero, or into new
gear via loot and Smithy crafting. It's also the phase where the map's borders move. Marching
Soldiers is a free action here — a player can shuffle troops along their frontier, push a stack onto
a neighbour's undefended hex, or throw one at a defended one and roll the dice, all without spending
the turn's one building. Laying a road is free too, and isn't even tied to this phase. So Phase 5 is
where the turn's economic gains get locked in *and* where the shape of next turn's war gets set,
before play passes to the next player.

## 4. Tile Types, Resources, and Buildings

| Tile Type | Resource | Building | Effect | Cost |
|---|---|---|---|---|
| Forest | Wood | Sawmill | +1 Wood/turn; Round 3+ | 2 Wood + 1 Stone |
| Forest | Wood | Hunting Lodge | +1 Food/turn; hero gains +1 XP on first hunt each round; Round 5+ | 2 Wood + 1 Food |
| Hills | Stone | Quarry | +1 Stone/turn; Round 4+; two upgrades, to +3/turn at tier 3 | 2 Stone + 1 Wood |
| Plains | Food | Farm | +1 Food/turn; Round 4+; two upgrades, to +3/turn at tier 3 | 2 Food + 1 Wood |
| Plains | Food | Windmill (requires Farm built first) | Converts 2 Food into 1 Gold/turn; Round 6+ | 2 Stone + 2 Wood |
| Plains | Food | Cow Stable | +1 Meat/turn; four upgrades, to +5/turn at tier 5 | 3 Food + 2 Wood |
| Plains | Food | Barracks | Unlocks Soldier recruitment — and that's all it does. Recruits one Soldier per three tiles you own each round (minimum 1, reserve capped at 9, only while the current army's upkeep is affordable, and never past the army's water-scaled troop cap), redeployable to the Barracks tile itself or one hex out; march it further with Move Soldiers | 3 Wood + 2 Ore + 5 Food |
| Mountain | Ore | Mine | +1 Ore/turn; Round 3+ | 2 Ore + 1 Stone |
| Mountain | Ore | Smithy | Crafts hero gear from Ore + Gold; Round 5+ | 3 Ore + 2 Stone |
| Desert | Gold (scarce, low yield) | Trade Post | +1 Gold/turn; unlocks 2:1 bank trade (default is 4:1); Round 3+ | 2 Gold + 2 Stone |
| River (special) | None — produces nothing; raises the owning player's Soldier troop cap instead | Dock | Unlocks boat movement across water; Round 3+ | 2 Wood + 1 Stone |
| Ruins/Dungeon | None — hosts a Monster Den for Fight-phase encounters; cannot host economic buildings | Watchtower (only building allowed) | Defense bonus in territory combat | 2 Stone + 2 Ore |
| Volcano (rare) | None — hero can "tame" it via a high-difficulty fight for a one-time large Gold/loot cache, after which it converts into a weak Stone tile (Ashland) | — | — | — |

**Universal buildings** (may be built on any owned tile regardless of type): **Watchtower**
(defense bonus in territory combat — it belongs to the tile, so it defends whoever is currently
holding it), cost 2 Stone + 2 Ore.

**Starting-tile only:** the **Town** — every player's starting tile carries tier 1 for free from turn
one, and four further tiers can be bought over the course of the game (cost scaling with tier), each
adding more hero max HP.

**Not a building at all: roads.** A road costs 1 Wood and sits on the *edge* between two adjacent
hexes rather than on a hex, so it doesn't occupy a tile's one building slot and doesn't compete with
anything. Laying one is free and unrestricted — see §6 for what a network of them is worth.

A post-launch balance rework touched six things about this economy, all reflected in the table
above: every player now starts with an empty stockpile (no more small day-1 cushion — class
bonuses like the Woodcutter's starting Wood or the Merchant's starting Gold are unchanged and
still apply, they're just the *only* thing in the wallet at kickoff); **Meat** joined the resource
list as a sixth type, produced only by the new **Cow Stable**; Farm and Quarry kept their original
+1/turn rate but can no longer be rushed on turn one, and both gained upgrade tiers; and
**Barracks** moved off the "universal building" list onto Plains only, got considerably more
expensive, and stopped selling Militia outright — see §6 below for what it does instead.

A second pass sharpened the *timing* of that same economy, which the first pass had left alone.

**Buildings unlock on a schedule, not all at once.** Gating only Farm and Quarry wasn't enough:
with the rest of the tree legal from turn one, the opening played itself — grab whatever tile came
up, stack its producer immediately, compound from there, and a good first draw did most of the work
of winning. Now the basic single-resource producers (Sawmill, Mine, Trade Post, Dock) come online
in Round 3, the compounding pair (Farm, Quarry) in Round 4, the buildings that buy power rather
than income (Hunting Lodge, Smithy) in Round 5, and the Windmill — which needs a Farm to already be
paying out — in Round 6. The early rounds now have a shape they didn't before: explore, walk your
hero out, collect what the land gives you, *then* industrialize. Barracks, Cow Stable and the
Watchtower are deliberately left ungated — the Barracks's price tag is already its gate, the Cow
Stable exists to feed it, and a Watchtower produces nothing and can't snowball.

**Upgrades became tracks, not a single step.** Farm and Quarry each take two upgrades to reach
+3/turn, and the Cow Stable now runs a four-step climb from +1 Meat all the way to +5 — each step
costing a full turn's Build action. That last one is the big correction: opening at +3 Meat meant
one cheap building paid a nine-Soldier army's entire food bill the moment it finished, which solved
the whole upkeep economy in a single action. Starting small makes feeding an army something you
have to keep investing in while the army grows.

**Territory you never visit stopped being free money.** A tile now holds at most 5 of any resource
before production there simply stops — roughly one Level-1 hero's carry capacity, down from 10,
which was two full hero-loads. Collection trips are a routing decision again.

**Barracks pays in Wood and Food, not Ore.** The Ore share was halved — 4 down to 2, taking the
total bill from 12 resources to 10, still around four rounds of a developing economy's income and
still a real commitment. Ore only comes from Mountain tiles, so pricing an army in Ore meant the
entire Risk layer of the game was contingent on one specific terrain showing up in your tile draws
— the cost should measure how much you've built, not how lucky your deck was.

**Ruins got twice as common.** The tile deck went from 6% Ruins to **12%**, with the extra share
taken evenly off the four bulk economy terrains — Forest and Plains from 22% to 20%, Hills 18% to
17%, Mountain 16% to 15% (figures from before the River change directly below, which touched Forest
again). Ruins are the only tile that hosts a Monster Den, which makes them the
only source of hero XP, levels and loot anywhere in the game outside a Hunting Lodge. At 6% a whole
game put two to five of them on the board, so a player who wanted to play the dungeon-diving half of
Elenor simply wasn't dealt enough dungeons to dive; the Munchkin layer stayed decorative no
matter how well anyone played it. Doubling the share is what gives that third of the design enough
material to be a real strategy rather than a flavor note.

**River stopped scaling with deck size, and Forest absorbed its old share.** River tiles are now
carved out of the deck as a small, flat, per-player count (roughly one and a half per seated player)
before any of the percentages above are even applied, rather than being a straight percentage of a
deck that itself grows with every extra player. The payoff for owning water — the troop cap it raises
for the owner's army — is worth roughly the same no matter how many people are playing, so tying its
supply to deck size was pricing it wrong at the table. The 8% Forest lost isn't spread thin across
everything else; it lands entirely back on Forest, taking it from 20% to **28%** of what's left. A
live report of a player finishing an entire six-round game with zero Wood is exactly the failure this
fixes — Wood is the one resource nearly every early building and every road needs, so it's the last
one that should ever run dry.

## 5. Classes

Each player draws a class at random when the game starts. The class colors the player's starting
tile, their hero's opening kit, and the economic lean they'll want to lean into all game.

**Woodcutter.** A settler who showed up with an axe and a plan before anyone else had finished
pitching camp. Their starting tile comes with a Sawmill already standing, and every Forest tile
they ever own produces an extra permanent +1 Wood — the Woodcutter's territory is, structurally,
a lumber empire from turn one.

**Miner.** Someone who grew up with rock dust in their lungs and can smell Ore through solid
stone. They begin with +1 starting Ore in the stockpile, and their starting tile is biased to
land near Hills and Mountain terrain, front-loading the heavy-industry side of the tech tree.

**Farmer.** The quiet backbone of any settlement — unglamorous, reliable, never starving. They
get +1 Food/turn as a baseline on top of whatever their tiles produce, and their hero starts with
+2 max HP, built from a lifetime of hard, healthy labor rather than combat training.

**Warrior.** Came for the fight and brought a weapon to prove it. The hero starts already holding
a weapon worth +2 Attack, and rolls an extra combat die in every Fight-phase encounter — the
class built to be first into the Ruins and first across a rival's border.

**Mage.** Studied the theory instead of swinging a sword, and it shows in the workshop as much as
the battlefield: all building costs are reduced by 1 resource (minimum 1), and the hero has a
ranged attack usable before melee even begins, letting a Mage soften a Monster or duelist before
the dice that matter are even rolled.

**Merchant.** Never met a deal they wouldn't haggle. The bank trades with them at 3:1 instead of
the default 4:1, and they start with +2 Gold in the bank — a head start on Windmills, Smithy
gear, and anything else that runs on coin.

**Rogue.** Doesn't believe in borders, or asking permission. The hero may move through unowned or
rival-owned tiles without stopping, and once per round may steal 1 resource from an adjacent
rival tile — the class built for reconnaissance, mobility, and quietly bleeding a neighbor dry.

## 6. Hero, Combat & Loot Loop

Every player controls one hero — a single token on the shared map that is, mechanically, their
Munchkin engine. The hero has a **Level** (1 through 10), **HP**, **Attack**, and an inventory of
**Loot cards**, which come in four rarity tiers — Common, Uncommon, Rare, Legendary — each
worth a flat combat bonus (+1, +2, +3, or +5 respectively) and occasionally a special ability on
top of the number.

**Fighting a Monster** is the core risk/reward beat of the game. On a Ruins/Dungeon tile, the
player draws a Monster card from the shared deck — a Level and a special ability, unseen until
it flips. The hero rolls 1d6, adds their Level and any gear bonus, and compares the total against
the Monster's Level threshold. Win, and the hero walks away with XP and a Loot card draw whose
rarity scales with how tough the Monster was. Lose, and the hero eats HP damage and possibly
draws a **Bad Stuff** curse card — the game's built-in punishment for overreaching, the moment a
player's hero limps home worse off than when it left.

**Opening a door.** A Ruins tile was, for a while, the only place the Munchkin half of the game
actually happened — everywhere else, moving your hero was purely a logistics decision, get from A to
B. The Door deck fixes that: the very first time a hero's move ends on a hex it has never stood on
before, *anywhere on the map*, something is behind the door. It's one shuffled pile mixing Monster
cards and Utility cards together, on purpose — exactly how the tabletop game it's borrowing the idea
from shuffles its own Door pile, so opening one is genuine uncertainty about whether you're walking
into a fight or a windfall. A Monster card means exactly what it sounds like: the same fight as a
Ruins Den, same dice, same rewards, except this one isn't a free skip and isn't waiting for you to
come back later — it has to be *resolved* before the turn can end, full stop, fought or **fled** (see
§3's Phase 3 note — fleeing has its own cost, so this still isn't free, just no longer a guaranteed
fight). A Utility card resolves on the
spot, no dice involved: a handful of Wood or Meat, a scratch or a quiet heal, a nudge of XP, or —
Munchkin's classic "small treasure, no monster" beat — a free Loot card draw with no fight attached at
all. Sometimes it's nothing but flavor text, because not every door needs to matter mechanically to be
worth opening. And because it fires on *any* first-visited tile, landing on a brand-new Ruins tile can
turn up two separate monsters at once — the Den that's been sitting there since the tile was placed,
and whatever the door itself turns over — which is exactly the kind of "oh no" moment the Munchkin
third of the pitch is supposed to deliver. The Loot pool doing double duty as both a Ruins reward and
Door treasure meant it needed to grow again to keep up, and it has.

**Fighting another hero** — a PvP duel, or an outright backstab — comes down to the same core
roll on both sides: 1d6 plus Level plus gear Attack, higher total wins. The winner steals one
resource or one Loot card from the loser, which is what makes a rival hero standing alone on an
exposed tile a real temptation, not just scenery.

**Fighting for territory** is where the game goes full Risk — and it was redesigned outright in the
third balance pass, because the first version had the wrong shape. It used to be a Phase-4 button:
you owned a Barracks, you declared an attack from that Barracks tile against an adjacent rival hex,
you rolled, and if the defender hit zero units the tile was simply yours, instantly, buildings and
all. That is a siege engine, not a border.

The way it works now comes straight from the designer, and it's worth stating as a picture before
stating it as a rule: **territory should be contested along the borders, where tiles of two
different colours meet, with both players stationing troops there to protect their own tiles from
the enemy's.** A frontier ought to be a place on the map that people watch and man, not a range band
around a building.

So: a troop attacks a foreign tile **by moving onto it**. If it's empty, the tile becomes yours once
your troops have stood on it, uncontested, for three full rounds running. If enemy troops are there,
you fight first — the same Risk-style dice as before, both sides rolling one d6 per unit, sorted and
paired off, ties going to the defender, a Watchtower adding a pip to each of the holder's dice — and
if you win, your troops still have to stay put for those same three rounds before the tile is truly
yours. That's the whole system. One action, **Move Soldiers**, covers reinforcing your own hex,
walking onto an empty one, and throwing yourself at a defended one; the map decides which of the
three you just did. Lose the fight and your survivors fall back to the tile they came from rather
than evaporating, so a failed probe costs you blood and a turn, not your border. And a march can never
fully empty the tile it left — at least one Soldier always has to stay behind, on offense or defense
alike, so there's no such thing as an all-in strike that leaves your own ground standing wide open.

The part that changes how the game *feels* is that **taking ground and owning it are now different
things**. Winning the battle buys the ground, not the deed. The flag only changes after your soldiers
have stood there, unbroken, through three of your own later turns — which means every rival gets a
solid two full rounds of their own turns in between (not just one) to march back and take it off you.
Reinforcing a tile you're still only occupying resets that clock too, so shoring up a raid you're not
ready to commit to actually costs you time. Nothing is decided by one roll on one turn any more. You
have to take a tile and then *hold it in front of everybody, for a while*, and until you have, it's
still paying its VP and its production to the player you took it from.

**Heroes can throw themselves into that fight too, and it's the first time gearing a hero pays off
outside a Ruins tile or a Door card.** Either side of a march can put its hero on the line: the
attacker opts in when it sends its Soldiers across the border, and a defending hero needs no
permission at all — standing on the tile under attack is enough. Whichever hero joins rolls the
exact same way it would against a Monster or a rival duelist, die plus Level plus Attack plus gear,
Warrior's extra die included, and that roll drops into the same sorted, paired comparison the
Soldiers are already running — one more entry in the stack, never counted as a Soldier itself, so it
can't save or cost the army a single unit either way. Win the pairing and the hero picks up a flat 2
XP; lose it and the hero eats HP damage scaled to how badly the roll went, with a floor of 2 so even
a coin-flip loss still costs something.

**Losing badly enough is permanent.** This is deliberately a harsher rule than the one everywhere
else in the game: a hero downed by a Monster or a curse limps home to the Capital and heals up
whole, level and loot and all, no worse for the trip. A hero who dies fighting for territory doesn't
get that mercy — the slot is filled by a brand-new Level 1 hero, with none of the dead one's levels,
gear, Loot, or curses. The only things that carry over are the PLAYER's own investments, not the
hero's: whatever class bonus and Town-tier HP the player has already banked, and a Dock's boat
unlock if they've built one — because those were never the dead hero's to lose in the first place.

**That asymmetry is the point.** Before this, leveling a hero and hanging gear on it only ever paid
off against Monsters and Door cards — the war for territory ran entirely on Soldier dice, and a
hero could sit at home, fully kitted, and never once matter to it. Now a strong hero is worth
throwing at the border, because it genuinely improves the odds of holding or taking a contested
tile — but throwing it in is a real bet, not a free lever, because losing it doesn't just cost HP, it
can cost the hero. That's the fair equation the design was asked for: heroes get a second axis of
value beyond monster-hunting and Door cards, priced in a currency — the hero itself — that only a
game already willing to let heroes die permanently could charge.

**A Barracks now does exactly one thing: it unlocks recruitment.** It is not a launch pad, it grants
no attack privilege, and being next to one means nothing whatsoever. What it does is quietly raise
troops on its own tile every round — at a rate that scales with how much ground you hold, one
Soldier per three tiles you own, minimum one, up to a standing nine in reserve. That scaling is
deliberately the Risk reinforcement rule: a sprawling empire and a three-tile holdout used to field
identical armies off a flat +3, which is exactly backwards. Holding more ground *should be* the
military advantage. A separate Deploy Soldiers action lifts that reserve out to any tile you already
own, at any distance — that's your interior logistics, getting the new recruits to whichever frontier
looks nervous — and Move Soldiers is what happens once they're there.

The catch is upkeep: every Soldier you own — garrisoned, in reserve, or camped on ground you've taken
from someone else — eats Meat or Food every single turn, and if the wallet comes up short, the
biggest garrison thins itself out through desertion rather than the whole army starving evenly. Note
that troops abroad are still on your payroll, so an invasion is expensive to sustain precisely while
it's exposed. A standing army is not a one-time purchase; it's a running cost, which is exactly what
the Cow Stable exists to help cover — though only barely, at first. A fresh Cow Stable makes 1 Meat a
turn, enough for three Soldiers, and reaching the +5 it eventually tops out at takes four separate
upgrades. Growing the army and growing the herd that feeds it are the same project.

The second balance pass spent most of its attention on that upkeep loop, because as first written
it ran backwards. Three corrections:

**The barracks stops taking recruits when you can't feed the troops you have.** Production is
automatic and can't be declined, so the original design cheerfully churned Soldiers into a famine —
recruit, starve, desert, recruit again — with desertions outnumbering successful upkeep payments two
to one and every player's wallet scraped to zero every round. Now a Barracks only takes recruits in
a round where the player can actually cover the bill for the army already standing. A solvent player
keeps growing; a starving one stops digging.

**Meat is spent before Food.** Meat has exactly one use in the whole game — feeding soldiers — while
Food also buys buildings, Capital tiers and hero level-ups. Charging Food first meant a standing
army quietly drained the one currency everything else in the game runs on. Spending the
single-purpose resource first is simply what a player would do if asked, so the game now does it for
them rather than punishing anyone who didn't think about it.

**The reserve cap came down from 15 Soldiers to 9.** Since recruitment is automatic and upkeep is
charged on undeployed reserves too, that cap isn't really a ceiling on an army — it's a ceiling on a
bill you never agreed to. Fifteen Soldiers eat exactly as much per round as a maxed Cow Stable
produces, so the entire four-upgrade herd project bought a player nothing but the right to break
even, and in practice the Barracks drained everyone's Food to zero every turn long before the herd
got there. Nine is still a real standing force, still enough to overrun an undefended border, and
it's a number an economy can plausibly keep fed while also doing something else.

**Roads, and why the hero needed rescuing.** The third pass added one more system, and it exists to
fix a problem that had nothing to do with combat. When the economy was redesigned so that a tile
holds its production until someone comes and picks it up, the hero became the empire's entire
logistics corps — and it was already the empire's only adventurer. One token, movement two, two
full-time jobs. Logistics won every time, because there is always another tile with a pile on it and
the pile is guaranteed, while a Monster Den is a coin flip that can cost you half your HP. The
dungeon-diving third of Elenor wasn't weak; nobody could afford the turns to go and play it.

A road costs 1 Wood, sits on the edge between two adjacent hexes, and can be laid at any point in
your own turn without spending anything else. The payoff: **any tile you own that's chained back to
your Capital by your own roads has its whole stockpile swept straight into your wallet every round**
— no hero visit, no carry limit, no trip home to deposit it. You are buying your way out of the
hauling loop, one segment at a time, for the part of your territory you choose to invest in.

Three things keep that from being a blanket upgrade, and all three are deliberate. The **Capital is
the anchor, not part of the network** — the town is not something a road connects to anything, and
if it were included every player would start the game with free automatic income on the one tile
everyone is guaranteed to own. The chain **only runs over tiles you own**, so a road reaching out to
a neutral hex pays nothing until you've claimed it, and a supply line can't quietly run through
somebody else's country. And **losing a tile in the middle severs everything behind it** — which is
the best part, because it means a road network is a thing worth attacking, and the border garrisons
of the paragraphs above are suddenly defending an economy rather than a scoreboard. If your Capital
itself falls, the whole network dies with it.

**Leveling** ties the whole loop together: the XP required to reach the next Level is the
current Level times 3, cumulative, so early levels come fast off a couple of easy Monster kills
and later levels demand a real, sustained campaign of fighting and looting. Earning a level and
*applying* it are separate beats — once the XP is banked, the player still has to spend a Build
phase and **2 Food** to cash it in. That price used to be 1 Food and 1 Gold, and the second balance
pass dropped the Gold half for the same reason it doubled the Ruins share: Gold comes only from
Desert tiles, a Trade Post built on one, or a Windmill, so a player who never drew a Desert had no
Gold income whatsoever and their hero simply stopped progressing. One measured playtest seat sat on
an earned level-up for twenty-three straight Build phases holding six to eight Food and zero Gold,
and across the whole sweep no hero ever reached Level 2. XP is supposed to be the gate on leveling;
the resource cost should be a modest tax in a currency everyone earns, not a second lottery stacked
on top of the first.

A hero's Level, HP, and loot pile are the visible record of every fight they've picked all game —
which is exactly why "how strong is your hero right now" is usually the first thing players ask each
other at the table.

Two smaller corrections landed in the same pass, both of them the kind of rule that only becomes
visible once people actually play the dungeon layer. **A Ruins tile can be looted once, ever** — a
dungeon's hoard is finite, and previously a hero could stand on one cleared Ruins hex and empty the
game's entire treasure supply out of the same pile of rubble, one turn at a time. And because Loot
cards are kept by their hero permanently and never shuffled back in, **a rarity really can run out**;
when it does, the fight is still won, the dungeon still cleared, the volcano still tamed — there's
just nothing left in the chest. The card pool was nearly doubled at the same time so that ending up
empty-handed is a genuinely late-game disappointment rather than a routine one.

## 7. Win Conditions & How a Session Ends

A game of Elenor can end three different ways, checked at the end of each round; the first
player to trigger any condition wins, with ties broken by highest total Victory Points.

1. **Victory Points ≥ 120.** VP accrue from tiles owned, buildings built, Town tiers, hero level
   milestones, and Legendary loot — this is the "quiet builder" path, and the one most games are
   expected to resolve through: steady economic and hero growth compounding until someone crosses
   the line.
2. **Domination.** Control 60% or more of all tiles placed on the shared map, or eliminate every
   rival hero and capital — the aggressive, Risk-flavored path for a player (or an unlucky
   alliance of circumstance) who converts military pressure into an outright takeover of the
   board. Note that knocking a rival out means *holding their Capital*, not merely winning a battle
   on it: like any other conquest, the elimination lands when the occupation settles at the start of
   a later turn — three full rounds after the capital was first taken — so a player with enemy troops
   standing on their capital has real time to throw them back off it.
3. **Hero Level Race.** Any hero reaching Level 10 wins outright — the Munchkin-flavored path for
   a player who poured every turn into Fight-phase risk-taking and loot-chasing rather than
   territory.

Because all three conditions are checked simultaneously at round end, a session's climax is
rarely a single obvious countdown — it's usually two or three players converging on different
finish lines at once, and the table watching to see whose triggers first.

The VP line has moved three times since launch — 15 to 30 in the second balance pass, then doubled
twice more to 60 and finally 120 — and each move was for the same underlying reason: owning a tile is
worth a point, and everyone places one tile a round more or less unopposed, so VP ticks upward at
about one per round no matter how anybody actually played. A 15-point game ended somewhere around
round 12–14, before heroes had leveled far enough to be scary and well before anyone could afford to
raise *and feed* an army — two of the game's three headline systems were still finishing their setup
right as the game ended. Even 30, and later 60, weren't enough: a large, peaceful economy could still
out-score a smaller empire that was actually winning the war, so VP kept quietly deciding games that
should have been decided by Domination or the Hero Level Race instead. 120 pushes the line well past
what steady tile-and-building accumulation alone can plausibly reach in a normally-paced game, so a
war now has to actually be won — or a hero actually has to hit Level 10 — before VP becomes the
tiebreaker instead of the headline.

The same pass added a floor underneath every finish line: **nothing can win before Round 12.** A
lucky run of tile draws, a hero who found three easy Monsters in a row, an early snowball — none of
them get to end the session before the mid-game exists. With one deliberate exception: **wiping out
every rival ends the game the moment it happens, whatever round it is.** A minimum-round floor is
there to protect the systems still in play, and once one player is the only player, there are no
systems left in play. Forcing the board to keep taking turns until Round 12 arrived to announce a
result everyone already knew would be ceremony, not a game.

## 8. Target Player Count & Session Length

Elenor is designed for **2–6 players**, with a target session length of **45–90 minutes**.
Both numbers are placeholders the designer expects to retune once the turn structure and win
conditions are in playtesting — but they're the numbers the phase structure, tile deck size, and
VP threshold should be built around for now.

---

File written to: `C:\Users\morrossl\Documents\Private\Elenor\docs\game-design.md`