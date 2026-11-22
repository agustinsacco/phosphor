import type { BrainReviewDecision } from '@phosphor/shared/brain'
import type { BrainService } from '../types'

/** Decides a read as Brain Agent does, with brain_decide_read's choices spelling out `decision`. */
export async function decideRead(
  service: BrainService,
  jobId: string,
  decision: BrainReviewDecision | null,
  revision: number,
) {
  const choices =
    decision === null
      ? { approve: false }
      : {
          approve: true,
          memories: decision.memories,
          identities: Object.entries(decision.identities).map(([ref, answer]) => ({ ref, answer })),
          groups: decision.groups,
          descriptions: decision.descriptions,
          confirmations: decision.confirmations,
        }
  const result = await service.agent('decideRead', {
    jobId,
    ...choices,
    revision,
    reason: 'The lasting memories have evidence in this read.',
  })
  if (result.status !== 'done') throw new Error(result.message)
  return service.api.status()
}
