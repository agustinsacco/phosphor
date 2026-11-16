import { Vector3, type Camera } from 'three'
import type SpriteText from 'three-spritetext'
import { graphEndpoint, type GraphLink, type GraphModel, type GraphNode } from './graphModel'

export interface LabelCandidate {
  label: SpriteText
  /** Where the label sits in the scene, or null before the layout has placed it. */
  at: () => { x: number; y: number; z: number } | null
  /** CSS pixel height the label is drawn at. */
  pixels: number
  /** A selected or hovered label shows whatever it covers. */
  pinned: boolean
}
interface Box {
  left: number
  right: number
  top: number
  bottom: number
}

const point = new Vector3()

/** Order the labels a paint left visible: selected or hovered, lit nodes, link words, then the rest. */
export function rankLabels(
  model: GraphModel,
  labels: Map<string, SpriteText>,
  predicates: Map<GraphLink, SpriteText>,
  pinned: Set<string>,
): LabelCandidate[] {
  const nodes = new Map(model.nodes.map((node) => [node.id, node]))
  const spot = (node: GraphNode | undefined, lift = 0) =>
    node && Number.isFinite(node.x) ? { x: node.x!, y: (node.y ?? 0) + lift, z: node.z ?? 0 } : null
  const tier = (node: GraphNode): number =>
    pinned.has(node.id) ? 0 : labels.get(node.id)!.material.opacity === 1 ? 1 : 3
  const ranked = model.nodes
    .filter((node) => labels.get(node.id)!.visible)
    .map((node) => ({
      tier: tier(node),
      val: node.val,
      id: node.id,
      label: labels.get(node.id)!,
      at: () => spot(node, 4 * Math.cbrt(node.val) + 4),
      pixels: 12,
    }))
  const words = model.links
    .filter((link) => predicates.get(link)!.visible)
    .map((link) => ({
      tier: 2,
      val: 0,
      id: link.id,
      label: predicates.get(link)!,
      at: () => {
        const from = spot(nodes.get(graphEndpoint(link.source)))
        const to = spot(nodes.get(graphEndpoint(link.target)))
        return from && to
          ? { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, z: (from.z + to.z) / 2 }
          : null
      },
      pixels: 11,
    }))
  return [...ranked, ...words]
    .sort((a, b) => a.tier - b.tier || b.val - a.val || a.id.localeCompare(b.id))
    .map(({ label, at, pixels, tier }) => ({ label, at, pixels, pinned: tier === 0 }))
}

/**
 * Walk the labels from most to least important and show one only if it covers no label already
 * shown. Labels keep one size on screen, so a dense graph would otherwise pile them up.
 */
export function declutterLabels(
  candidates: LabelCandidate[],
  camera: Camera,
  width: number,
  height: number,
): void {
  const shown: Box[] = []
  for (const { label, at, pixels, pinned } of candidates) {
    const position = at()
    if (!position) continue
    point.set(position.x, position.y, position.z).project(camera)
    const x = ((point.x + 1) / 2) * width
    const y = ((1 - point.y) / 2) * height
    const half = (pixels / 2) * (label.scale.x / label.scale.y) + 3
    const box = {
      left: x - half,
      right: x + half,
      top: y - pixels / 2 - 2,
      bottom: y + pixels / 2 + 2,
    }
    const free =
      pinned ||
      !shown.some(
        (other) =>
          box.left < other.right &&
          box.right > other.left &&
          box.top < other.bottom &&
          box.bottom > other.top,
      )
    label.visible = free && Math.abs(point.z) <= 1
    if (label.visible) shown.push(box)
  }
}
