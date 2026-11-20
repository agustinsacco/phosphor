import type { BrainReadReview } from '@phosphor/shared/brain-agent'
import type { BrainIdentity, BrainProposedMemory } from '@phosphor/shared/brain-review'
import { compose, data } from './curator-format'

function identityLine(identity: BrainIdentity): string {
  const as =
    identity.decision === 'reuse' && identity.entityId ? ` as entity ${identity.entityId}` : ''
  const required = identity.required ? ' · REQUIRED' : ''
  const description = identity.description ? ` · ${data(identity.description, 200)}` : ''
  const candidates = identity.candidates
    .map(
      (c) =>
        `${c.id} = ${data(c.label, 120)} (${c.kind}${c.description ? `, ${data(c.description, 160)}` : ''})`,
    )
    .join('; ')
  return `- ${identity.ref} · ${data(identity.label, 120)} (${identity.kind}) · ${identity.decision}${as}${required}${description} · candidates: ${candidates || 'none'} · ${data(identity.reason, 300)}`
}

function memoryLine(memory: BrainProposedMemory): string {
  const target = memory.target
    ? ` memory ${memory.target.id} ("${data(memory.target.summary, 200)}")`
    : ''
  const held = memory.hold ? ` · HELD (${memory.hold}): saved only if you list it` : ''
  const quote = memory.quotes[0] ? ` · quote "${data(memory.quotes[0].quote, 240)}"` : ''
  return `- ${memory.index} · ${memory.type} · ${memory.action}${target}${held} · ${data(memory.summary, 600)} · names ${memory.entities.join(', ') || 'none'}${quote}`
}

/** A read's proposal: what Brain Agent must answer, then what approving saves. */
export function formatReview(review: BrainReadReview): string {
  const p = review.proposal
  const required = p.identities.filter((identity) => identity.required)
  const head = [
    `Read ${p.job.id} · "${data(p.job.title || 'Untitled lane', 120)}" · revision ${p.revision}.`,
    review.neverRead
      ? `Brain never reads this lane: reject it with brain_decide_read { jobId: "${p.job.id}", revision: ${p.revision}, approve: false, reason }.`
      : `Decide with brain_decide_read { jobId: "${p.job.id}", revision: ${p.revision}, approve, reason }. Approving saves every memory that is not held unless you pass memories.`,
    ...(required.length
      ? [
          `Answer before approving: ${required.map((i) => i.ref).join(', ')} (in identities, an entity id or "new").`,
        ]
      : []),
  ]
  const lines = [
    ...(p.identities.length
      ? [
          'Identities (identities: { ref: entity id or "new" }; unanswered ones keep Brain’s decision):',
        ]
      : []),
    ...p.identities.map(identityLine),
    ...(p.groups.length ? ['Groups (list the indexes you confirm in groups):'] : []),
    ...p.groups.map(
      (g) =>
        `- ${g.index} · are ${data(g.labels.join(', '), 300)} part of one ${data(g.parent.label, 120)} (${g.parent.kind})?`,
    ),
    'Memories (indexes for memories):',
    ...p.memories.map(memoryLine),
    ...(p.confirmations.length
      ? ['Said again (saved with any approval; held ones only if listed in confirmations):']
      : []),
    ...p.confirmations.map(
      (c, index) =>
        `- ${index} · memory ${c.id} · ${data(c.summary || c.claim.summary, 400)}${c.claim.hold ? ` · HELD (${c.claim.hold})` : ''}`,
    ),
    ...(p.replacingMemories
      ? [`Approving replaces ${p.replacingMemories} earlier memories from this lane.`]
      : []),
    ...(p.held ? [`${p.held} more claims were over this read's budget and are not proposed.`] : []),
  ]
  return compose(head, lines, (omitted) =>
    omitted
      ? `${omitted} more lines not shown; indexes you cannot see still count. Decide on what you can see, or reject.`
      : null,
  )
}
