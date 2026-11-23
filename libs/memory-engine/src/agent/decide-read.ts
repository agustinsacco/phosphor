import type { BrainReviewDecision } from '@phosphor/shared/brain-review'
import { BRAIN_REVIEW_CHANGED } from '@phosphor/shared/brain-review'
import { all, one, transaction, type Context } from '../database'
import { readProposal } from '../proposals'
import { knowledgeRevision, revision, bumpRevision } from '../prefs'
import { job } from '../jobs'
import { laneMemories } from '../history'
import { reviewChange } from '../review'
import { journal } from '../tidy/journal'
import type { Selection } from '../tidy/rows'
import type { BrainTidyTouched } from '@phosphor/shared/brain-tidy'
import type { BrainChangeNote } from './types'

function readSelection(
  ctx: Context,
  jobId: string,
  decision: BrainReviewDecision | null,
): Selection {
  const value = readProposal(ctx, jobId),
    current = job(ctx, jobId)!
  if (!decision) return { entities: [], memories: [], jobs: [jobId] }
  const ids = [
    ...value.memories.flatMap((m) => (m.target ? [m.target] : [])),
    ...value.confirmations.map((c) => c.memoryId),
    ...(current.replaces ? laneMemories(ctx, current.sessionId, jobId).replaceable : []),
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
    ...Object.values(decision.identities).filter((id) => id !== 'new'),
    ...value.memories.flatMap((m) => [
      ...m.entities,
      ...m.links.flatMap((l) => [l.subject, l.object]),
    ]),
    ...value.confirmations.flatMap((c) => [
      ...c.claim.entities,
      ...c.claim.links.flatMap((l) => [l.subject, l.object]),
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
  return { entities, memories: [...new Set(memories)], jobs: [jobId] }
}
export function decideRead(
  ctx: Context,
  jobId: string,
  decision: BrainReviewDecision | null,
  expected: number,
  note: BrainChangeNote,
): { operationId: string; touched: BrainTidyTouched } {
  return transaction(ctx, () => {
    const value = readProposal(ctx, jobId)
    if (decision && (expected !== value.computedRevision || expected !== knowledgeRevision(ctx)))
      throw new Error(BRAIN_REVIEW_CHANGED)
    const selection = readSelection(ctx, jobId, decision)
    const entityMax = one<{ n: number }>(ctx, 'SELECT COALESCE(MAX(n),0) AS n FROM entities')!.n
    const memoryMax = one<{ n: number }>(ctx, 'SELECT COALESCE(MAX(n),0) AS n FROM memories')!.n
    let touched: BrainTidyTouched = { entityIds: [], memoryIds: [] }
    const title = job(ctx, jobId)!.title || 'Untitled lane'
    const beforeRevision = revision(ctx)
    const operationId = journal(
      ctx,
      {
        kind: decision ? 'approve' : 'reject',
        subjects: { type: 'memory', first: jobId, second: jobId },
        selection,
        note: { ...note, jobId },
        summary: decision
          ? `Approved ${title}, ${new Set(decision.memories).size} of ${value.memories.length} memories`
          : `Rejected ${title}`,
      },
      () => {
        touched = reviewChange(ctx, jobId, decision, expected, true, 'agent')
        selection.entities.push(
          ...all<{ n: number }>(ctx, 'SELECT n FROM entities WHERE n>?', entityMax).map((r) => r.n),
        )
        selection.memories.push(
          ...all<{ n: number }>(ctx, 'SELECT n FROM memories WHERE n>?', memoryMax).map((r) => r.n),
        )
      },
    )
    if (revision(ctx) === beforeRevision) bumpRevision(ctx)
    return { operationId, touched }
  })
}
