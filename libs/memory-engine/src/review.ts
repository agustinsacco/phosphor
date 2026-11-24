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
  refreshEntityWords,
  replaceEntityVector,
} from './entities'
import { scrubExcerpt } from './secrets'
import { applyMemory, activeMemoryNumber, insertCitations, type CommitContext } from './commit'
import { linkOutcome, pruneExtractions } from './extractions'
import { job, updateJob } from './jobs'
import { laneMemories } from './history'
import { removeMemory } from './merge'
import { bumpKnowledgeRevision, knowledgeRevision } from './prefs'
import { readProposal } from './proposals'
import type { Proposal, ProposalMemory } from './types'

/** The removed brain-review contract's wording, kept here until saveRead replaces this file. */
export const BRAIN_REVIEW_CHANGED = 'Brain changed while you were reviewing. Reopen the review.'
const BRAIN_DECISION_REFUSALS = {
  index: 'Brain proposal index is invalid.',
  identity: 'Brain identity override is invalid.',
  description: 'Brain description choice is invalid.',
  confirmation: 'Brain confirmation choice is invalid.',
} as const
const brainRequiredAnswerRefusal = (label: string): string =>
  `Say whether “${label}” is someone Brain already knows or someone new before approving.`

function validateDecision(ctx: Context, value: Proposal, decision: BrainReviewDecision): void {
  for (const [indexes, length] of [
    [decision.memories, value.memories.length],
    [decision.groups, value.groups.length],
  ] as const) {
    for (const index of indexes)
      if (!Number.isInteger(index) || index < 0 || index >= length)
        throw new Error(BRAIN_DECISION_REFUSALS.index)
  }
  for (const [ref, target] of Object.entries(decision.identities)) {
    if (
      !value.entities.some((item) => item.ref === ref) ||
      (target !== 'new' && !entity(ctx, target))
    )
      throw new Error(BRAIN_DECISION_REFUSALS.identity)
  }
  for (const ref of decision.descriptions)
    if (!value.entities.find((item) => item.ref === ref)?.description.trim())
      throw new Error(BRAIN_DECISION_REFUSALS.description)
  const ticked = decision.confirmations
  if (
    new Set(ticked).size !== ticked.length ||
    ticked.some((index) => !Number.isInteger(index) || !value.confirmations[index]?.claim.hold)
  )
    throw new Error(BRAIN_DECISION_REFUSALS.confirmation)
  // Every ref this approval resolves: ticked memories, confirmed groups, and confirmations that
  // become new memories because the decider changed one of their identities.
  const used = new Set([
    ...decision.memories.flatMap((index) => claimRefs(value.memories[index]!)),
    ...decision.groups.flatMap((index) => {
      const group = value.groups[index]!
      return [...group.members, ...(group.parent.entityId ? [group.parent.entityId] : [])]
    }),
    ...appliedConfirmations(value, decision)
      .filter((confirmation) => identityChanged(confirmation.claim, value, decision))
      .flatMap((confirmation) => claimRefs(confirmation.claim)),
  ])
  const unanswered = value.entities.find(
    (item) => item.required && used.has(item.ref) && !(item.ref in decision.identities),
  )
  if (unanswered) throw new Error(brainRequiredAnswerRefusal(unanswered.label))
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
    if (reuse) {
      const n = entityNumber(ctx, reuse)
      addNames(ctx, n, [item.label, ...item.aliases], item.keys)
      // The read's description replaces the stored one only when the decider chose it, and its
      // vector (label, kind and this description) replaces the stored vector with it.
      if (decision.descriptions.includes(ref)) {
        run(ctx, 'UPDATE entities SET description=? WHERE n=?', scrubExcerpt(item.description), n)
        refreshEntityWords(ctx, n)
        const vector = value.entityVectors[index]
        if (vector) replaceEntityVector(ctx, n, vector)
      }
    }
    resolved.set(ref, id)
    return id
  }
}
/** Only group answers create decider evidence; other choices keep the lane's original evidence. */
function applyGroups(commit: CommitContext, groups: number[], who: 'you' | 'agent'): void {
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
        role: who === 'agent' ? 'assistant' : 'user',
        label: who === 'agent' ? 'Brain Agent, in review' : 'Stated by you in review',
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
  return transaction(ctx, () => reviewChange(ctx, jobId, decision, expectedRevision))
}
/** Caller owns the transaction; agent decisions defer incidental finished-read pruning. */
export function reviewChange(
  ctx: Context,
  jobId: string,
  decision: BrainReviewDecision | null,
  expectedRevision: number,
  retainForUndo = false,
  who: 'you' | 'agent' = 'you',
): BrainTidyTouched {
  const touched = new Set<number>(),
    touchedMemories = new Set<number>()
  const value = readProposal(ctx, jobId)
  if (
    decision !== null &&
    (expectedRevision !== knowledgeRevision(ctx) ||
      value.computedRevision !== knowledgeRevision(ctx))
  )
    throw new Error(BRAIN_REVIEW_CHANGED)
  const current = job(ctx, jobId)!
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
    applyGroups(commit, decision.groups, who)
    const confirmed = applyConfirmations(commit, decision)
    const replaced = current.replaces ? laneMemories(ctx, current.sessionId, jobId).replaceable : []
    for (const id of replaced) removeMemory(ctx, id)
    cleanOrphans(ctx, touched)
    recountEntities(ctx, touched)
    if (decision.memories.length || decision.groups.length || confirmed || replaced.length)
      bumpKnowledgeRevision(ctx)
  }
  updateJob(
    ctx,
    jobId,
    {
      state: decision ? 'done' : 'rejected',
      memories: decision?.memories.length ?? 0,
      finishedAt: ctx.now(),
    },
    !retainForUndo,
  )
  run(ctx, 'DELETE FROM proposals WHERE job_id=?', jobId)
  if (!retainForUndo) pruneExtractions(ctx)
  return touchedIds(ctx, touched, touchedMemories)
}
/** Every confirmation that is not held, and the held ones the decider ticked. */
function appliedConfirmations(
  value: Proposal,
  decision: BrainReviewDecision,
): Proposal['confirmations'] {
  return value.confirmations.filter(
    (confirmation, index) => !confirmation.claim.hold || decision.confirmations.includes(index),
  )
}
/**
 * A confirmation adds its quotes to the memory it repeats, or becomes a new memory when the
 * decider changed one of its identities. A held one does neither unless ticked. Returns how many
 * applied.
 */
function applyConfirmations(commit: CommitContext, decision: BrainReviewDecision): number {
  const { ctx, proposal } = commit
  const applied = appliedConfirmations(proposal, decision)
  for (const confirmation of applied) {
    if (identityChanged(confirmation.claim, proposal, decision)) {
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
  return applied.length
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

/** Every entity ref a claim names, in its mentions and its links. */
function claimRefs(item: ProposalMemory): string[] {
  return [...item.entities, ...item.links.flatMap((link) => [link.subject, link.object])]
}
function identityChanged(
  item: ProposalMemory,
  value: Proposal,
  decision: BrainReviewDecision,
): boolean {
  return claimRefs(item).some((ref) => {
    const override = decision.identities[ref]
    const old = value.entities.find((entity) => entity.ref === ref)
    return override !== undefined && override !== (old?.decision === 'reuse' ? old.entityId : 'new')
  })
}
