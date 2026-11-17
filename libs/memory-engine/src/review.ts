import type { BrainTidyTouched } from '@phosphor/shared/brain-tidy'
import type { BrainReviewDecision } from '@phosphor/shared/brain'
import { all, run, transaction, type Context } from './database'
import {
  addNames,
  cleanOrphans,
  createEntity,
  entity,
  entityNumber,
  recountEntities,
} from './entities'
import { applyMemory, activeMemoryNumber, insertCitations, type CommitContext } from './commit'
import { linkOutcome, pruneExtractions } from './extractions'
import { job, removeJob, updateJob } from './jobs'
import { laneMemories } from './history'
import { removeMemory } from './merge'
import { bumpRevision, revision } from './prefs'
import { readProposal } from './proposals'
import type { Proposal, ProposalMemory } from './types'

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
): BrainTidyTouched {
  const touched = new Set<number>(),
    touchedMemories = new Set<number>()
  transaction(ctx, () => {
    const value = readProposal(ctx, jobId)
    if (expectedRevision !== revision(ctx) || value.computedRevision !== revision(ctx))
      throw new Error('Brain changed while you were reviewing. Reopen the review.')
    const current = job(ctx, jobId)!
    if (!decision && current.replaces) {
      removeJob(ctx, jobId)
      return
    }
    if (decision) validateDecision(ctx, value, decision)
    if (decision) {
      const commit: CommitContext = {
        ctx,
        proposal: value,
        resolve: resolver(ctx, value, decision),
        evidence: new Map(),
        touched,
        touchedMemories,
      }
      for (const index of new Set(decision.memories)) {
        const item = value.memories[index]!
        const id = applyMemory(
          commit,
          identityChanged(item, value, decision) ? { ...item, action: 'add', target: null } : item,
          value.memoryVectors[index],
        )
        linkOutcome(ctx, jobId, index, id)
      }
      applyGroups(commit, decision.groups)
      for (const confirmation of value.confirmations) {
        if (identityChanged(confirmation.claim, value, decision)) {
          applyMemory(
            commit,
            { ...confirmation.claim, action: 'add', target: null },
            confirmation.vector,
          )
        } else {
          const target = activeMemoryNumber(ctx, confirmation.memoryId)
          if (target !== undefined) insertCitations(commit, target, confirmation.claim.citations)
        }
      }
      const replaced = current.replaces
        ? laneMemories(ctx, current.sessionId, jobId).replaceable
        : []
      for (const id of replaced) removeMemory(ctx, id)
      cleanOrphans(ctx, touched)
      recountEntities(ctx, touched)
      if (
        decision.memories.length ||
        decision.groups.length ||
        value.confirmations.length ||
        replaced.length
      )
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
  return touchedIds(ctx, touched, touchedMemories)
}
function touchedIds(
  ctx: Context,
  touched: Set<number>,
  touchedMemories: Set<number>,
): BrainTidyTouched {
  return {
    entityIds: all<{ id: string }>(
      ctx,
      'SELECT id FROM entities WHERE n IN (SELECT value FROM json_each(?))',
      JSON.stringify([...touched]),
    ).map((r) => r.id),
    memoryIds: all<{ id: string }>(
      ctx,
      'SELECT id FROM memories WHERE n IN (SELECT value FROM json_each(?))',
      JSON.stringify([...touchedMemories]),
    ).map((r) => r.id),
  }
}

function identityChanged(
  item: ProposalMemory,
  value: Proposal,
  decision: BrainReviewDecision,
): boolean {
  return [...item.entities, ...item.links.flatMap((link) => [link.subject, link.object])].some(
    (ref) => {
      const override = decision.identities[ref]
      const old = value.entities.find((entity) => entity.ref === ref)
      return (
        override !== undefined && override !== (old?.decision === 'reuse' ? old.entityId : 'new')
      )
    },
  )
}
