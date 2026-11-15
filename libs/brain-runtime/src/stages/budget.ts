import { BRAIN_STRUCTURAL_PREDICATES } from '@phosphor/shared/brain'
import { CLAIM_BUDGET } from '../constants'
import type { FoldedJob } from './fold'

export function applyClaimBudget(job: FoldedJob): number {
  const priority = (c: (typeof job.claims)[number]): number =>
    c.memory.links.some((l) => BRAIN_STRUCTURAL_PREDICATES.some((p) => p === l.predicate))
      ? 0
      : ['decision', 'risk', 'open'].includes(c.memory.type)
        ? 1
        : 2
  const selected = new Set(
    [...job.claims].sort((a, b) => priority(a) - priority(b)).slice(0, CLAIM_BUDGET),
  )
  const held = job.claims.filter((c) => !selected.has(c))
  for (const c of held)
    job.outcomes.push({
      candidate: c.ref,
      summary: c.memory.summary,
      status: 'held',
      reason: 'Per-job 300 claim budget',
    })
  job.claims = job.claims.filter((c) => selected.has(c))
  return held.length
}
