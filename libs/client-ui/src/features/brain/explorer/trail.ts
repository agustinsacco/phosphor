export interface BrainVisit {
  kind: 'entity' | 'memory'
  id: string
  label: string
}
export interface BrainTrail {
  items: BrainVisit[]
  index: number
}
export const initialTrail: BrainTrail = { items: [], index: -1 }
export function visitTrail(trail: BrainTrail, visit: BrainVisit): BrainTrail {
  const current = trail.items[trail.index]
  if (current?.id === visit.id && current.kind === visit.kind) return trail
  return { items: [...trail.items.slice(0, trail.index + 1), visit], index: trail.index + 1 }
}
export function moveTrail(trail: BrainTrail, delta: number): BrainTrail {
  return { ...trail, index: Math.max(-1, Math.min(trail.items.length - 1, trail.index + delta)) }
}
