/** A step in the Knowledge trail. An entity step may open one of its memories in place. */
export type BrainVisit =
  | { kind: 'entity'; id: string; label: string; memoryId?: string }
  | { kind: 'memory'; id: string; label: string }
export interface BrainTrail {
  items: BrainVisit[]
  index: number
}
export const initialTrail: BrainTrail = { items: [], index: -1 }
export function visitTrail(trail: BrainTrail, visit: BrainVisit): BrainTrail {
  const current = trail.items[trail.index]
  if (
    current?.id === visit.id &&
    current.kind === visit.kind &&
    (current.kind === 'memory' || current.memoryId === (visit.kind === 'entity' ? visit.memoryId : undefined))
  )
    return trail
  return { items: [...trail.items.slice(0, trail.index + 1), visit], index: trail.index + 1 }
}
export function moveTrail(trail: BrainTrail, delta: number): BrainTrail {
  return { ...trail, index: Math.max(-1, Math.min(trail.items.length - 1, trail.index + delta)) }
}
/** A memory step becomes the profile of the entity it names, with that memory open. */
export function replaceTrailStep(trail: BrainTrail, visit: BrainVisit): BrainTrail {
  if (trail.index < 0) return trail
  const items = [...trail.items]
  items[trail.index] = visit
  return { ...trail, items }
}
