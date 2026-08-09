# HEXREALMS — UI/UX Specification

Status: working draft, companion to the Design Canon. All names (phases, resources, classes,
buildings) are used verbatim from the canon so this doc can be cross-referenced without translation.

This spec covers: the full screen inventory, the hex-map rendering approach, responsive/mobile
handling of a hex board, color/iconography conventions, and baseline accessibility requirements.
It intentionally does not re-litigate game rules (numbers, costs, win thresholds) — see the Design
Canon for those. Where a rule is referenced here it's only to explain what the UI must display or
gate.

---

## 1. Screen Inventory

Ten screens/surfaces cover the full player journey. Modals (Fight, Trade/Bank) overlay the Main
Game Board rather than replacing it, so the map stays visible as context during a decision.

| # | Screen | Type | Route (Next.js) |
|---|--------|------|------------------|
| 1 | Landing | Page | `/` |
| 2 | Lobby | Page | `/lobby/[roomCode]` |
| 3 | Main Game Board | Page (app shell) | `/game/[gameId]` |
| 4 | Hero Panel | Persistent panel / drawer | within `/game/[gameId]` |
| 5 | Build Menu | Contextual panel / modal | within `/game/[gameId]` |
| 6 | Fight/Combat Modal | Modal (3 variants) | within `/game/[gameId]` |
| 7 | Trade/Bank Modal | Modal | within `/game/[gameId]` |
| 8 | Turn Phase Tracker | Persistent HUD strip | within `/game/[gameId]` |
| 9 | End Game/Winner screen | Full-screen overlay | within `/game/[gameId]` |
| 10 | Settings/Connection status | Persistent corner widget | within `/game/[gameId]` |

### 1.1 Landing

Purpose: entry point for a new visitor — create a game or join one.

Contents:
- Game title/logo, one-line pitch.
- **Create Game** button → generates a room code, opens Lobby as host.
- **Join Game** — text input for a 4–6 character room code + **Join** button.
- Play-mode selector shown at creation time only (host picks it): Realtime synchronous / Async
  turn-based / Local hotseat. This is the "config, not fork" choice from the architecture — it's a
  single dropdown/segmented control, not a different flow per mode.
- Local hotseat skips room-code generation entirely and goes straight to a local Lobby (no
  networking); the control surface is otherwise identical so players don't relearn anything if they
  later switch to a networked mode.

### 1.2 Lobby

Purpose: assemble 2–6 players, confirm classes, confirm play mode, start the game.

Contents:
- **Room code** displayed large, with a copy-to-clipboard button (and, for Realtime mode, a live
  "connected players" indicator per seat).
- Player list, 2–6 seats. Each seat shows: player name/avatar, connection state dot (Realtime/Async
  only), and a **Class** slot.
- **Class draw**: each seat's class is drawn at random from the seven (Woodcutter, Miner, Farmer,
  Warrior, Mage, Merchant, Rogue) when a player joins, or on a **Redraw** action if the host allows
  re-rolls before start. The class card shown must state its starting-tile bonus in one line so
  players aren't sent to the rules doc mid-lobby.
- Host-only controls: kick seat, toggle redraw permission, **Start Game** (disabled until ≥2 seats
  filled and, for Async mode, until turn-order/notification preferences are set).
- Async-mode-only fields: per-player notification channel opt-in (push/email) and a "turn timer"
  display if the host sets one — purely a lobby-time config choice, not a rules change.
- Local-hotseat-only: a "pass device" reminder line replaces the connection-state dots, since there's
  no networking to show.

### 1.3 Main Game Board

Purpose: the primary play surface — the shared hex map plus the HUD chrome that surrounds it.

Layout (desktop, ≥1024px):
```
┌─────────────────────────────────────────────────────────┐
│ Turn Phase Tracker (full-width strip)                    │
├───────────────┬─────────────────────────────┬────────────┤
│               │                               │            │
│  Player rail  │        Hex Map (SVG)          │ Hero Panel │
│  (avatars,    │                               │ (collapsible│
│  resources,   │                               │  drawer)   │
│  VP)          │                               │            │
│               │                               │            │
├───────────────┴─────────────────────────────┴────────────┤
│ Action bar: phase-specific action buttons + Build Menu    │
│ entry point                                                │
└─────────────────────────────────────────────────────────┘
```
- **Player rail** (left): one row per player — avatar, name, class icon, 5-resource mini-ledger
  (Wood/Stone/Food/Ore/Gold counts using the resource iconography from §4), current VP total. The
  active player's row is highlighted using the active-turn treatment (see §4.2).
- **Hex Map** (center): the shared world. Pan/zoom controls (buttons + scroll/pinch). A "recenter on
  my hero" button. Tile hover/tap shows a tooltip: tile type, owner, building, resource yield, and —
  since the territory rework — **who the Soldiers standing on it belong to** (which may not be the
  owner), whether it is under occupation and when that occupation would settle, and whether it is
  road-connected to its owner's Capital (i.e. whether its stockpile is collected automatically). The
  owner and the occupier are separate lines in the tooltip; never collapse them into one "controlled
  by" line.
- **Hero Panel** (right): see §1.4 — collapsible so the map can go full-width on smaller screens.
- **Action bar** (bottom): buttons relevant to the *current phase only* are enabled; all others are
  visibly present but disabled/greyed so players learn the phase sequence by seeing what's coming.
  Phase 5 (Build) surfaces the Build Menu entry point here.
- Toasts/log feed (thin collapsible strip or off-canvas panel): a running text log of actions taken
  by all players — required for Async mode so a returning player can catch up, and useful in
  Realtime/hotseat too.

### 1.4 Hero Panel

Purpose: everything about the active viewer's own hero (or, in hotseat, the currently-active
player's hero) — the Munchkin-style character sheet.

Contents:
- Hero portrait/token, name, **Level** (1–10) with an XP bar showing progress to `Level × 3` XP
  needed for next level.
- HP bar (current/max), Attack value (base + gear bonus shown separately, e.g. "3 (+2 gear) = 5").
- **Inventory/Loot grid**: cards shown with rarity-coded border (Common/Uncommon/Rare/Legendary —
  see §4.3), each showing its flat combat bonus and any special ability text. Equipped items are
  marked distinctly from carried-but-unequipped items (Munchkin allows carrying more than you can
  wear/wield in play, so the UI must distinguish "counts toward Attack" from "in bag").
  - Cursed / "Bad Stuff" status effects currently active on the hero appear as a small badge row
    beneath HP, each with a tooltip explaining the effect and its duration/removal condition.
- Movement range readout for the current turn (derived from hero stats/gear) so Phase 2 legality is
  visible before the player clicks a tile.
- Second-hero slot (Capital-upgrade unlock): shown as a locked silhouette until unlocked, then
  becomes a second identical hero card, with a tab/toggle to switch which hero the Hero Panel is
  displaying (movement/fight actions apply to whichever is selected).

### 1.5 Build Menu

Purpose: Phase 5 spend-resources actions — construct a building on an owned tile, or level
up/equip the hero.

Trigger: opens from the action bar during Phase 5, or by tapping an owned, building-eligible tile
directly on the map (tile-first flow is the primary path on touch devices — see §3).

Contents:
- Two tabs: **Buildings** and **Hero** (level up / equip from inventory).
- **Buildings tab**: shown only for the currently-selected tile. Lists the building(s) legal for
  that tile's type (e.g. selecting a Forest tile shows Sawmill and Hunting Lodge; a Ruins tile shows
  only Watchtower, per canon). Each option card shows: name, effect text, cost in resource
  shorthand with icons (e.g. "2🪵 + 1🪨"), and is disabled/greyed with a reason tooltip if the
  player can't afford it, the tile already holds a mutually exclusive building, or a prerequisite is
  unmet (e.g. Windmill requires Farm built first).
  - The Watchtower is the one genuinely universal option — it appears on every owned tile
    regardless of type, listed below the tile-specific options with a small "universal" tag.
    (Barracks and Cow Stable are **Plains-only** and belong with the tile-specific options; showing
    them as universal is a stale affordance that will offer players an illegal build.)
  - Capital upgrade appears only when the selected tile is the player's starting tile, with its
    current tier and next-tier cost shown.
- **Free actions are not in the Buildings tab, and must not look like they cost the turn.** Move
  Soldiers, Deploy Soldiers and Build Road spend no Build action; surfacing them as option cards
  next to buildings teaches exactly the wrong thing. Put them on the map instead:
  - **Build Road**: selecting one of your tiles offers a "lay road" mode; the six shared edges of
    that hex become individually clickable targets, priced at 1 Wood each, with edges that already
    carry a road (anyone's) and edges whose far side is an unplaced hex shown as unavailable. Since
    road-building is not phase-gated at all, this mode stays reachable throughout the player's own
    turn, not only in Phase 5.
  - **Move Soldiers**: selecting a tile holding your Soldiers highlights its six neighbours as march
    targets, each annotated with what is there — empty, yours, or "N defenders" — so the player can
    see before committing which of the three outcomes (reinforce / occupy / fight) they are about to
    trigger. Repeatable: nothing greys out after one march.
- **Hero tab**: Level-up action (enabled once XP threshold is met — cost is XP, not resources, so
  this is really a confirm-and-apply button) and an Equip/Craft list surfaced from Loot inventory
  plus Smithy-craftable gear (Ore + Gold) if a Smithy is owned.
- Every affordability calculation reads live off the player rail's resource ledger so the number
  shown always matches what Phase 0 production has already granted this turn.

### 1.6 Fight/Combat Modal

Purpose: resolve the hero's Phase 4 encounters (Variants A and B below) **and** report the territory
battle that Phase 5 marches can trigger (Variant C). One modal shell, three content variants selected
by encounter type — kept as one component so the surrounding chrome (dice tray, resolve button,
result banner) stays consistent and players don't have to relearn combat UI per type.

Note the asymmetry introduced by the territory rework: A and B are things a player *chooses* in
Phase 4 and confirms in the modal; C is the *consequence* of a march submitted in Phase 5, and can
fire on a player who isn't even taking a turn.

Common modal chrome:
- Title stating the encounter type ("Hero vs Monster", "Hero vs Hero — Duel", "Army vs Territory").
- A dice tray area that visually rolls and displays the die/dice results.
- A running total breakdown ("1d6 roll: 4  +  Level: 3  +  Gear: 2  =  9") so the math is never
  opaque.
- Primary **Resolve** / **Attack** button, and a **Retreat/Decline** option where the rules allow
  disengaging before commitment.
- Result banner (win/lose) with the consequence spelled out before it's dismissed (XP + Loot draw;
  or HP loss + Bad Stuff draw; or resource/Loot steal; or tile capture).

Variant A — **Hero vs Monster**:
- Monster card drawn from the shared deck shown face-up: art, Level, special ability text, Level
  threshold to beat.
- Hero's roll composition (1d6 + Level + gear bonus) vs threshold, single comparison.
- On win: reveals the drawn Loot card (rarity visually scaled per §4.3) and XP gained, with the XP
  bar animating.
- On loss: shows HP damage applied to the Hero Panel's HP bar live, and reveals a Bad Stuff curse
  card if drawn, with its effect text.

Variant B — **Hero vs Hero (PvP/backstab)**:
- Both heroes' cards shown side by side (portrait, Level, gear Attack) with each roll composition.
- Higher total is highlighted as winner; a steal picker lets the winner choose 1 resource or 1 Loot
  card from the loser's available pool (rendered as a compact selectable list, not free text).
- Because a backstab can be initiated against a non-consenting player, this modal must clearly show
  it to *both* affected players' clients simultaneously (Realtime/Async) or in sequence with a
  "your hero was attacked" recap (Async), never resolved silently server-side without a visible
  result to the loser.

Variant C — **Army vs Territory (Risk-style)** — *rewritten for the territory rework*:
- **Not launched from a Barracks, and not launched at all.** There is no "attack this tile" button
  anywhere in the UI. This variant opens as the *result* of a Move Soldiers march (§1.5) onto a hex
  somebody else is holding. Any UI that still asks the player to pick a Barracks, pick an adjacent
  target, and confirm an attack is modelling a rule that no longer exists.
- The **confirmation moment moves earlier**, onto the map: the march target highlight must show the
  defender's unit count and any Watchtower before the player commits, because once the march is
  submitted the dice resolve immediately with no decline step.
- Dice-pool comparison rendered Risk-style: attacker's N dice vs defender's D dice, sorted
  descending, paired off, each pair marked win/loss, with the Watchtower's +1 shown as a visible
  modifier on each defending die (and its cap at 6 made obvious when it bites).
- A tile-and-buildings preview of the contested tile, so both sides see what is at stake.
- Running unit-loss counter on both sides, then one of two result banners — and the wording here is
  the whole rules change, so it must not be sloppy:
  - **Attacker wins**: "**Occupied — not yet yours.**" Spell out that the tile becomes theirs at the
    start of their next turn *if their soldiers are still standing on it*, name the round that will
    happen, and state that the defender gets a turn in between. Never say "captured".
  - **Attacker repulsed**: show the surviving attackers **returning to the tile they marched from**,
    animated back along the edge they crossed, so the fallback rule is learned by watching it rather
    than by reading it.
- Because a march happens on someone else's turn, the defender's client must be shown this modal too
  (Realtime/Async) or given a "your border was attacked" recap on their next check-in — a player must
  never discover that a tile of theirs is under occupation by noticing a badge changed colour.
- When the tile in question is a **Capital**, the banner must say plainly that holding it into the
  next turn eliminates its owner, and the defender's recap must lead with it. That is the single
  highest-stakes state the board can be in and it should be impossible to miss.

### 1.7 Trade/Bank Modal

Purpose: convert resources with the shared bank (default 4:1, improved by Desert Trade Post to 2:1,
by Merchant class to 3:1 baseline — the modal always reads the *effective* ratio for the current
player rather than hardcoding 4:1).

Contents:
- Five resource columns (Wood/Stone/Food/Ore/Gold), each with a stepper to select "give" quantity
  and the resulting "receive" quantity of a chosen target resource, computed live from the player's
  current effective ratio.
- The effective ratio in use is displayed explicitly ("Your rate: 3:1 — Merchant") so players
  understand *why* their number differs from the default, rather than just seeing a different
  number than a rival.
- Confirm/cancel; confirm disabled if the give-side selection exceeds the player's current resource
  ledger.
- Not a phase-gated action in the canon as written (bank trade isn't tied to a numbered phase) — the
  modal is reachable from the action bar at any point during the player's own turn, so it's
  positioned as a persistent header icon rather than nested in the phase action bar.

### 1.8 Turn Phase Tracker

Purpose: always-visible answer to "what phase are we in, and whose turn is it" — the canon's exact
phase names/order must be legible at a glance since the rules depend on players internalizing the
sequence.

Layout: a horizontal strip of six phase chips, in fixed order, spanning the top of the Main Game
Board:

```
[0 Production] → [1 Draw & Place Tile] → [2 Move Hero] → [3 Gather] → [4 Fight] → [5 Build]
```

- The active phase chip is visually raised/highlighted (see active-state treatment in §4.2);
  completed phases this turn are checked/dimmed; upcoming phases are shown but muted.
- Adjacent to the strip: current player's avatar, name, and class icon, plus, for Async mode, a
  turn timer/deadline if the host configured one, and a "Notify me" toggle for other players waiting
  on this turn.
- Phase 0 (Production) is resolved automatically the instant a turn starts — the tracker still
  highlights it briefly with a small animated summary before auto-advancing to Phase 1, so players
  see it happen rather than it being invisible. That summary now has three things to report, in the
  order the engine resolves them: **territory claimed** (occupations that survived a round, each
  named — this is where a conquest actually lands, and it must not scroll past silently), **Soldier
  upkeep paid or desertions suffered**, and then production/road income ("+2 Wood, +1 Food").
- Tapping/clicking a completed phase chip (this turn only) opens a read-only recap of what happened
  in that phase — helps the next player understand board state changes without scrolling the log.

### 1.9 End Game/Winner screen

Purpose: announce the game's end and clearly attribute *which* of the three win conditions fired,
since the canon defines three independent paths plus a VP tiebreak.

Contents:
- Full-screen overlay (dismissible to a read-only board-review mode, not a hard modal you're stuck
  in — players will want to inspect the final map).
- Winner banner: avatar, name, class.
- **Win condition attribution**, stated explicitly as one of:
  - "Victory Points — reached 30 VP" (with VP breakdown: tiles / buildings / hero level milestones /
    Legendary loot, each subtotal shown). Quote WIN_VP_THRESHOLD rather than hardcoding the number
    in UI copy — it was retuned 15 -> 30 in balance rework pass 2 and this line drifted stale.
  - "Domination — controls ≥60% of the map" (with a map-share percentage readout) or "Domination —
    eliminated all rival heroes/capitals" (whichever actually triggered).
  - "Hero Level Race — reached Level 10" (with the round/turn it happened).
- If the trigger was a tie broken by total VP, the screen shows the tie explicitly ("2 players hit a
  win condition this round — resolved by VP") and the losing tied player's VP total alongside the
  winner's, so the tiebreak isn't a mystery.
- Final standings table: all players ranked by VP, with their final resource/building/hero summary.
- Actions: **Rematch** (new lobby, same seats), **Return to Lobby**, **Exit**.

### 1.10 Settings/Connection status (persistent corner widget)

Purpose: small always-present affordances that don't deserve a full screen.

- Connection indicator: for Realtime, a live dot (connected/reconnecting/disconnected); for Async, a
  "last synced" timestamp; for Local hotseat, omitted entirely (no networking to reflect).
- Sound/music toggle, colorblind-safe icon mode toggle (see §5.1), and a link to the rules
  reference.

---

## 2. Hex Map Rendering

### 2.1 Coordinate system and axial-to-pixel math

The shared world uses axial coordinates `(q, r)` per the canon. Rendering needs a deterministic
mapping from `(q, r)` to pixel-space `(x, y)` and back (for hit-testing clicks/taps).

For **pointy-top** hexes (recommended — reads more naturally as a "world map" and matches most
Catan-style references) with hex size `size` (center-to-corner radius):

```
x = size * (sqrt(3) * q  +  sqrt(3)/2 * r)
y = size * (                 3/2       * r)
```

For **flat-top** hexes, swap the roles:

```
x = size * (3/2       * q)
y = size * (sqrt(3)/2 * q  +  sqrt(3) * r)
```

Recommendation: **pointy-top**. Reasoning: rows read left-to-right naturally in a browser viewport
(wide-and-short window), and pointy-top keeps neighboring same-row tiles at a consistent y, which
simplifies the player-rail "which row is contested" glance players will do during Risk-style
frontier fights. Either orientation is viable; this doc commits to pointy-top so the icon-layering
spec in §2.3 has a single frame of reference — flip the formulas above if the implementation later
prefers flat-top, nothing else in this spec depends on the choice.

Inverse (pixel → axial, for click/tap hit-testing), pointy-top:

```
q = (sqrt(3)/3 * x  -  1/3 * y) / size
r = (            2/3 * y) / size
```
...then round `(q, r, s = -q-r)` to the nearest integer cube coordinate (standard hex-rounding
algorithm: round each of q, r, s independently, then correct whichever axis had the largest
rounding error so `q + r + s` stays 0) to snap a raw pointer position onto the nearest tile.

Neighbor offsets (axial, pointy-top), used for Phase 1 adjacency legality and Phase 2 movement
range computation — six directions:

```
(+1, 0), (+1, -1), (0, -1), (-1, 0), (-1, +1), (0, +1)
```

### 2.2 SVG vs Canvas — recommendation: SVG

**Recommendation: SVG**, with a defined escape hatch to Canvas only if the map size later proves it
necessary.

Reasoning:
- **Per-tile interactivity is the dominant interaction pattern.** Nearly every phase involves
  clicking/tapping an individual hex (place tile, move hero, gather, fight, build). SVG gives each
  hex a real DOM node with native hit-testing, hover, and focus — which also directly enables
  keyboard navigation (§5.2) via `tabindex` and `:focus` styling on each `<polygon>`/`<g>`, something
  Canvas cannot do without a fully hand-rolled parallel accessibility tree.
- **Icon layering is compositional, not pixel-painted.** Ownership tint, resource icon, and building
  icon are independent visual layers on each tile (§2.3); SVG lets these be separate elements
  (`<use>` refs to a shared icon `<defs>` sprite sheet) restyled independently — e.g. re-tinting an
  ownership overlay on tile capture is a single attribute change, not a redraw.
  - Canvas would require maintaining an off-DOM data model driving imperative redraws for every
    hover/selection/ownership change, plus a hand-built hit-testing layer using the same axial math
    from §2.1 — strictly more code for no benefit at this map's scale.
- **Scale is bounded and modest.** This is a hex world sized for a 2–6 player, 45–90 minute session
  — realistically tens to a few hundred tiles, not thousands. SVG's per-node overhead only becomes a
  real problem in the low-thousands-of-nodes range with frequent full-scene animation; this map is
  comfortably under that ceiling, especially since only tiles within/near the viewport need to be
  mounted (see below).
- **CSS-driven styling and theming reuse.** Player-color tinting, resource-color coding (§4), and
  the active-hero-tile highlight can all be plain CSS (classes/CSS variables) on SVG elements,
  matching the rest of a Next.js/React UI's styling approach instead of a separate canvas drawing
  routine.

Mitigations to keep SVG fast as the map grows:
- **Windowed/virtualized rendering**: mount only hexes within the current viewport + a small margin
  (compute visible axial range from the pan/zoom transform, not from iterating every tile every
  frame). This is the single biggest lever — it keeps DOM node count bounded regardless of total
  world size.
- **Zoomed-out overview mode**: at low zoom, collapse tiles to flat color fills (no icon layer
  mounted) and only mount full icon detail once zoomed past a threshold — reduces node count when
  the whole map is visible at once.
- Group static layers (terrain fill) separately from frequently-updating layers (hero token
  position, active-turn highlight) so re-renders touch only the elements that actually changed —
  standard React-keyed-list hygiene, not a special hex-map technique.
- **Escape hatch**: if profiling later shows SVG repaint cost dominating on low-end mobile at the
  target map size, the fallback is a hybrid — Canvas (or WebGL) for the static terrain base layer,
  with an SVG (or absolutely-positioned HTML) overlay for interactive/icon elements — rather than a
  full Canvas rewrite. Flag this as a "measure before switching" item, not a default.

### 2.3 Layering icons on a hex

Each rendered hex is a stack of independent SVG layers, back to front, so any single aspect (owner,
resource, building, garrison, occupation, roads, hero presence, selection state) can update without
touching the others. Note that two of these layers are keyed to something other than the tile's
owner — the garrison badge follows the *troops'* owner, and roads belong to *edges* shared by two
hexes — so neither can be derived from a tile's ownership tint:

1. **Terrain fill** — base hex polygon, fill color per tile type (Forest/Hills/Plains/Mountain/
   Desert/River/Ruins-Dungeon/Volcano-Ashland), from a fixed terrain palette independent of the
   resource-icon color coding in §4.1 (terrain color answers "what kind of tile", resource icon
   answers "what does it produce" — keeping these separate avoids conflating a tile's fixed type
   with its current resource-icon, which matters once a Volcano converts to Ashland but should
   still visually read as "used to be special").
2. **Ownership overlay** — a semi-transparent tint in the owning player's color (§4.2) washed over
   the terrain fill, plus a solid-color border stroke on the hex edge in the same player color so
   ownership is legible even for colorblind users relying on the border/pattern rather than fill
   hue alone (see §5.1). Unowned tiles get no tint and a neutral grey border.
3. **Resource-yield icon** — small icon + count badge (e.g. the Wood icon with "+1/turn") placed in
   the upper portion of the hex, shown only once a resource-producing building exists on that tile
   (an unbuilt Forest tile shows the terrain fill but no active-yield badge, since it produces
   nothing until a Sawmill/Hunting Lodge is built — this matches the canon: raw tiles don't
   auto-produce, buildings do).
4. **Building icon** — centered icon representing the constructed building (Sawmill, Quarry, Farm,
   Mine, Trade Post, Dock, Watchtower, Barracks, Smithy, Windmill, Capital tier), distinct silhouette
   per building so it's identifiable even at small zoom before the label tooltip is read.
5. **Garrison badge** — a numeric badge showing how many Soldiers are standing on this hex, rendered
   on **every** tile holding troops, not just Barracks tiles. Three requirements, all of them
   consequences of the territory rework:
   - **Coloured by the troops' OWNER, not the tile's.** The badge takes its fill and token shape
     (§4.2) from `garrisonOwnerOf(tile)`, which is frequently *not* `tile.ownerId`. A blue badge on a
     red hex is not a bug — it is the single most important state in the game, an invasion in
     progress, and the rendering must be able to express it. Reading `ownerId` for this badge will
     silently paint every invasion in the defender's colour.
   - **Legible at a glance, at the zoom people actually play at.** Border management is a
     count-comparing activity — "they have four there, I have two" — so the number needs to survive
     being small: high-contrast chip behind the digit, not a thin numeral over terrain, and it stays
     rendered (not culled) at the zoom levels where a whole frontier is on screen. This badge is one
     of the few things worth keeping legible when the tile itself is barely bigger than the icon.
   - Tapping/hovering it names the owner explicitly ("4 Soldiers — Blue") rather than relying on hue.
6. **Contested/occupied marking** — a tile whose garrison owner differs from its tile owner is
   **visibly marked as under occupation**, distinctly from both ordinary ownership and ordinary
   selection: keep the current owner's tint (they still own it — it still pays them VP and
   production) and overlay a hatched/striped fill or animated dashed border in the *occupier's*
   colour, so the hex reads as "red tile, blue boots on it." Alongside it show the **claim
   countdown** — "becomes Blue's at the start of Blue's next turn" — because the one-round grace
   period is the rule players will otherwise learn by losing a tile they thought was safe. An
   occupied **Capital** gets the loudest treatment the palette allows.
7. **Roads** — drawn **on the shared edge between two hexes**, in the owning player's colour: a thick
   stroke laid along that border segment, not a line between hex centers and not a tile overlay. One
   road per edge, so there is never more than one stroke to draw per border. Two derived treatments
   matter as much as the segments themselves:
   - **Road-connected tiles are marked**, because their income is automatic and the player needs to
     know which parts of their territory the hero no longer has to visit. A subtle persistent
     indicator on the tile (e.g. a small supply-line glyph, or the connected chain rendered brighter
     than unconnected segments) is enough — but it must be *derived from actual connectivity*
     (`roadConnectedTiles`), not from "has a road touching it," or it will lie exactly where the
     rules are most surprising: a road out to a tile you don't own yet, and a branch severed by a
     mid-chain capture.
   - **Severance must be visible the moment it happens.** When a captured tile breaks a chain, every
     tile behind it silently stops collecting; the map should show that (connected marking drops off
     the whole branch, ideally with a one-time animation) rather than leaving the player to notice a
     missing income line three rounds later.
8. **Hero token(s)** — rendered above the tile stack, one token per hero currently standing on that
   hex (own or rival), each token colored/bordered per its owning player. Heroes and garrisons are
   separate things standing on the same hex and must be separately legible — the hero is never part
   of a territory battle.
9. **Interaction state overlay** — topmost, transient: hover highlight, keyboard-focus ring
   (required for §5.2), legal-move/legal-placement highlight during Phase 1/2 (a subtle glow on
   hexes that are valid targets for the current action, computed from the adjacency/range rules),
   the march-target and road-edge highlights described in §1.5, and the selected-tile outline used
   by the Build Menu.

All icon glyphs (resource + building) live in one shared `<defs>` sprite block and are referenced
via `<use>` from each hex, so icon art is defined once and the per-tile cost is just a reference +
transform — keeping the "windowed rendering" mitigation in §2.2 cheap even as mounted tile count
grows.

---

## 3. Responsive / Mobile Considerations

A shared hex world is wide by nature — this is the single hardest constraint mobile layout has to
solve for, since the whole point of the design (frontiers forming where territories meet) requires
seeing enough of the map to make sense of contested edges.

- **Breakpoints**: desktop (≥1024px) uses the three-column layout in §1.3. Tablet (768–1023px)
  collapses the player rail into a horizontal scrollable strip above the map and keeps the Hero
  Panel as a slide-out drawer. Mobile (<768px) goes single-column: map is the primary full-bleed
  surface; player rail, Hero Panel, and the phase tracker's detail become bottom-sheet drawers
  triggered by icon buttons in a persistent bottom tab bar (Map / Hero / Players / Log).
- **Pan/zoom is touch-first, not an afterthought**: pinch-to-zoom and one-finger drag-to-pan on the
  map are the primary navigation method on mobile since no minimap-sized view can show a growing
  shared world legibly at phone width. A **"recenter on my hero"** button and a **"recenter on my
  territory"** button are pinned as floating action buttons over the map at all times on mobile,
  since re-finding your own position after panning around a shared board is the most common
  friction point.
- **Tap targets sized for touch, not hover**: hexes must be tappable at a minimum ~44×44px
  effective hit area even when the rendered hex itself is smaller at typical zoom — achieved by
  giving each hex's invisible hit-polygon a slightly larger tap radius than its visible border,
  rather than relying on precise-pixel taps on hex points/edges.
- **Tile-first Build Menu flow on touch**: since there's no hover state on touch, the Build Menu
  (§1.5) is reached primarily by tapping an owned tile (which opens a compact contextual sheet
  anchored near the tap point) rather than expecting players to first open a generic menu and then
  pick a tile from a list.
- **No hover-dependent information**: anything conveyed by desktop hover-tooltips (tile info,
  resource yield detail, gear tooltips) must have a tap-equivalent (tap-and-hold or a persistent
  info-on-select panel) since mobile has no hover state at all.
- **Combat/Trade modals go full-screen on mobile** rather than centered floating dialogs, so the
  dice tray and roll-composition breakdown (§1.6) have room to be legible without horizontal
  scrolling — the map remains reachable only by dismissing the modal, which is acceptable since
  combat/trade are modal, attention-exclusive actions in the rules too.
- **Orientation**: landscape is recommended for the Main Game Board on phones (more width for the
  map) with a soft in-app prompt to rotate if a phone is held portrait; portrait is still fully
  functional (just more panning), never blocked outright, since Async-mode players will frequently
  be checking in one-handed.
- **Turn Phase Tracker compresses on mobile**: the six-chip strip (§1.8) collapses to showing only
  the active chip's label plus a small "2 of 6" progress dots row, with the full strip available via
  tap-to-expand, so it doesn't eat vertical space that the map needs.

---

## 4. Color and Iconography Conventions

### 4.1 Resource conventions (Wood, Stone, Food, Ore, Gold)

Each resource has one fixed color + one fixed glyph used identically everywhere it appears
(player rail ledger, cost strings in the Build Menu, Trade/Bank Modal columns, resource-yield
badges on tiles) — consistency here is what lets players read a cost string like "2🪵 + 1🪨" at a
glance without re-parsing labels every time.

| Resource | Glyph (shape-coded, not hue-only) | Base hue | Notes |
|----------|-----------------------------------|----------|-------|
| Wood | Log/plank icon (parallel diagonal lines) | Amber/brown | Paired with Forest terrain fill |
| Stone | Angular rock/block icon | Cool grey | Paired with Hills terrain fill |
| Food | Wheat-sheaf/apple icon | Green | Paired with Plains terrain fill (and River's Food bonus) |
| Ore | Ingot/nugget icon (faceted diamond) | Steel blue | Paired with Mountain terrain fill |
| Gold | Coin icon (circle with inner ring) | Yellow/gold | Paired with Desert terrain fill (scarce/low-yield, so its badge shows a smaller count, not a different color treatment) |

Rule: **color is always paired with a distinct glyph shape and, where text fits, a short label or
count** — never rely on hue alone to distinguish resources, since Ore (steel blue) and Wood
(amber/brown) are the only pair with strong hue separation for all colorblind types; Stone/Gold and
Wood/Food can collide under some deuteranopia/protanopia profiles at small badge sizes if color were
the only signal. See §5.1 for the full colorblind-safety requirement this satisfies.

### 4.2 Player color conventions

- Up to 6 simultaneous players require 6 mutually-distinguishable player colors, assigned by seat
  order at game start and held constant for the whole game (a player's color never changes mid-game,
  since ownership tints/borders and hero-token colors depend on it staying stable).
- Recommended palette (chosen for pairwise distinguishability including under common colorblind
  profiles, each also given a distinct token *shape* as a non-color backup identifier — see §5.1):
  1. Crimson red — circle token
  2. Ocean blue — square token
  3. Forest green — triangle token
  4. Royal purple — diamond token
  5. Burnt orange — pentagon token
  6. Slate teal — star token
- Usage: ownership tint/border on tiles (§2.3 layer 2), hero token fill + shape, player-rail row
  accent, Hero Panel header accent.
- **Active-turn treatment** is a separate visual language from player color (since the active
  player's own color is already fixed and can't also mean "it's your turn" without ambiguity for
  colorblind users): the active player's row/tile/token gets an animated glow/pulse outline in a
  neutral high-contrast color (white/gold ring) layered on top of their player color, plus the
  explicit name+avatar callout in the Turn Phase Tracker (§1.8) as the non-color-dependent source of
  truth for "whose turn is it."

### 4.3 Loot rarity conventions

Common/Uncommon/Rare/Legendary (flat bonuses +1/+2/+3/+5 per canon) each get a fixed border-color +
corner-icon treatment on Loot cards, escalating in visual weight so rarity is skimmable across a
full inventory grid:

| Rarity | Border | Corner icon | Bonus |
|--------|--------|-------------|-------|
| Common | Plain grey | none | +1 |
| Uncommon | Green | single chevron | +2 |
| Rare | Blue | double chevron | +3 |
| Legendary | Gold, subtle animated shimmer | star burst | +5 |

Rarity is additionally spelled out as text on the card (never color-only), consistent with §5.1.

---

## 5. Accessibility Notes

### 5.1 Colorblind-safe resource and player icons

- **Never encode meaning in hue alone.** Every place color carries information — resource type,
  player ownership, rarity, phase state, win/loss result — pairs that color with a redundant
  non-color signal: a distinct glyph/shape (§4.1, §4.2), a text label or count, or a distinct
  border/pattern.
- Provide a **colorblind-safe mode toggle** (in the corner Settings widget, §1.10) that swaps the
  default palette for a higher-contrast, deuteranopia/protanopia/tritanopia-tested alternate palette
  and increases reliance on the shape/pattern signals that are always present — i.e. the toggle
  strengthens an already-required baseline rather than being the only place shapes/labels exist.
- Resource glyphs (§4.1) are chosen to remain distinguishable in greyscale/simulated-colorblind
  rendering as a validation bar: run each new icon through a greyscale check before shipping it.
- Player token shapes (§4.2) exist specifically so "whose tile/hero is this" never depends on
  correctly perceiving 6-way hue differences — shape is the fallback signal at a glance, color is
  the fast-path signal for full-color-vision users. This applies with extra force to the **garrison
  badge** (§2.3 layer 5), which is the one place where a player-coloured element sits on top of a
  *differently*-player-coloured element: the badge carries the owning player's token shape as well
  as their colour, so "those troops aren't the tile owner's" is readable without hue.
- **Occupation is never signalled by colour alone** either — the hatch/dashed treatment (§2.3 layer
  6) is a pattern, and it is always accompanied by the claim-countdown text.
- Minimum contrast: text and icon glyphs against their background meet WCAG AA (4.5:1 for normal
  text, 3:1 for large text/icons) in both the light and dark theme variants of the UI.

### 5.2 Keyboard navigation for phase actions

The game must be fully playable without a pointing device, since the SVG-per-node approach in §2.2
was chosen specifically to make this achievable:

- **Global focus order**: Turn Phase Tracker → Player rail → Hex Map → Hero Panel → Action bar,
  reachable via standard Tab/Shift+Tab, with a visible focus ring (distinct from, and layered above,
  the hover highlight) on whichever element currently has focus.
- **Hex Map keyboard mode**: pressing an arrow key while the map region has focus moves a
  "keyboard cursor" hex-by-hex in the corresponding axial direction (mapped from the six neighbor
  offsets in §2.1, projected to the four arrow keys via nearest-direction mapping since hex grids
  have six neighbors and keyboards have four arrows — Up/Down map to the two "north-ish"/"south-ish"
  neighbor pairs and Left/Right to the remaining two, with the mapping shown in an on-screen legend
  the first time keyboard mode is used). Enter/Space activates the currently-legal action on the
  focused hex (place tile in Phase 1, move-target in Phase 2, gather in Phase 3, initiate fight in
  Phase 4, open Build Menu in Phase 5) — i.e. the keyboard cursor's Enter action is always
  phase-contextual, matching whatever the action bar's primary button for that phase currently does.
- **Phase-scoped tab stops**: only tiles that are legal targets for the current phase's action are
  included in the tab order / arrow-key stops while that phase is active (mirrors the legal-move
  highlight in §2.3 layer 7) — this keeps keyboard traversal from requiring dozens of presses across
  a large map to reach the handful of tiles that actually matter this phase.
- **Modals trap focus**: Fight/Combat and Trade/Bank modals (§1.6, §1.7) trap Tab focus within the
  modal while open and restore focus to the triggering element on close, with Escape mapped to the
  modal's Retreat/Cancel action where the rules permit one.
- **All primary actions have a visible keyboard shortcut hint** in the action bar (e.g. underlined
  access key or a small key-cap glyph) for the phase's default action, so keyboard-first players
  aren't required to tab through the whole surface every turn once they've learned the shortcuts.
- **Screen-reader labeling**: every hex exposes an `aria-label` summarizing its state ("Forest tile,
  owned by Ocean blue, Sawmill built, produces 1 Wood per turn") so the map is not purely a visual
  data source; live regions announce phase transitions and combat results as they happen.

---

File written to `C:\Users\morrossl\Documents\Private\Elenor\docs\ui-spec.md`.