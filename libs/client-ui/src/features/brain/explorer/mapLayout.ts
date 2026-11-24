import type { BrainEntityKind, BrainPredicate } from '@shared/brain'

/**
 * The 2D map's geometry, kept apart from React so it is testable: the selection in the
 * centre, neighbours on rings by step, the strongest kept when there are too many, and
 * labels placed only where they collide with nothing already drawn.
 */
export interface MapNodeInput {
  id: string
  label: string
  kind: BrainEntityKind
  memories: number
}
export interface MapLinkInput {
  id: string
  subjectId: string
  objectId: string
  predicate: BrainPredicate
}
export interface MapBox {
  x: number
  y: number
  width: number
  height: number
}
export interface MapLabel {
  text: string
  x: number
  y: number
  anchor: 'start' | 'middle' | 'end'
  box: MapBox
}
export interface MapNode extends MapNodeInput {
  x: number
  y: number
  r: number
  ring: 0 | 1 | 2
  /** Where its name is drawn, or null when it would collide with something. */
  caption: MapLabel | null
}
/** One line per pair of drawn entities, however many links join them. */
export interface MapEdge<L extends MapLinkInput = MapLinkInput> {
  key: string
  from: string
  to: string
  links: L[]
}
export interface MapLayout<L extends MapLinkInput = MapLinkInput> {
  nodes: MapNode[]
  edges: MapEdge<L>[]
  /** Neighbours left out to keep the map readable. */
  hidden: number
}

/** Beyond this many neighbours the strongest are drawn and the rest counted. */
export const MAP_NEIGHBOUR_LIMIT = 24
const CHAR_WIDTH = 6.2
const LABEL_HEIGHT = 13
const LABEL_GAP = 3
const MARGIN = 6
const LONG_LABEL = 18
const SHORT_LABEL = 10

export function layoutMap<L extends MapLinkInput>({
  centerId,
  nodes,
  links,
  hops,
  width,
  height,
  limit = MAP_NEIGHBOUR_LIMIT,
}: {
  centerId: string
  nodes: MapNodeInput[]
  links: L[]
  hops: 1 | 2
  width: number
  height: number
  limit?: number
}): MapLayout<L> {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const center = byId.get(centerId)
  if (!center || width <= 0 || height <= 0) return { nodes: [], edges: [], hidden: 0 }
  const rings = ringsFrom(centerId, links, hops, byId)
  const strength = linkCounts(centerId, links)
  const order = (ids: string[]): string[] =>
    ids.toSorted((a, b) => {
      const left = byId.get(a)!,
        right = byId.get(b)!
      return (
        (strength.get(b) ?? 0) - (strength.get(a) ?? 0) ||
        right.memories - left.memories ||
        left.label.localeCompare(right.label) ||
        a.localeCompare(b)
      )
    })
  const first = order(rings[1])
  const second = order(rings[2])
  const shownFirst = first.slice(0, limit)
  const shownSecond = second.slice(0, Math.max(0, limit - shownFirst.length))
  const hidden = first.length + second.length - shownFirst.length - shownSecond.length
  const maxMemories = Math.max(1, ...nodes.map((node) => node.memories))
  const placed = placeRings(center, [shownFirst, shownSecond], byId, maxMemories, width, height)
  const drawn = new Set(placed.map((node) => node.id))
  return { nodes: placeLabels(placed, width, height), edges: edgesBetween(links, drawn), hidden }
}

function ringsFrom(
  centerId: string,
  links: MapLinkInput[],
  hops: 1 | 2,
  byId: Map<string, MapNodeInput>,
): Record<1 | 2, string[]> {
  const seen = new Map<string, number>([[centerId, 0]])
  let frontier = [centerId]
  for (let step = 1; step <= hops; step++) {
    const next: string[] = []
    for (const id of frontier)
      for (const link of links) {
        const other =
          link.subjectId === id ? link.objectId : link.objectId === id ? link.subjectId : null
        if (other && byId.has(other) && !seen.has(other)) {
          seen.set(other, step)
          next.push(other)
        }
      }
    frontier = next
  }
  const ring = (step: number): string[] =>
    [...seen].filter(([, value]) => value === step).map(([id]) => id)
  return { 1: ring(1), 2: ring(2) }
}

function linkCounts(centerId: string, links: MapLinkInput[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const link of links) {
    const other =
      link.subjectId === centerId ? link.objectId : link.objectId === centerId ? link.subjectId : ''
    if (other) counts.set(other, (counts.get(other) ?? 0) + 1)
  }
  return counts
}

function placeRings(
  center: MapNodeInput,
  rings: [string[], string[]],
  byId: Map<string, MapNodeInput>,
  maxMemories: number,
  width: number,
  height: number,
): Omit<MapNode, 'caption'>[] {
  const cx = width / 2,
    cy = height / 2
  // Leave room for one label line under the outermost ring.
  const reach = Math.max(10, Math.min(width / 2, height / 2) - MARGIN - LABEL_HEIGHT - 4)
  const outer = rings[1].length ? reach : reach * 0.9
  const inner = rings[1].length ? reach * 0.55 : outer
  const crowd = Math.max(rings[0].length, rings[1].length, 1)
  // Neighbours on a full ring never touch: their diameter fits the arc between them.
  const roomy = (2 * Math.PI * inner) / crowd / 2 - 2
  const scale = Math.max(2.5, Math.min(10, roomy))
  const size = (node: MapNodeInput): number =>
    Math.max(2.5, Math.min(scale, 3 + (scale - 3) * Math.sqrt(node.memories / maxMemories)))
  const placed: Omit<MapNode, 'caption'>[] = [
    { ...center, x: cx, y: cy, r: Math.min(12, Math.max(6, inner / 4)), ring: 0 },
  ]
  rings.forEach((ids, index) => {
    const radius = index === 0 ? inner : outer
    ids.forEach((id, position) => {
      const angle =
        (position / ids.length) * 2 * Math.PI - Math.PI / 2 + (index ? Math.PI / ids.length : 0)
      const node = byId.get(id)!
      placed.push({
        ...node,
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
        r: size(node),
        ring: (index + 1) as 1 | 2,
      })
    })
  })
  return placed
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

export function overlaps(a: MapBox, b: MapBox): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

function candidates(node: Omit<MapNode, 'caption'>, text: string, cx: number): MapLabel[] {
  const w = text.length * CHAR_WIDTH
  const below = {
    text,
    x: node.x,
    y: node.y + node.r + LABEL_GAP + LABEL_HEIGHT - 3,
    anchor: 'middle' as const,
    box: { x: node.x - w / 2, y: node.y + node.r + LABEL_GAP, width: w, height: LABEL_HEIGHT },
  }
  const above = {
    ...below,
    y: node.y - node.r - LABEL_GAP - 3,
    box: { ...below.box, y: node.y - node.r - LABEL_GAP - LABEL_HEIGHT },
  }
  const right = node.x >= cx
  const side = {
    text,
    x: node.x + (right ? 1 : -1) * (node.r + LABEL_GAP),
    y: node.y + 4,
    anchor: right ? ('start' as const) : ('end' as const),
    box: {
      x: right ? node.x + node.r + LABEL_GAP : node.x - node.r - LABEL_GAP - w,
      y: node.y - LABEL_HEIGHT / 2,
      width: w,
      height: LABEL_HEIGHT,
    },
  }
  return node.ring === 0 ? [below, above] : [side, below, above]
}

/** Most important first; a label that would cover a node or another label moves or goes. */
function placeLabels(placed: Omit<MapNode, 'caption'>[], width: number, height: number): MapNode[] {
  const frame = { x: 0, y: 0, width, height }
  const taken: MapBox[] = placed.map((node) => ({
    x: node.x - node.r,
    y: node.y - node.r,
    width: node.r * 2,
    height: node.r * 2,
  }))
  const priority = placed
    .map((node, index) => ({ node, index }))
    .toSorted((a, b) => a.node.ring - b.node.ring || b.node.memories - a.node.memories)
  const labels = new Map<number, MapLabel>()
  for (const { node, index } of priority) {
    const own = taken[index]!
    for (const max of [LONG_LABEL, SHORT_LABEL]) {
      const text = truncate(node.label, max)
      const label = candidates(node, text, width / 2).find(
        (option) =>
          inside(option.box, frame) &&
          taken.every((box) => box === own || !overlaps(option.box, box)),
      )
      if (label) {
        labels.set(index, label)
        taken.push(label.box)
        break
      }
    }
  }
  return placed.map((node, index) => ({ ...node, caption: labels.get(index) ?? null }))
}

export function inside(box: MapBox, frame: MapBox): boolean {
  return (
    box.x >= frame.x &&
    box.y >= frame.y &&
    box.x + box.width <= frame.x + frame.width &&
    box.y + box.height <= frame.y + frame.height
  )
}

function edgesBetween<L extends MapLinkInput>(links: L[], drawn: Set<string>): MapEdge<L>[] {
  const edges = new Map<string, MapEdge<L>>()
  for (const link of links) {
    if (!drawn.has(link.subjectId) || !drawn.has(link.objectId)) continue
    if (link.subjectId === link.objectId) continue
    const [from, to] = [link.subjectId, link.objectId].sort() as [string, string]
    const key = `${from}|${to}`
    const edge: MapEdge<L> = edges.get(key) ?? { key, from, to, links: [] }
    if (
      !edge.links.some(
        (known) => known.predicate === link.predicate && known.subjectId === link.subjectId,
      )
    )
      edge.links.push(link)
    edges.set(key, edge)
  }
  return [...edges.values()]
}
