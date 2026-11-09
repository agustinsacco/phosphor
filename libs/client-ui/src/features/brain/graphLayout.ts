import type { BrainEntity, BrainMemory } from '@shared/brain'

export interface Point {
  x: number
  y: number
}
export interface GraphNode extends Point {
  id: string
  label: string
  width: number
}
export interface GraphEdge {
  source: string
  target: string
}
export interface View extends Point {
  scale: number
}
export const GRAPH_WIDTH = 800
export const GRAPH_HEIGHT = 400
export const LABEL_HEIGHT = 28

export function graphEdges(memories: BrainMemory[]): GraphEdge[] {
  return memories.flatMap((memory) =>
    memory.objectId ? [{ source: memory.subjectId, target: memory.objectId }] : [],
  )
}

/** Deterministic force equilibrium; renderer interactions never run the simulation again. */
export function layoutGraph(entities: BrainEntity[], edges: GraphEdge[]): GraphNode[] {
  const nodes = entities.map((entity, index) => ({
    id: entity.id,
    label: entity.label,
    width: Math.max(48, entity.label.length * 14 + 32),
    x: Math.cos((index * Math.PI * 2) / entities.length) * 180,
    y: Math.sin((index * Math.PI * 2) / entities.length) * 140,
  }))
  const indexes = new Map(nodes.map((node, index) => [node.id, index]))
  for (let step = 0; step < Math.min(80, Math.max(10, 20000 / (nodes.length || 1))); step++) {
    simulate(nodes, edges, indexes)
  }
  return separateLabels(nodes)
}

export function simulate(
  nodes: GraphNode[],
  edges: GraphEdge[],
  indexes: Map<string, number>,
): void {
  const forces = nodes.map((node) => ({ x: -node.x * 0.008, y: -node.y * 0.008 }))
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const dx = nodes[i]!.x - nodes[j]!.x || 0.01
      const dy = nodes[i]!.y - nodes[j]!.y || 0.01
      const distance = Math.max(20, Math.hypot(dx, dy))
      const magnitude = 2400 / (distance * distance)
      forces[i]!.x += (dx / distance) * magnitude
      forces[i]!.y += (dy / distance) * magnitude
      forces[j]!.x -= (dx / distance) * magnitude
      forces[j]!.y -= (dy / distance) * magnitude
    }
  }
  for (const edge of edges) {
    const a = indexes.get(edge.source),
      b = indexes.get(edge.target)
    if (a === undefined || b === undefined) continue
    const dx = nodes[b]!.x - nodes[a]!.x,
      dy = nodes[b]!.y - nodes[a]!.y
    const distance = Math.max(1, Math.hypot(dx, dy))
    const force = (distance - 160) * 0.025
    forces[a]!.x += (dx / distance) * force
    forces[a]!.y += (dy / distance) * force
    forces[b]!.x -= (dx / distance) * force
    forces[b]!.y -= (dy / distance) * force
  }
  nodes.forEach((node, index) => {
    node.x += Math.max(-12, Math.min(12, forces[index]!.x))
    node.y += Math.max(-12, Math.min(12, forces[index]!.y))
  })
}

/** Label rectangles include the dot. A sorted sweep moves only downward, so it terminates. */
export function separateLabels(input: GraphNode[]): GraphNode[] {
  const nodes = input
    .map((node) => ({ ...node }))
    .sort((a, b) => a.y - b.y || a.id.localeCompare(b.id))
  nodes.forEach((node, index) => {
    for (let j = 0; j < index; j++) {
      const other = nodes[j]!
      if (
        Math.abs(node.x - other.x) < (node.width + other.width) / 2 + 8 &&
        node.y - other.y < LABEL_HEIGHT + 8
      ) {
        node.y = other.y + LABEL_HEIGHT + 8
      }
    }
  })
  const byId = new Map(nodes.map((node) => [node.id, node]))
  return input.map((node) => byId.get(node.id)!)
}

export function fitGraph(nodes: GraphNode[], width = GRAPH_WIDTH, height = GRAPH_HEIGHT): View {
  if (!nodes.length) return { x: width / 2, y: height / 2, scale: 1 }
  const left = Math.min(...nodes.map((n) => n.x - n.width / 2))
  const right = Math.max(...nodes.map((n) => n.x + n.width / 2))
  const top = Math.min(...nodes.map((n) => n.y - LABEL_HEIGHT / 2))
  const bottom = Math.max(...nodes.map((n) => n.y + LABEL_HEIGHT / 2))
  // Never magnify: a two-node graph keeps its labels at their real size.
  const scale = Math.min(
    1,
    (width - 64) / Math.max(1, right - left),
    (height - 64) / Math.max(1, bottom - top),
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

/** Map a pointer through SVG's default xMidYMid meet letterboxing. */
export function svgPoint(
  point: Point,
  rect: { left: number; top: number; width: number; height: number },
): Point {
  const scale = Math.min(rect.width / GRAPH_WIDTH, rect.height / GRAPH_HEIGHT) || 1
  return {
    x: (point.x - rect.left - (rect.width - GRAPH_WIDTH * scale) / 2) / scale,
    y: (point.y - rect.top - (rect.height - GRAPH_HEIGHT * scale) / 2) / scale,
  }
}
