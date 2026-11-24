import { brainLinkSentence, type BrainLink } from '@shared/brain'

/** One step of a walk: where it arrived, and the relationship it followed, if any. */
export interface WalkStep {
  id: string
  label: string
  link: BrainLink | null
  /** The followed relationship as a sentence; null for a jump from search or the map. */
  sentence: string | null
}
/** The steps taken so far; `index` is the one on screen, later ones wait for Forward. */
export interface Walk {
  steps: WalkStep[]
  index: number
}
export const NO_WALK: Walk = { steps: [], index: -1 }

/** A step to `to` from `from` along `link`, worded subject to object. */
export function walkStep(
  from: { id: string; label: string },
  to: { id: string; label: string },
  link: BrainLink | null,
): WalkStep {
  if (!link) return { id: to.id, label: to.label, link: null, sentence: null }
  const name = (id: string): string => (id === from.id ? from.label : to.label)
  return {
    id: to.id,
    label: to.label,
    link,
    sentence: brainLinkSentence(link, name(link.subjectId), name(link.objectId)),
  }
}

/**
 * Add a step after the one on screen; later steps are dropped. An empty walk first records
 * where it started, so Back returns there. Stepping to where the walk already is does nothing.
 */
export function walkTo(
  walk: Walk,
  start: { id: string; label: string } | null,
  step: WalkStep,
): Walk {
  const steps = walk.index < 0 ? (start ? [walkStep(start, start, null)] : []) : walk.steps
  const kept = steps.slice(0, walk.index < 0 ? steps.length : walk.index + 1)
  if (kept.at(-1)?.id === step.id && !step.link) return { steps: kept, index: kept.length - 1 }
  return { steps: [...kept, step], index: kept.length }
}

/** Back (-1) or Forward (+1), never past the first or last step. */
export function moveWalk(walk: Walk, delta: number): Walk {
  if (walk.index < 0) return walk
  return { ...walk, index: Math.max(0, Math.min(walk.steps.length - 1, walk.index + delta)) }
}
