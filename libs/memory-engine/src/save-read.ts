/**
 * A finished read saves itself: one transaction, one journal operation, one Undo. Held claims
 * follow their rule (temporary saves with an end, personal never saves), unsure identities save
 * as guesses, group questions wait for Brain Agent, and Read again replaces the lane's earlier
 * unshared memories.
 */
import { BRAIN_TEMPORARY_DAYS } from '@phosphor/shared/brain'
import type { BrainTidyTouched } from '@phosphor/shared/brain-tidy'
import { all, one, run, transaction, type Context } from './database'
import { cleanOrphans, recountEntities } from './entities'
import {
  activeMemoryNumber,
  applyMemory,
  insertCitations,
  observedAt,
  type CommitContext,
} from './commit'
import { linkOutcome } from './extractions'
import { job, updateJob } from './jobs'
import { laneMemories } from './history'
import { removeMemory } from './merge'
import { bumpKnowledgeRevision, knowledgeRevision } from './prefs'
import { scrubProposal } from './proposal-text'
import { BRAIN_READ_STALE } from './read-stale'
import { identityResolver, openGroup } from './save-identities'
import { journal } from './tidy/journal'
import type { Selection } from './tidy/rows'
import { validateProposal } from './validation'
import type { Proposal, ProposalMemory, SavedRead } from './types'

const TEMPORARY_MS = BRAIN_TEMPORARY_DAYS * 86_400_000

interface Plan {
  memories: { index: number; item: ProposalMemory }[]
  confirmations: Proposal['confirmations']
  temporary: number
  personal: number
}
/**
 * Personal claims never save. A temporary claim ends 14 days after it was said unless it says
 * when, its links end with it unless they say when, and it never replaces a lasting memory.
 */
function plan(value: Proposal, now: number): Plan {
  const result: Plan = { memories: [], confirmations: [], temporary: 0, personal: 0 }
  value.memories.forEach((item, index) => {
    if (item.hold === 'personal') return void result.personal++
    if (item.hold !== 'temporary') return void result.memories.push({ index, item })
    result.temporary++
    const validTo = item.validTo ?? observedAt(item, value.evidence, now) + TEMPORARY_MS
    const demote = item.action !== 'add' && item.action !== 'enrich'
    result.memories.push({
      index,
      item: {
        ...item,
        validTo,
        links: item.links.map((link) => ({ ...link, validTo: link.validTo ?? validTo })),
        ...(demote ? { action: 'add', target: null } : {}),
      },
    })
  })
  for (const confirmation of value.confirmations) {
    if (confirmation.claim.hold === 'personal') result.personal++
    else result.confirmations.push(confirmation)
  }
  return result
}
/** What the read can change, so undo restores it: targets, repeats, replaced memories. */
function readSelection(ctx: Context, value: Proposal, chosen: Plan, replaced: string[]): Selection {
  const ids = [
    ...chosen.memories.flatMap(({ item }) => (item.target ? [item.target] : [])),
    ...chosen.confirmations.map((c) => c.memoryId),
    ...replaced,
  ]
  const memories = all<{ n: number }>(
    ctx,
    'SELECT n FROM memories WHERE id IN (SELECT value FROM json_each(?))',
    JSON.stringify(ids),
  ).map((r) => r.n)
  for (const row of all<{ source: number; target: number }>(
    ctx,
    'SELECT source,target FROM memory_links WHERE source IN (SELECT value FROM json_each(?)) OR target IN (SELECT value FROM json_each(?))',
    JSON.stringify(memories),
    JSON.stringify(memories),
  ))
    memories.push(row.source, row.target)
  const refs = [
    ...value.entities.flatMap((e) => [...e.candidates, ...(e.entityId ? [e.entityId] : [])]),
    ...[...value.memories, ...value.confirmations.map((c) => c.claim)].flatMap((m) => [
      ...m.entities,
      ...m.links.flatMap((l) => [l.subject, l.object]),
    ]),
    ...value.groups.flatMap((g) => [
      ...g.members,
      ...(g.parent.entityId ? [g.parent.entityId] : []),
    ]),
  ]
  const entities = all<{ n: number }>(
    ctx,
    `SELECT n FROM entities WHERE id IN (SELECT value FROM json_each(?)) OR n IN
    (SELECT entity FROM mentions WHERE memory IN (SELECT value FROM json_each(?)))`,
    JSON.stringify(refs),
    JSON.stringify(memories),
  ).map((r) => r.n)
  return { entities, memories: [...new Set(memories)] }
}
function touchedIds(ctx: Context, entities: Set<number>, memories: Set<number>): BrainTidyTouched {
  const ids = (table: 'entities' | 'memories', numbers: Set<number>) =>
    all<{ id: string }>(
      ctx,
      `SELECT id FROM ${table} WHERE n IN (SELECT value FROM json_each(?))`,
      JSON.stringify([...numbers]),
    ).map((r) => r.id)
  return { entityIds: ids('entities', entities), memoryIds: ids('memories', memories) }
}
const plural = (count: number) => `${count} ${count === 1 ? 'memory' : 'memories'}`

export function saveRead(ctx: Context, raw: Proposal): SavedRead {
  validateProposal(ctx, raw)
  const value = scrubProposal(raw)
  return transaction(ctx, () => {
    const current = job(ctx, value.jobId)!
    if (current.state !== 'running') throw new Error('Only a read in progress can be saved.')
    if (value.computedRevision !== knowledgeRevision(ctx)) throw new Error(BRAIN_READ_STALE)
    const chosen = plan(value, ctx.now())
    const base = {
      memories: chosen.memories.length,
      confirmed: chosen.confirmations.length,
      temporary: chosen.temporary,
      personal: chosen.personal,
      guesses: 0,
      groups: 0,
      replaced: 0,
    }
    if (!chosen.memories.length && !chosen.confirmations.length && !value.groups.length) {
      updateJob(ctx, value.jobId, { state: 'empty', memories: 0, finishedAt: ctx.now() })
      run(ctx, 'DELETE FROM proposals WHERE job_id=?', value.jobId)
      return {
        ...base,
        state: 'empty',
        operationId: null,
        touched: { entityIds: [], memoryIds: [] },
      }
    }
    const replaced = current.replaces
      ? laneMemories(ctx, current.sessionId, value.jobId).replaceable
      : []
    const selection = readSelection(ctx, value, chosen, replaced)
    const counts = { ...base }
    const touched = new Set<number>(),
      touchedMemories = new Set<number>()
    const operationId = journal(
      ctx,
      {
        kind: 'read',
        automatic: true,
        subjects: { type: 'memory', first: value.jobId, second: value.jobId },
        selection,
        summary: `Read ${current.title || 'Untitled lane'}: ${plural(chosen.memories.length)}`,
      },
      () => {
        const entityMax = maxNumber(ctx, 'entities'),
          memoryMax = maxNumber(ctx, 'memories')
        const identities = identityResolver(ctx, value)
        const commit: CommitContext = {
          ctx,
          proposal: value,
          resolve: identities.resolve,
          evidence: new Map(),
          touched,
          touchedMemories,
        }
        counts.groups = applyRead(commit, chosen, value.jobId)
        for (const id of replaced)
          if (one(ctx, 'SELECT 1 FROM memories WHERE id=?', id)) {
            removeMemory(ctx, id)
            counts.replaced++
          }
        cleanOrphans(ctx, touched)
        recountEntities(ctx, touched)
        counts.guesses = identities.guesses()
        selection.entities.push(...newNumbers(ctx, 'entities', entityMax))
        selection.memories.push(...newNumbers(ctx, 'memories', memoryMax))
      },
    )
    updateJob(ctx, value.jobId, {
      state: 'done',
      memories: chosen.memories.length,
      finishedAt: ctx.now(),
    })
    run(ctx, 'DELETE FROM proposals WHERE job_id=?', value.jobId)
    bumpKnowledgeRevision(ctx)
    return {
      ...counts,
      state: 'done',
      operationId,
      touched: touchedIds(ctx, touched, touchedMemories),
    }
  })
}
/** Memories, repeats and group questions. Returns how many group questions opened. */
function applyRead(commit: CommitContext, chosen: Plan, jobId: string): number {
  const { ctx, proposal, resolve } = commit
  for (const { index, item } of chosen.memories) {
    const id = applyMemory(commit, item, proposal.memoryVectors[index])
    linkOutcome(ctx, jobId, index, id)
  }
  for (const confirmation of chosen.confirmations) {
    const target = activeMemoryNumber(ctx, confirmation.memoryId)
    if (target !== undefined) insertCitations(commit, target, confirmation.claim.citations)
  }
  let groups = 0
  for (const group of proposal.groups) {
    const members = group.members.map(resolve)
    const parentId = group.parent.entityId ? resolve(group.parent.entityId) : null
    if (openGroup(ctx, jobId, { ...group.parent, entityId: parentId }, members)) groups++
  }
  return groups
}
function maxNumber(ctx: Context, table: 'entities' | 'memories'): number {
  return one<{ n: number }>(ctx, `SELECT COALESCE(MAX(n),0) AS n FROM ${table}`)!.n
}
function newNumbers(ctx: Context, table: 'entities' | 'memories', after: number): number[] {
  return all<{ n: number }>(ctx, `SELECT n FROM ${table} WHERE n>?`, after).map((r) => r.n)
}
