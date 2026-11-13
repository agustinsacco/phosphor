import { BRAIN_PREDICATES } from '@phosphor/shared/brain'
import type { Context } from './database'
import { job } from './jobs'
import { entity } from './entities'
import { memoryCard } from './knowledge'
import { encodeVector } from './vectors'
import type { Citation, Proposal } from './types'

export function validateProposal(ctx: Context, value: Proposal): void {
  if (!job(ctx, value.jobId)) throw new Error('Brain job not found.')
  if (
    value.memoryVectors.length !== value.memories.length ||
    value.entityVectors.length !== value.entities.length
  )
    throw new Error('Brain proposal vector count is invalid.')
  if (value.memories.length + value.confirmations.length > 300)
    throw new Error('Brain proposal exceeds the 300 memory budget.')
  const refs = new Set(value.entities.map((item) => item.ref))
  if (refs.size !== value.entities.length) throw new Error('Duplicate Brain identity ref.')
  const checkEntity = (id: string) => {
    if (!refs.has(id) && !entity(ctx, id)) throw new Error('Brain proposal entity not found.')
  }
  const citation = (item: Citation) => {
    if (!Number.isInteger(item.evidence) || !value.evidence[item.evidence] || !item.quote.trim())
      throw new Error('Brain citation evidence not found.')
  }
  const target = (id: string) => {
    if (memoryCard(ctx, id).state === 'superseded')
      throw new Error('Brain target is no longer active.')
  }
  for (const item of value.entities) {
    if (!item.ref || !item.label.trim()) throw new Error('Brain identity is invalid.')
    if (item.decision === 'reuse' && !item.entityId)
      throw new Error('Brain reused identity has no target.')
    for (const id of [...item.candidates, ...(item.entityId ? [item.entityId] : [])])
      if (!entity(ctx, id)) throw new Error('Brain identity target not found.')
  }
  for (const item of [...value.memories, ...value.confirmations.map((c) => c.claim)]) {
    item.entities.forEach(checkEntity)
    for (const link of item.links) {
      checkEntity(link.subject)
      checkEntity(link.object)
      citation(link.citation)
      if (!BRAIN_PREDICATES.includes(link.predicate)) throw new Error('Brain predicate is invalid.')
    }
    item.citations.forEach(citation)
    if ((item.action === 'add') !== (item.target === null))
      throw new Error('Brain action target is invalid.')
    if (item.target) target(item.target)
  }
  for (const item of value.confirmations) {
    target(item.memoryId)
    if (item.claim.action !== 'add' || item.claim.target !== null)
      throw new Error('Brain confirmation claim must be an add.')
    encodeVector(item.vector)
  }
  for (const group of value.groups) {
    group.members.forEach(checkEntity)
    if (
      group.parent.entityId &&
      !refs.has(group.parent.entityId) &&
      !entity(ctx, group.parent.entityId)
    )
      throw new Error('Brain group parent not found.')
  }
  value.memoryVectors.forEach(encodeVector)
  value.entityVectors.forEach(encodeVector)
}
