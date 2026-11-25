import type { MapBox, MapNode } from '../explorer/mapLayout'
import { inside, overlaps } from '../explorer/mapLayout'

/** One edge's words, wanted on the map, most important first. */
export interface EdgeLabelRequest {
  key: string
  text: string
  x1: number
  y1: number
  x2: number
  y2: number
}
export interface EdgeLabel {
  key: string
  text: string
  x: number
  y: number
  box: MapBox
}

const CHAR_WIDTH = 5.6
const HEIGHT = 12
/** Where along the line a label may sit: the middle first, then either side of it. */
const POSITIONS = [0.5, 0.38, 0.62, 0.28, 0.72]

function nodeBoxes(nodes: MapNode[]): MapBox[] {
  return nodes.flatMap((node) => [
    { x: node.x - node.r, y: node.y - node.r, width: node.r * 2, height: node.r * 2 },
    ...(node.caption ? [node.caption.box] : []),
  ])
}

/**
 * Words along edges, placed where they cover no node, name or earlier label, inside the map.
 * A label that fits nowhere is left out; the edge still says its sentence on hover.
 */
export function placeEdgeLabels(
  requests: EdgeLabelRequest[],
  nodes: MapNode[],
  width: number,
  height: number,
): Map<string, EdgeLabel> {
  const frame = { x: 0, y: 0, width, height }
  const taken = nodeBoxes(nodes)
  const placed = new Map<string, EdgeLabel>()
  for (const request of requests) {
    const w = request.text.length * CHAR_WIDTH
    for (const at of POSITIONS) {
      const x = request.x1 + (request.x2 - request.x1) * at
      const y = request.y1 + (request.y2 - request.y1) * at
      const box = { x: x - w / 2 - 2, y: y - HEIGHT / 2, width: w + 4, height: HEIGHT }
      if (!inside(box, frame) || taken.some((other) => overlaps(box, other))) continue
      placed.set(request.key, { key: request.key, text: request.text, x, y: y + 4, box })
      taken.push(box)
      break
    }
  }
  return placed
}
