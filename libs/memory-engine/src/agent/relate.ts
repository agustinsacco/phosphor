/**
 * Brain Agent states a link the cited memories show, or changes a link's wording and dates or a
 * memory's importance. Each is journaled with Undo.
 */
import {
  BRAIN_RELATE_PER_RUN,
  BRAIN_RELATE_LIMIT_REFUSAL,
  type BrainAgentEdit,
} from '@phosphor/shared/brain-agent'
import { brainLinkWords, type BrainPredicate } from '@phosphor/shared/brain-links'
import { all, one, run, transaction, type Context } from '../database'
import { recountEntities } from '../entities'
import { bumpKnowledgeRevision } from '../prefs'
import { journal } from '../tidy/journal'
import type { RowTable } from '../tidy/rows'
import { checkPeriod, insertLink, linkDate, linkLabel, parseLinkInput } from './link-input'
import type { JournalNote } from './notes'
import type { RelateInput } from './types'

const RELATIONS = new Set<RowTable>(['relations'])
const MEMORIES = new Set<RowTable>(['memories'])
/** Outside a run, Brain Agent states at most this many links in any rolling hour. */
const RELATE_PER_HOUR = 20

function label(ctx: Context, n: number): string {
  return one<{ label: string }>(ctx, 'SELECT label FROM entities WHERE n=?', n)!.label
}
function checkCap(ctx: Context, runId: string | null): void {
  const made = runId
    ? one<{ n: number }>(
        ctx,
        `SELECT COUNT(*) AS n FROM agent_notes a JOIN tidy_operations o ON o.id=a.operation_id
        WHERE a.role='made' AND a.run_id=? AND o.kind='relate'`,
        runId,
      )!.n
    : one<{ n: number }>(
        ctx,
        `SELECT COUNT(*) AS n FROM agent_notes a JOIN tidy_operations o ON o.id=a.operation_id
        WHERE a.role='made' AND a.run_id IS NULL AND o.kind='relate' AND o.created_at>=?`,
        ctx.now() - 3_600_000,
      )!.n
  if (made >= (runId ? BRAIN_RELATE_PER_RUN : RELATE_PER_HOUR))
    throw new Error(BRAIN_RELATE_LIMIT_REFUSAL)
}
/** The newest cited memory naming both ends; every cited memory must be current. */
function hostOf(ctx: Context, memoryIds: string[], subject: number, object: number) {
  if (!memoryIds.length || memoryIds.length > 8 || new Set(memoryIds).size !== memoryIds.length)
    throw new Error('Cite 1 to 8 different memories.')
  const cited = all<{ n: number }>(
    ctx,
    `SELECT n FROM memories WHERE id IN (SELECT value FROM json_each(?)) AND state IN ('active','disputed')
    ORDER BY observed_at DESC,n DESC`,
    JSON.stringify(memoryIds),
  )
  if (cited.length !== memoryIds.length) throw new Error('Every cited memory must be current.')
  const host = cited.find(
    (m) =>
      one(ctx, 'SELECT 1 FROM mentions WHERE memory=? AND entity=?', m.n, subject) &&
      one(ctx, 'SELECT 1 FROM mentions WHERE memory=? AND entity=?', m.n, object),
  )
  if (!host) throw new Error('One cited memory must name both of them.')
  return { host: host.n, cited: cited.map((m) => m.n) }
}
function checkSuggestion(ctx: Context, id: string, subject: number, object: number): void {
  const row = one<{ first_id: string; second_id: string }>(
    ctx,
    "SELECT first_id,second_id FROM tidy_suggestions WHERE id=? AND state='open' AND kind='unlinked'",
    id,
  )
  const ends = new Set(
    all<{ id: string }>(ctx, 'SELECT id FROM entities WHERE n IN (?,?)', subject, object).map(
      (r) => r.id,
    ),
  )
  if (!row || !ends.has(row.first_id) || !ends.has(row.second_id))
    throw new Error('This suggestion is no longer available.')
}
export function relate(ctx: Context, input: RelateInput, note: JournalNote): string {
  return transaction(ctx, () => {
    const link = parseLinkInput(ctx, input)
    const { host, cited } = hostOf(ctx, input.memoryIds, link.subject, link.object)
    const now = ctx.now()
    if (
      one(
        ctx,
        `SELECT 1 FROM relations r WHERE r.subject=? AND r.predicate=? AND r.object=?
        AND (r.memory=? OR (r.live=1 AND (r.valid_to IS NULL OR r.valid_to>?)))`,
        link.subject,
        link.predicate,
        link.object,
        host,
        now,
      )
    )
      throw new Error('These are already linked this way.')
    if (input.suggestionId) checkSuggestion(ctx, input.suggestionId, link.subject, link.object)
    checkCap(ctx, note.runId)
    const support = cited.map((memory) =>
      one<{ evidence: number; quote: string }>(
        ctx,
        'SELECT evidence,quote FROM citations WHERE memory=? ORDER BY evidence,quote LIMIT 1',
        memory,
      )!,
    )
    const operation = journal(
      ctx,
      {
        kind: 'relate',
        note,
        suggestionId: input.suggestionId,
        subjects: { type: 'memory', first: memoryId(ctx, host), second: memoryId(ctx, host) },
        selection: { entities: [], memories: [host] },
        summary: `Linked ${label(ctx, link.subject)} and ${label(ctx, link.object)}: ${link.label}`,
      },
      () => insertLink(ctx, host, link, 'agent', support),
    )
    if (input.suggestionId)
      run(
        ctx,
        "UPDATE tidy_suggestions SET state='applied',updated_at=? WHERE id=?",
        now,
        input.suggestionId,
      )
    recountEntities(ctx, new Set([link.subject, link.object]))
    bumpKnowledgeRevision(ctx)
    return operation
  })
}
function memoryId(ctx: Context, n: number): string {
  return one<{ id: string }>(ctx, 'SELECT id FROM memories WHERE n=?', n)!.id
}

type RelationEdit = Extract<BrainAgentEdit, { kind: 'relation' }>
/** A link's wording and dates; a missing field keeps its value, a null date clears it. */
export function editRelation(ctx: Context, edit: RelationEdit, note: JournalNote): string {
  return transaction(ctx, () => {
    const row = one<{
      n: number
      memory: number
      subject: number
      object: number
      predicate: BrainPredicate
      label: string
      valid_from: number | null
      valid_to: number | null
    }>(
      ctx,
      `SELECT r.n,r.memory,r.subject,r.object,r.predicate,r.label,r.valid_from,r.valid_to FROM relations r
      JOIN memories m ON m.n=r.memory WHERE r.n=? AND m.state IN ('active','disputed')`,
      Number(edit.relationId),
    )
    if (!row) throw new Error('This link is no longer current.')
    const next = {
      label: edit.label === undefined ? row.label : linkLabel(edit.label),
      validFrom: edit.since === undefined ? row.valid_from : (linkDate(edit.since) ?? null),
      validTo: edit.until === undefined ? row.valid_to : (linkDate(edit.until) ?? null),
    }
    checkPeriod(next.validFrom, next.validTo)
    if (
      next.label === row.label &&
      next.validFrom === row.valid_from &&
      next.validTo === row.valid_to
    )
      throw new Error('This link already says that.')
    const host = memoryId(ctx, row.memory)
    const operation = journal(
      ctx,
      {
        kind: 'relation',
        note,
        subjects: { type: 'memory', first: host, second: host },
        selection: { entities: [], memories: [row.memory] },
        only: RELATIONS,
        summary: `Changed the link ${label(ctx, row.subject)} ${brainLinkWords({ label: next.label, predicate: row.predicate })} ${label(ctx, row.object)}`,
      },
      () =>
        run(
          ctx,
          'UPDATE relations SET label=?,valid_from=?,valid_to=? WHERE n=?',
          next.label,
          next.validFrom,
          next.validTo,
          row.n,
        ),
    )
    recountEntities(ctx, new Set([row.subject, row.object]))
    bumpKnowledgeRevision(ctx)
    return operation
  })
}
const IMPORTANCE = { low: 0, normal: 1, high: 2 } as const
type ImportanceEdit = Extract<BrainAgentEdit, { kind: 'importance' }>
export function setImportance(ctx: Context, edit: ImportanceEdit, note: JournalNote): string {
  if (!Object.hasOwn(IMPORTANCE, edit.importance))
    throw new Error('Importance is low, normal or high.')
  return transaction(ctx, () => {
    const row = one<{ n: number; importance: number }>(
      ctx,
      "SELECT n,importance FROM memories WHERE id=? AND state IN ('active','disputed')",
      edit.memoryId,
    )
    if (!row) throw new Error('This memory is no longer current.')
    const value = IMPORTANCE[edit.importance]
    if (row.importance === value) throw new Error(`This memory is already ${edit.importance}.`)
    const operation = journal(
      ctx,
      {
        kind: 'importance',
        note,
        subjects: { type: 'memory', first: edit.memoryId, second: edit.memoryId },
        selection: { entities: [], memories: [row.n] },
        only: MEMORIES,
        summary: `Marked a memory ${edit.importance === 'normal' ? 'normal' : `${edit.importance} importance`}`,
      },
      () => run(ctx, 'UPDATE memories SET importance=? WHERE n=?', value, row.n),
    )
    bumpKnowledgeRevision(ctx)
    return operation
  })
}
