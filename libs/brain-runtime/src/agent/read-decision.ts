import type { BrainDecideRead } from '@phosphor/shared/brain-agent'
import {
  BRAIN_DECISION_REFUSALS,
  checkBrainReviewDecision,
  type BrainProposalView,
  type BrainReviewDecision,
} from '@phosphor/shared/brain-review'

/**
 * How many unanswered refs a refusal names before "and N more", each clipped, so the refusal
 * fits the 400 characters brain_decide_read shows of a write message.
 */
const NAMED_REFS = 10
const REF_MAX = 20

/**
 * The decision Brain Agent's approval means against the stored proposal: by default every memory
 * that is not held. A sentence instead when a memory it would save names a required identity it
 * has not answered, or when the choices break the shared decision rules.
 */
export function readDecision(
  p: BrainProposalView,
  params: Omit<BrainDecideRead, 'jobId' | 'revision' | 'approve' | 'reason'>,
): { decision: BrainReviewDecision } | { problem: string } {
  const identities = Object.fromEntries((params.identities ?? []).map((i) => [i.ref, i.answer]))
  const memories = params.memories ?? p.memories.filter((m) => !m.hold).map((m) => m.index)
  const confirmations = params.confirmations ?? []
  const named = new Set([
    ...p.memories.filter((m) => memories.includes(m.index)).flatMap((m) => m.entities),
    ...p.confirmations
      .filter((c, index) => !c.claim.hold || confirmations.includes(index))
      .flatMap((c) => c.claim.entities),
  ])
  const unanswered = p.identities
    .filter((i) => i.required && named.has(i.ref) && !Object.hasOwn(identities, i.ref))
    .map((i) => (i.ref.length > REF_MAX ? `${i.ref.slice(0, REF_MAX - 1)}…` : i.ref))
  if (unanswered.length) {
    const more = unanswered.length - NAMED_REFS
    const refs = unanswered.slice(0, NAMED_REFS).join(', ') + (more > 0 ? ` and ${more} more` : '')
    return {
      problem: `Not approved: answer ${refs} first, in identities ({ ref, answer: an entity id or "new" }). Open brain_read_review for their candidates.`,
    }
  }
  const decision = {
    memories,
    identities,
    groups: params.groups ?? [],
    descriptions: params.descriptions ?? [],
    confirmations,
  }
  try {
    // The shared shape rules every decision meets: unique indexes, each list within its size.
    return { decision: checkBrainReviewDecision(decision)! }
  } catch (error) {
    return { problem: error instanceof Error ? error.message : BRAIN_DECISION_REFUSALS.selection }
  }
}
