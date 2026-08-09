'use client';

import { RESOURCE_TYPES, garrisonOwnerOf, hexKey, hexNeighbors, type GameState, type HexCoord, type Tile } from '@/engine';
import { axialToPixel, hexPolygonPoints, type Pixel } from './hexLayout';
import { RESOURCE_ICON, TILE_COLOR, TILE_ICON } from './tileTheme';
import { TILE_ART } from './tileArt';

const HEX_SIZE = 40;

interface HexBoardProps {
  state: GameState;
  highlightCoords?: Set<string>;
  pendingPath?: HexCoord[];
  onTileClick?: (coord: HexCoord) => void;
  selectedCoord?: HexCoord | null;
  /** [DEFAULT — roads] Keys of the viewing player's tiles that are joined to their Capital by
   *  their own road network, i.e. the ones whose stockpile is swept straight into the wallet
   *  every round (engine/selectors.ts's roadConnectedTiles). These behave completely differently
   *  from a tile that needs a hero to walk over and haul the pile home, so they get their own
   *  marking — otherwise the auto-collection is invisible magic. */
  roadConnectedKeys?: Set<string>;
  /** [DEFAULT — roads] First hex picked while the road-building mode is armed. The board draws
   *  a ghost segment along every edge the player could complete from here, so the two-click
   *  "pick a hex, pick its neighbour" flow shows its own result before committing. */
  roadAnchor?: HexCoord | null;
  /** [DEFAULT — territory rework] The tile a MoveSoldiers march is armed from. Ground changes
   *  hands only by Soldiers walking onto it, so the board draws the march itself: the origin
   *  stack is ringed and an arrow points at every adjacent tile the caller listed in
   *  highlightCoords as a legal destination. */
  marchFrom?: HexCoord | null;
  /** Colour of the marching army (the acting player's), so the arrows read as *their* troops. */
  marchColor?: string;
  /** [DEFAULT — Munchkin exploration layer] Keys of currently-reachable-this-turn hexes the
   *  active hero has never stood on — see components/hero/DoorCardPanel.tsx's
   *  unvisitedHighlightKeys. Stepping onto one of these triggers the Door-deck draw
   *  (reducers.ts's resolveDoorCardIfNewTile), so it's worth a small marker: otherwise "first
   *  visit here draws a card" is invisible until it already happened. Only ever populated during
   *  Phase.MoveHero — deliberately a small, glanceable set (this turn's move-range only), not
   *  every unvisited tile on the whole board, to stay a hint rather than noise. */
  unopenedDoorCoords?: Set<string>;
}

/** The two shared corner vertices of the border between two ADJACENT hexes.
 *
 *  For a regular hex grid the shared edge is exactly the segment perpendicular to the
 *  centre-to-centre line, centred on its midpoint, of length `size` (a hexagon's edge length
 *  equals its circumradius). Deriving it that way instead of intersecting two corner lists means
 *  it lands on the true border for any of the six directions with no per-direction table.
 *  `inset` shortens it slightly at both ends so segments meeting at a corner stay readable as
 *  separate pieces of track rather than merging into a blob. */
function sharedEdgePoints(a: HexCoord, b: HexCoord, size: number, inset = 0.9): [Pixel, Pixel] {
  const pa = axialToPixel(a, size);
  const pb = axialToPixel(b, size);
  const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
  const dx = pb.x - pa.x;
  const dy = pb.y - pa.y;
  const len = Math.hypot(dx, dy) || 1;
  // Unit normal to the centre-centre line — points along the shared border.
  const nx = -dy / len;
  const ny = dx / len;
  const half = (size / 2) * inset;
  return [
    { x: mid.x + nx * half, y: mid.y + ny * half },
    { x: mid.x - nx * half, y: mid.y - ny * half },
  ];
}

/** "q1,r1|q2,r2" (engine/types.ts's edgeKey) back into its two endpoints. */
function parseEdgeKey(key: string): [HexCoord, HexCoord] | null {
  const halves = key.split('|');
  if (halves.length !== 2) return null;
  const [a, b] = halves.map(parseKey);
  if ([a.q, a.r, b.q, b.r].some((n) => !Number.isFinite(n))) return null;
  return [a, b];
}

function stockpileTotal(tile: Tile): number {
  return RESOURCE_TYPES.reduce((sum, r) => sum + tile.stockpile[r], 0);
}

function dominantStockpileResource(tile: Tile) {
  return RESOURCE_TYPES.filter((r) => tile.stockpile[r] > 0).sort((a, b) => tile.stockpile[b] - tile.stockpile[a])[0];
}

/** "HuntingLodge" -> "Hunting Lodge", "TradePost" -> "Trade Post", etc. */
function spaceOutLabel(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

export function HexBoard({
  state,
  highlightCoords,
  pendingPath,
  onTileClick,
  selectedCoord,
  roadConnectedKeys,
  roadAnchor,
  marchFrom,
  marchColor = '#f0e6cf',
  unopenedDoorCoords,
}: HexBoardProps) {
  const tiles = Object.values(state.map);
  const allCoords: HexCoord[] = [...tiles.map((t) => t.coord), ...(highlightCoords ? [...highlightCoords].map(parseKey) : [])];

  const pixels = allCoords.map((c) => axialToPixel(c, HEX_SIZE));
  const minX = Math.min(0, ...pixels.map((p) => p.x)) - HEX_SIZE * 2;
  const maxX = Math.max(0, ...pixels.map((p) => p.x)) + HEX_SIZE * 2;
  const minY = Math.min(0, ...pixels.map((p) => p.y)) - HEX_SIZE * 2;
  const maxY = Math.max(0, ...pixels.map((p) => p.y)) + HEX_SIZE * 2;
  const width = maxX - minX;
  const height = maxY - minY;

  const playerColor = new Map(state.players.map((p) => [p.id, p.color]));
  const playerName = new Map(state.players.map((p) => [p.id, p.name]));
  const hexPoints = hexPolygonPoints(HEX_SIZE - 2);
  const supplyRingPoints = hexPolygonPoints(HEX_SIZE - 9);
  const contestedRingPoints = hexPolygonPoints(HEX_SIZE - 5);

  /** Every laid road segment, resolved back to its two hexes and its owner's colour. Roads are
   *  keyed by edge, so this is the whole network in one pass — no per-tile dedupe needed. */
  // `?? {}` guards a GameState persisted before roads existed (an online room row, or a hot-
  // reloaded in-memory game from an older build) — the board should still draw, just roadless.
  const roadSegments = Object.entries(state.roads ?? {}).flatMap(([key, ownerId]) => {
    const parsed = parseEdgeKey(key);
    if (!parsed) return [];
    return [{ key, ends: sharedEdgePoints(parsed[0], parsed[1], HEX_SIZE), color: playerColor.get(ownerId) ?? '#d9a441' }];
  });

  /** Edges the player could complete from the armed anchor: its placed neighbours that the
   *  caller has marked as legal targets (highlightCoords) and that carry no road yet. */
  const candidateEdges = roadAnchor
    ? hexNeighbors(roadAnchor)
        .filter((n) => highlightCoords?.has(hexKey(n)) && !!state.map[hexKey(n)])
        .map((n) => ({ key: hexKey(n), ends: sharedEdgePoints(roadAnchor, n, HEX_SIZE) }))
    : [];

  /** One arrow per legal march destination, drawn from just outside the origin stack to just
   *  short of the target's centre. The panel spells out what each destination DOES (reinforce /
   *  occupy / battle); this is the spatial half of that — which way the troops are about to walk. */
  const marchArrows = marchFrom
    ? hexNeighbors(marchFrom)
        .filter((n) => highlightCoords?.has(hexKey(n)) && !!state.map[hexKey(n)])
        .map((n) => {
          const from = axialToPixel(marchFrom, HEX_SIZE);
          const to = axialToPixel(n, HEX_SIZE);
          const lerp = (t: number) => ({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
          return { key: hexKey(n), a: lerp(0.34), b: lerp(0.72) };
        })
    : [];

  return (
    <svg
      viewBox={`${minX} ${minY} ${width} ${height}`}
      className="h-full w-full touch-none select-none"
      role="img"
      aria-label="Hex world map"
    >
      <defs>
        <clipPath id="hexClip" clipPathUnits="userSpaceOnUse">
          <polygon points={hexPoints} />
        </clipPath>
        <filter id="tokenShadow" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="1.5" stdDeviation="1.5" floodColor="#000" floodOpacity="0.55" />
        </filter>
        {/* Warm inner wash for a tile the supply network reaches — soft enough to read as
            lamplight over the hex art rather than a debug tint. */}
        <radialGradient id="supplyGlow" cx="50%" cy="50%" r="50%">
          <stop offset="45%" stopColor="#f2c869" stopOpacity="0" />
          <stop offset="100%" stopColor="#f2c869" stopOpacity="0.3" />
        </radialGradient>
        <marker id="marchHead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4.5" markerHeight="4.5" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={marchColor} stroke="#14110c" strokeWidth={1} />
        </marker>
      </defs>

      {/* Placed tiles */}
      {tiles.map((tile) => {
        const { x, y } = axialToPixel(tile.coord, HEX_SIZE);
        const key = hexKey(tile.coord);
        const isSelected = selectedCoord && selectedCoord.q === tile.coord.q && selectedCoord.r === tile.coord.r;
        const isHighlighted = highlightCoords?.has(key);
        const ownerColor = tile.ownerId ? playerColor.get(tile.ownerId) : undefined;
        const art = TILE_ART[tile.type];
        const isRoadConnected = roadConnectedKeys?.has(key) ?? false;
        const isRoadAnchor = !!roadAnchor && roadAnchor.q === tile.coord.q && roadAnchor.r === tile.coord.r;
        const isMarchOrigin = !!marchFrom && marchFrom.q === tile.coord.q && marchFrom.r === tile.coord.r;

        // WHOSE soldiers these are is a different question from who owns the ground — see
        // engine/reducers.ts's garrisonOwnerOf. An invading stack standing on captured ground must
        // never be painted in the defender's colours; that mis-read is exactly what made a rival's
        // troops look like they'd "vanished" the moment they crossed a border.
        const garrisonOwner = garrisonOwnerOf(tile);
        const garrisonSize = tile.militiaCount ?? 0;
        const garrisonColor = (garrisonOwner && playerColor.get(garrisonOwner)) || '#b23a3a';
        const garrisonName = (garrisonOwner && playerName.get(garrisonOwner)) || 'Unclaimed';
        const isForeignGarrison = !!garrisonOwner && garrisonOwner !== tile.ownerId;
        // Ground taken but not yet owned: the flag only changes at the start of a LATER turn of
        // the occupier's (reducers.ts's claimHeldTerritory), so the defender gets a round to
        // march back. That deadline is the single most actionable fact on a contested hex.
        const contestedSince = isForeignGarrison ? tile.occupationSinceRound : undefined;

        return (
          <g
            key={key}
            transform={`translate(${x},${y})`}
            onClick={() => onTileClick?.(tile.coord)}
            className={onTileClick ? 'group cursor-pointer' : ''}
          >
            {art ? (
              <>
                <image
                  href={art}
                  x={-HEX_SIZE}
                  y={-HEX_SIZE}
                  width={HEX_SIZE * 2}
                  height={HEX_SIZE * 2}
                  clipPath="url(#hexClip)"
                  preserveAspectRatio="xMidYMid slice"
                  opacity={tile.type === 'Volcano' && tile.isTamed ? 0.55 : 1}
                />
                {ownerColor && <polygon points={hexPoints} fill={ownerColor} opacity={0.16} />}
              </>
            ) : (
              <polygon
                points={hexPoints}
                fill={TILE_COLOR[tile.type]}
                opacity={tile.type === 'Volcano' && tile.isTamed ? 0.6 : 1}
              />
            )}
            <polygon points={hexPoints} fill="none" stroke={ownerColor ?? 'rgba(240,230,207,0.18)'} strokeWidth={ownerColor ? 3 : 1} />
            {onTileClick && (
              <polygon
                points={hexPoints}
                fill="#f2c869"
                opacity={0}
                className="pointer-events-none motion-safe:transition-opacity motion-safe:duration-150 group-hover:opacity-20"
              />
            )}
            {isHighlighted && <polygon points={hexPoints} fill="#f2c869" opacity={0.3} />}
            {isSelected && <polygon points={hexPoints} fill="none" stroke="#f2c869" strokeWidth={3} />}
            {/* Supply-network marking: this tile's stockpile goes straight to the wallet each
                round, no hero visit. Rendered as a wash plus an inner dashed ring so it survives
                on top of the painted tile art without hiding it. */}
            {isRoadConnected && (
              <>
                <polygon points={hexPoints} fill="url(#supplyGlow)" className="pointer-events-none" />
                <polygon
                  points={supplyRingPoints}
                  fill="none"
                  stroke="#f2c869"
                  strokeWidth={1.25}
                  strokeDasharray="5 4"
                  opacity={0.7}
                  className="pointer-events-none"
                />
              </>
            )}
            {isRoadAnchor && (
              <polygon
                points={hexPoints}
                fill="none"
                stroke="#f2c869"
                strokeWidth={3}
                strokeDasharray="7 4"
                className="pointer-events-none motion-safe:animate-pulse"
              />
            )}
            {isMarchOrigin && (
              <polygon
                points={hexPoints}
                fill="none"
                stroke={marchColor}
                strokeWidth={3.5}
                strokeDasharray="9 5"
                className="pointer-events-none motion-safe:animate-pulse"
              />
            )}
            {/* Contested ground: someone else's army is standing on this tile and the clock is
                running on the claim. Ringed in the OCCUPIER's colour, inside the owner's border,
                so both facts are visible at once. */}
            {contestedSince !== undefined && (
              <polygon
                points={contestedRingPoints}
                fill="none"
                stroke={garrisonColor}
                strokeWidth={3}
                strokeDasharray="6 5"
                opacity={0.95}
                className="pointer-events-none motion-safe:animate-pulse"
              />
            )}

            {!art && (
              <text textAnchor="middle" dy={-8} fontSize={16}>
                {TILE_ICON[tile.type]}
              </text>
            )}

            {tile.building && (
              <g transform="translate(0,20)">
                <rect x={-30} y={-8} width={60} height={13} rx={3} fill="#14110c" opacity={0.72} />
                <text textAnchor="middle" dy={2} fontSize={8} fill="#f2c869" fontWeight={600} fontFamily="Georgia, serif">
                  {spaceOutLabel(tile.building.type)}
                </text>
              </g>
            )}
            {tile.type === 'Ruins' && tile.monsterDenCardId && (
              <text textAnchor="middle" dy={14} fontSize={13} filter="url(#tokenShadow)">
                👹
              </text>
            )}
            {/* Garrison strength. Deliberately the loudest token on the hex — a border tile's
                troop count is the one number that decides every territory fight, and it is filled
                with the colour of the army that is ACTUALLY standing there. A foreign stack also
                gets a pale outer casing and a banner icon so "these troops are not the landlord's"
                survives even a colour-blind read. */}
            {garrisonSize > 0 && (
              <g transform="translate(0,-26)" filter="url(#tokenShadow)">
                <title>
                  {`${garrisonSize} Soldier${garrisonSize === 1 ? '' : 's'} — ${garrisonName}'s troops` +
                    (isForeignGarrison
                      ? ` occupying ${tile.ownerId ? `${playerName.get(tile.ownerId) ?? 'a rival'}'s` : 'neutral'} ground`
                      : ' (this tile is theirs)')}
                </title>
                {isForeignGarrison && (
                  <rect x={-23} y={-11.5} width={46} height={22} rx={6} fill="#f0e6cf" opacity={0.9} className="motion-safe:animate-pulse" />
                )}
                <rect x={-20} y={-9.5} width={40} height={19} rx={5} fill={garrisonColor} stroke="#14110c" strokeWidth={1.5} />
                <text textAnchor="middle" dy={4} fontSize={12} fill="#14110c" fontWeight={800} fontFamily="Georgia, serif">
                  {isForeignGarrison ? '⚑' : '⚔'} {garrisonSize}
                </text>
              </g>
            )}
            {/* The claim deadline, spelled out. Ownership flips at the start of the occupier's
                turn in any LATER round than the one they arrived in — i.e. next round. */}
            {contestedSince !== undefined && (
              <g transform="translate(0,-7)" className="pointer-events-none">
                <title>
                  {`${garrisonName} took this ground in round ${contestedSince}. If their Soldiers are still standing here at the start of their turn in round ${contestedSince + 1}, the tile becomes theirs.`}
                </title>
                <rect x={-32} y={-7} width={64} height={14} rx={3} fill="#14110c" opacity={0.88} stroke={garrisonColor} strokeWidth={1.25} />
                <text textAnchor="middle" dy={3.5} fontSize={7.5} fill="#f0e6cf" fontWeight={700} fontFamily="Georgia, serif" letterSpacing="0.5">
                  CONTESTED · R{contestedSince + 1}
                </text>
              </g>
            )}
            {isRoadConnected && (
              <g transform="translate(-23,3)" filter="url(#tokenShadow)" className="pointer-events-none">
                <title>Road-connected — this tile&rsquo;s stockpile is collected automatically each round</title>
                <circle r={9} fill="#14110c" stroke="#f2c869" strokeWidth={1.25} />
                <text textAnchor="middle" dy={3.5} fontSize={9}>
                  🛣️
                </text>
              </g>
            )}
            {/* [DEFAULT — Munchkin exploration layer] First-ever visit here draws a Door card
                (reducers.ts's resolveDoorCardIfNewTile) — a small, glanceable heads-up on the
                handful of hexes the hero could actually walk to this turn, not a permanent mark
                on the whole map. */}
            {unopenedDoorCoords?.has(key) && (
              <g transform="translate(-23,-24)" filter="url(#tokenShadow)" className="pointer-events-none motion-safe:animate-float">
                <title>First visit — stepping here draws a Door card</title>
                <circle r={8} fill="#14110c" stroke="#8c6cd0" strokeWidth={1.25} />
                <text textAnchor="middle" dy={3} fontSize={9}>
                  🚪
                </text>
              </g>
            )}
            {tile.ownerId && stockpileTotal(tile) > 0 && (
              <g transform="translate(23,3)" filter="url(#tokenShadow)">
                <title>{`${stockpileTotal(tile)} uncollected resource${stockpileTotal(tile) === 1 ? '' : 's'} waiting here`}</title>
                <circle r={9} fill="#14110c" stroke="#d9a441" strokeWidth={1.25} />
                <text textAnchor="middle" dy={3.5} fontSize={8} fill="#f2c869">
                  {RESOURCE_ICON[dominantStockpileResource(tile)!]}
                  {stockpileTotal(tile)}
                </text>
              </g>
            )}
          </g>
        );
      })}

      {/* Placement/movement highlight hexes for empty, not-yet-placed targets */}
      {highlightCoords &&
        [...highlightCoords]
          .map(parseKey)
          .filter((c) => !state.map[hexKey(c)])
          .map((c) => {
            const { x, y } = axialToPixel(c, HEX_SIZE);
            return (
              <g key={`ghost-${hexKey(c)}`} transform={`translate(${x},${y})`} onClick={() => onTileClick?.(c)} className="group cursor-pointer">
                <polygon
                  points={hexPoints}
                  fill="#f2c869"
                  opacity={0.16}
                  stroke="#d9a441"
                  strokeDasharray="4 3"
                  strokeWidth={1.5}
                  className="motion-safe:transition-opacity motion-safe:duration-150 group-hover:opacity-40"
                />
              </g>
            );
          })}

      {/* Roads. Each segment is drawn ON the shared border of the two hexes it joins (see
          sharedEdgePoints): a dark casing seats it into the map, the owner's colour identifies
          whose supply line it is, and a pale dashed centreline gives it the texture of a track
          rather than a plain highlight rule. */}
      {roadSegments.length > 0 && (
        <g className="pointer-events-none">
          {roadSegments.map(({ key, ends, color }) => (
            <g key={`road-${key}`}>
              <line x1={ends[0].x} y1={ends[0].y} x2={ends[1].x} y2={ends[1].y} stroke="#14110c" strokeWidth={7} strokeLinecap="round" opacity={0.85} />
              <line x1={ends[0].x} y1={ends[0].y} x2={ends[1].x} y2={ends[1].y} stroke={color} strokeWidth={4.5} strokeLinecap="round" />
              <line
                x1={ends[0].x}
                y1={ends[0].y}
                x2={ends[1].x}
                y2={ends[1].y}
                stroke="#f0e6cf"
                strokeWidth={1.25}
                strokeLinecap="butt"
                strokeDasharray="3 4"
                opacity={0.55}
              />
            </g>
          ))}
        </g>
      )}

      {/* Road-building preview: every border the armed anchor could still be joined along. */}
      {candidateEdges.length > 0 && (
        <g className="pointer-events-none">
          {candidateEdges.map(({ key, ends }) => (
            <line
              key={`road-candidate-${key}`}
              x1={ends[0].x}
              y1={ends[0].y}
              x2={ends[1].x}
              y2={ends[1].y}
              stroke="#f2c869"
              strokeWidth={4}
              strokeLinecap="round"
              strokeDasharray="5 5"
              opacity={0.75}
            />
          ))}
        </g>
      )}

      {/* Armed march: every adjacent tile these Soldiers could walk onto this turn. */}
      {marchArrows.length > 0 && (
        <g className="pointer-events-none">
          {marchArrows.map(({ key, a, b }) => (
            <line
              key={`march-${key}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={marchColor}
              strokeWidth={3.5}
              strokeLinecap="round"
              markerEnd="url(#marchHead)"
              opacity={0.9}
            />
          ))}
        </g>
      )}

      {/* Pending movement path */}
      {pendingPath && pendingPath.length > 0 && (
        <polyline
          points={pendingPath.map((c) => {
            const p = axialToPixel(c, HEX_SIZE);
            return `${p.x},${p.y}`;
          }).join(' ')}
          fill="none"
          stroke="#f2c869"
          strokeWidth={3}
          strokeDasharray="6 4"
          strokeLinecap="round"
        />
      )}

      {/* Hero markers */}
      {state.players.map((p) => (
        <HeroMarker key={p.hero.id} coord={p.hero.position} color={p.color} label={p.name[0]?.toUpperCase() ?? '?'} />
      ))}
    </svg>
  );
}

function HeroMarker({ coord, color, label }: { coord: HexCoord; color: string; label: string }) {
  const { x, y } = axialToPixel(coord, HEX_SIZE);
  return (
    <g transform={`translate(${x}, ${y + 16})`} filter="url(#tokenShadow)">
      <circle r={10.5} fill="#14110c" />
      <circle r={9.5} fill={color} stroke="#f2c869" strokeWidth={1.25} />
      <text textAnchor="middle" dy={4} fontSize={10.5} fill="#14110c" fontWeight={800} fontFamily="Georgia, serif">
        {label}
      </text>
    </g>
  );
}

function parseKey(key: string): HexCoord {
  const [q, r] = key.split(',').map(Number);
  return { q, r };
}
