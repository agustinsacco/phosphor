import type { BrainReviewDecision } from '@shared/brain'
export function buildReviewDecision(
  memories: number[],
  identities: Record<string, string>,
  groups: number[],
): BrainReviewDecision {
  return {
    memories: [...memories].sort((a, b) => a - b),
    identities: { ...identities },
    groups: [...groups].sort((a, b) => a - b),
  }
}
