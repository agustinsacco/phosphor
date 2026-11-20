import type { BrainReviewDecision } from '@phosphor/shared/brain'
import type { BrainService } from '../types'

export async function decideRead(
  service: BrainService,
  jobId: string,
  decision: BrainReviewDecision | null,
  revision: number,
) {
  const result = await service.agent('decideRead', {
    jobId, decision, revision, reason: 'The lasting memories have evidence in this read.',
  })
  if (result.status !== 'done') throw new Error(result.message)
  return service.api.status()
}
