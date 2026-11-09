import type { BrainEntity, BrainMemory } from '@shared/brain'
import { layoutStats, nearbyPairs } from './graphGrid'

export { layoutStats }

export interface Point {
  x: number
  y: number
}
export interface GraphNode extends Point {
  id: string
  label: string
  width: number
  radius: number
  vx: number
  vy: number
  fx?: number
  fy?: number
}
export interface GraphEdge {
  source: string
  target: string
  predicate?: string
}
export interface View extends Point {
  scale: number
}
export interface Simulation {
  nodes: GraphNode[]
  edges: GraphEdge[]
  alpha: number
}
export const GRAPH_WIDTH = 800
export const GRAPH_HEIGHT = 400
export const LABEL_HEIGHT = 16
export const LINK_DISTANCE = 140
export const ALPHA_MIN = 0.001
const ALPHA_DECAY = 1 - Math.pow(ALPHA_MIN, 1 / 300)
/** Beyond this, repulsion is negligible next to gravity, so far nodes are never compared. */
const REPULSION_RANGE = 3 * LINK_DISTANCE

export function graphEdges(memories: BrainMemory[]): GraphEdge[] {
  return memories.flatMap((memory) =>
    memory.objectId
      ? [{ source: memory.subjectId, target: memory.objectId, predicate: memory.predicate }]
      : [],
  )
}

export function graphLabel(label: string): string {
  return label.length > 32 ? `${label.slice(0, 31)}…` : label
}

function seed(id: string): Point {
  let hash = 2166136261
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  const angle = ((hash >>> 0) / 4294967296) * Math.PI * 2
  const radius = 40 + ((hash >>> 8) % 180)
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
}

/** Refresh preserves world coordinates; new entities start beside a known neighbour. */
export function createSimulation(
  entities: BrainEntity[],
  edges: GraphEdge[],
  previous: GraphNode[] = [],
): Simulation {
  const byId = new Map(previous.map((node) => [node.id, node]))
  const degree = new Map<string, number>()
  for (const { source, target } of edges) {
    degree.set(source, (degree.get(source) ?? 0) + 1)
    degree.set(target, (degree.get(target) ?? 0) + 1)
  }
  const nodes = entities.map((entity) => {
    const old = byId.get(entity.id)
    const link = edges.find((edge) =>
      edge.source === entity.id
        ? byId.has(edge.target)
        : edge.target === entity.id && byId.has(edge.source),
    )
    const neighbor = link && byId.get(link.source === entity.id ? link.target : link.source)
    const offset = seed(entity.id)
    const position =
      old ??
      (neighbor
        ? { x: neighbor.x + offset.x * 0.2, y: neighbor.y + offset.y * 0.2 }
        : previous.length
          ? { x: offset.x * 0.2, y: offset.y * 0.2 }
          : offset)
    const radius = 4 + 2 * Math.sqrt(degree.get(entity.id) ?? 0)
    return {
      vx: 0,
      vy: 0,
      ...old,
      ...position,
      id: entity.id,
      label: entity.label,
      radius,
      width: radius * 2 + 6 + graphLabel(entity.label).length * 7,
    }
  })
  return { nodes, edges, alpha: nodes.length ? 1 : 0 }
}

export function labelBox(node: GraphNode): {
  left: number
  right: number
  top: number
  bottom: number
} {
  const halfHeight = Math.max(LABEL_HEIGHT / 2, node.radius)
  return {
    left: node.x - node.radius,
    right: node.x - node.radius + node.width,
    top: node.y - halfHeight,
    bottom: node.y + halfHeight,
  }
}

function boxCentre(node: GraphNode): Point {
  return { x: node.x - node.radius + node.width / 2, y: node.y }
}

function repel(a: GraphNode, b: GraphNode, alpha: number): void {
  const dx = b.x - a.x || 0.01
  const dy = b.y - a.y || 0.01
  const distance = Math.max(12, Math.hypot(dx, dy))
  if (distance > REPULSION_RANGE) return
  const force = (4000 * alpha) / (distance * distance)
  a.vx -= (dx / distance) * force
  a.vy -= (dy / distance) * force
  b.vx += (dx / distance) * force
  b.vy += (dy / distance) * force
}

function spring(a: GraphNode, b: GraphNode, alpha: number): void {
  const dx = b.x - a.x,
    dy = b.y - a.y
  const distance = Math.max(1, Math.hypot(dx, dy))
  const force = (distance - LINK_DISTANCE) * 0.04 * alpha
  a.vx += (dx / distance) * force
  a.vy += (dy / distance) * force
  b.vx -= (dx / distance) * force
  b.vy -= (dy / distance) * force
}

/**
 * Symmetric minimum-axis collision includes the circle and right-aligned label, not a pill.
 * Inlined box maths: this runs for every nearby pair, eight times a tick. Returns whether it moved.
 */
function collide(a: GraphNode, b: GraphNode): boolean {
  const aLeft = a.x - a.radius,
    bLeft = b.x - b.radius
  const aHalf = Math.max(LABEL_HEIGHT / 2, a.radius),
    bHalf = Math.max(LABEL_HEIGHT / 2, b.radius)
  const overlapX = Math.min(aLeft + a.width, bLeft + b.width) - Math.max(aLeft, bLeft) + 4
  if (overlapX <= 0) return false
  const overlapY = Math.min(a.y + aHalf, b.y + bHalf) - Math.max(a.y - aHalf, b.y - bHalf) + 4
  if (overlapY <= 0) return false
  const axis = overlapX < overlapY ? 'x' : 'y'
  const pin = axis === 'x' ? 'fx' : 'fy'
  const freeA = a[pin] === undefined,
    freeB = b[pin] === undefined
  const count = Number(freeA) + Number(freeB)
  if (!count) return false
  const centerA = axis === 'x' ? aLeft * 2 + a.width : a.y
  const centerB = axis === 'x' ? bLeft * 2 + b.width : b.y
  const shift = ((axis === 'x' ? overlapX : overlapY) + 0.01) / count
  const direction = centerA < centerB || (centerA === centerB && a.id < b.id) ? -1 : 1
  if (freeA) a[axis] += shift * direction
  if (freeB) b[axis] -= shift * direction
  return true
}

/** Collision passes until nothing moves; dense clusters get more passes on the final tick. */
function separate(nodes: GraphNode[], passes: number): void {
  // Boxes overlap only when their centres are closer than the widest box plus the gap.
  let width = 4,
    height = LABEL_HEIGHT + 4
  for (const node of nodes) {
    width = Math.max(width, node.width + 4)
    height = Math.max(height, node.radius * 2 + 4)
  }
  for (let pass = 0; pass < passes; pass++) {
    let moved = false
    nearbyPairs(nodes, boxCentre, width, height, (a, b) => {
      if (collide(a, b)) moved = true
    })
    if (!moved) return
  }
}

export function tickSimulation(simulation: Simulation): void {
  const { nodes, edges, alpha } = simulation
  const byId = new Map(nodes.map((node) => [node.id, node]))
  layoutStats.ticks++
  nearbyPairs(
    nodes,
    (node) => node,
    REPULSION_RANGE,
    REPULSION_RANGE,
    (a, b) => repel(a, b, alpha),
  )
  for (const edge of edges) {
    const a = byId.get(edge.source),
      b = byId.get(edge.target)
    if (a && b && a !== b) spring(a, b, alpha)
  }
  for (const node of nodes) {
    node.vx = (node.vx - node.x * 0.003 * alpha) * 0.6
    node.vy = (node.vy - node.y * 0.003 * alpha) * 0.6
    node.x = node.fx ?? node.x + node.vx
    node.y = node.fy ?? node.y + node.vy
    if (node.fx !== undefined) node.vx = 0
    if (node.fy !== undefined) node.vy = 0
  }
  simulation.alpha *= 1 - ALPHA_DECAY
  // Collision does not cool: even the final frame must leave labels readable.
  separate(nodes, simulation.alpha > ALPHA_MIN ? 8 : 64)
}

export function settleSimulation(simulation: Simulation): void {
  while (simulation.alpha > ALPHA_MIN) tickSimulation(simulation)
}

export function layoutGraph(entities: BrainEntity[], edges: GraphEdge[]): GraphNode[] {
  const simulation = createSimulation(entities, edges)
  settleSimulation(simulation)
  return simulation.nodes
}

export function fitGraph(nodes: GraphNode[], width = GRAPH_WIDTH, height = GRAPH_HEIGHT): View {
  if (!nodes.length) return { x: width / 2, y: height / 2, scale: 1 }
  const boxes = nodes.map(labelBox)
  const left = Math.min(...boxes.map((box) => box.left))
  const right = Math.max(...boxes.map((box) => box.right))
  const top = Math.min(...boxes.map((box) => box.top))
  const bottom = Math.max(...boxes.map((box) => box.bottom))
  const scale = Math.max(
    0.001,
    // Up to 125%: a small graph fills its pane without labels growing large.
    Math.min(
      1.25,
      (width - 64) / Math.max(1, right - left),
      (height - 64) / Math.max(1, bottom - top),
    ),
  )
  return {
    x: width / 2 - ((left + right) / 2) * scale,
    y: height / 2 - ((top + bottom) / 2) * scale,
    scale,
  }
}

export function zoomView(view: View, factor: number, anchor: Point): View {
  const scale = Math.max(0.02, Math.min(8, view.scale * factor))
  return {
    scale,
    x: anchor.x - ((anchor.x - view.x) * scale) / view.scale,
    y: anchor.y - ((anchor.y - view.y) * scale) / view.scale,
  }
}

export function worldPoint(point: Point, view: View): Point {
  return { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale }
}

/** Defaults support unmeasured containers; the renderer supplies its measured viewBox. */
export function svgPoint(
  point: Point,
  rect: { left: number; top: number; width: number; height: number },
  size = { width: GRAPH_WIDTH, height: GRAPH_HEIGHT },
): Point {
  const scale = Math.min(rect.width / size.width, rect.height / size.height) || 1
  return {
    x: (point.x - rect.left - (rect.width - size.width * scale) / 2) / scale,
    y: (point.y - rect.top - (rect.height - size.height * scale) / 2) / scale,
  }
}
