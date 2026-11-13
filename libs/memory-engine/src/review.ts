import type { BrainReviewDecision } from '@phosphor/shared/brain'
import { run, transaction, type Context } from './database'
import {
  addNames,
  cleanOrphans,
  createEntity,
  entity,
  entityNumber,
  recountEntities,
} from './entities'
import { applyMemory, insertCitations, type CommitContext } from './commit'
import { linkOutcome, pruneExtractions } from './extractions'
import { updateJob } from './jobs'
import { memoryNumber } from './knowledge'
import { bumpRevision, revision } from './prefs'
import { readProposal } from './proposals'
import type { Proposal } from './types'

function validateDecision(ctx: Context, value: Proposal, decision: BrainReviewDecision): void {
  for (const [indexes, length] of [
    [decision.memories, value.memories.length],
    [decision.groups, value.groups.length],
  ] as const) {
    for (const index of indexes)
      if (!Number.isInteger(index) || index < 0 || index >= length)
        throw new Error('Brain proposal index is invalid.')
  }
  for (const [ref, target] of Object.entries(decision.identities)) {
    if (
      !value.entities.some((item) => item.ref === ref) ||
      (target !== 'new' && !entity(ctx, target))
    )
      throw new Error('Brain identity override is invalid.')
  }
}
function resolver(ctx: Context, value: Proposal, decision: BrainReviewDecision) {
  const resolved = new Map<string, string>()
  return (ref: string): string => {
    const cached = resolved.get(ref)
    if (cached) return cached
    const index = value.entities.findIndex((item) => item.ref === ref)
    const item = value.entities[index]
    if (!item) {
      entityNumber(ctx, ref)
      return ref
    }
    const override = decision.identities[ref]
    const reuse = override
      ? override === 'new'
        ? null
        : override
      : item.decision === 'reuse'
        ? item.entityId
        : null
    const id = reuse ?? createEntity(ctx, item, value.entityVectors[index])
    if (reuse) addNames(ctx, entityNumber(ctx, reuse), [item.label, ...item.aliases], item.keys)
    resolved.set(ref, id)
    return id
  }
}
function applyGroups(commit: CommitContext, groups: number[]): void {
  const { ctx, proposal, resolve } = commit
  for (const index of new Set(groups)) {
    const group = proposal.groups[index]!
    const parent = group.parent.entityId
      ? resolve(group.parent.entityId)
      : createEntity(ctx, { ...group.parent, aliases: [], description: '', keys: [] })
    for (const member of group.members) {
      const id = resolve(member)
      if (id === parent) continue
      const summary = `${entity(ctx, id)!.label} is part of ${entity(ctx, parent)!.label}.`
      const evidence = proposal.evidence.length
      proposal.evidence.push({
        sessionId: proposal.origin.sessionId,
        entryId: `review:${proposal.jobId}:${index}:${id}`,
        role: 'user',
        label: 'Stated by you in review',
        observedAt: ctx.now(),
        text: summary,
      })
      applyMemory(commit, {
        summary,
        type: 'fact',
        kind: 'reported',
        entities: [id, parent],
        links: [
          {
            subject: id,
            predicate: 'part_of',
            object: parent,
            citation: { evidence, quote: summary },
          },
        ],
        branch: false,
        validFrom: null,
        validTo: null,
        action: 'add',
        target: null,
        reason: '',
        citations: [{ evidence, quote: summary }],
      })
    }
  }
}
export function review(
  ctx: Context,
  jobId: string,
  decision: BrainReviewDecision | null,
  expectedRevision: number,
): void {
  transaction(ctx, () => {
    const value = readProposal(ctx, jobId)
    if (expectedRevision !== revision(ctx) || value.computedRevision !== revision(ctx))
      throw new Error('Brain changed while you were reviewing. Reopen the review.')
    if (decision) validateDecision(ctx, value, decision)
    const touched = new Set<number>()
    if (decision) {
      const commit: CommitContext = {
        ctx,
        proposal: value,
        resolve: resolver(ctx, value, decision),
        evidence: new Map(),
        touched,
      }
      for (const index of new Set(decision.memories)) {
        const item = value.memories[index]!
        // An identity override invalidates reconciliation involving that ref.
        const refs = [
          ...item.entities,
          ...item.links.flatMap((link) => [link.subject, link.object]),
        ]
        const changed = refs.some((ref) => {
          const override = decision.identities[ref]
          const old = value.entities.find((entity) => entity.ref === ref)
          return (
            override !== undefined &&
            override !== (old?.decision === 'reuse' ? old.entityId : 'new')
          )
        })
        const id = applyMemory(
          commit,
          changed ? { ...item, action: 'add', target: null } : item,
          value.memoryVectors[index],
        )
        linkOutcome(ctx, jobId, index, id)
      }
      applyGroups(commit, decision.groups)
      for (const confirmation of value.confirmations)
        insertCitations(commit, memoryNumber(ctx, confirmation.memoryId), confirmation.citations)
      cleanOrphans(ctx, touched)
      recountEntities(ctx, touched)
      if (decision.memories.length || decision.groups.length || value.confirmations.length)
        bumpRevision(ctx)
    }
    updateJob(ctx, jobId, {
      state: 'done',
      memories: decision?.memories.length ?? 0,
      finishedAt: ctx.now(),
    })
    run(ctx, 'DELETE FROM proposals WHERE job_id=?', jobId)
    pruneExtractions(ctx)
  })
}
