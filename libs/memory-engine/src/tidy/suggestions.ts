import { scrubExcerpt } from '../secrets'
import {
  BRAIN_TIDY_KINDS,
  type BrainTidyKind,
  type BrainTidySource,
  type BrainTidySuggestion,
  type BrainTidySummary,
  type BrainTidyFlag,
  type BrainTidyFlagResult,
  type BrainTidySuggestionExtra,
} from '@phosphor/shared/brain-tidy'
import { all, one, run, transaction, type Context } from '../database'
import { bumpRevision } from '../prefs'
import { flagKey } from './flag-keys'
import { recordFlag } from '../use'

/**
 * A possible repeat only Brain Agent sees. It stays out of the waiting count.
 */
export const UNCHECKED = 'unchecked'
/** Every kind the waiting count and Brain Agent's queue show, as an SQL list. */
export const COUNTED = BRAIN_TIDY_KINDS.map((k) => `'${k}'`).join(',')
export interface SuggestionRow {
  id: string
  kind: BrainTidyKind | typeof UNCHECKED
  source: BrainTidySource
  state: BrainTidySuggestion['state']
  subject_type: 'entity' | 'memory'
  first_id: string
  second_id: string | null
  reason: string
  verdict: 'same' | 'different' | 'conflict' | 'replaces' | null
  verdict_reason: string | null
  newer_id: string | null
  model: string | null
  problem: BrainTidyFlag['problem'] | null
  session_id: string | null
  title: string | null
  /** JSON `BrainTidySuggestionExtra`: a read's guess or group, or an unlinked pair's memories. */
  detail: string | null
  created_at: number
  updated_at: number
}
export function pairKey(type: 'entity' | 'memory', first: string, second: string): string {
  return `${type}:${[first, second]
    .sort()
    .map((id) => Buffer.from(id).toString('hex'))
    .join('.')}`
}
export function pairKnown(
  ctx: Context,
  type: 'entity' | 'memory',
  first: string,
  second: string,
): boolean {
  return !!one(ctx, 'SELECT 1 FROM tidy_suggestions WHERE pair_key=?', pairKey(type, first, second))
}
export function offer(
  ctx: Context,
  type: 'entity' | 'memory',
  first: string,
  second: string,
  reason: string,
  kind: SuggestionRow['kind'] = type === 'entity' ? 'same_entity' : 'same_memory',
): boolean {
  if (first === second || pairKnown(ctx, type, first, second)) return false
  const now = ctx.now()
  run(
    ctx,
    `INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,created_at,updated_at) VALUES (?,?,?,'sweep','open',?,?,?,?,?,?)`,
    ctx.id(),
    pairKey(type, first, second),
    kind,
    type,
    first,
    second,
    reason,
    now,
    now,
  )
  return true
}
export function suppressPair(
  ctx: Context,
  type: 'entity' | 'memory',
  first: string,
  second: string,
  suggestionId: string | null,
): void {
  offer(ctx, type, first, second, 'You undid this change; this pair will be kept separate.')
  run(
    ctx,
    "UPDATE tidy_suggestions SET state='dismissed',updated_at=? WHERE pair_key=? OR id=?",
    ctx.now(),
    pairKey(type, first, second),
    suggestionId,
  )
}
export function clearSubject(ctx: Context, type: 'entity' | 'memory', id: string): void {
  for (const column of ['first_id', 'second_id'])
    run(
      ctx,
      `UPDATE tidy_suggestions SET state='cleared',updated_at=? WHERE subject_type=? AND ${column}=? AND state='open'`,
      ctx.now(),
      type,
      id,
    )
}
/** A merge keeps the open group questions that name its source, asking about the survivor. */
export function repointGroups(ctx: Context, source: string, target: string): void {
  for (const row of all<{ id: string; detail: string }>(
    ctx,
    `SELECT id,detail FROM tidy_suggestions WHERE kind='group' AND state='open' AND
    EXISTS(SELECT 1 FROM json_each(detail,'$.memberIds') WHERE value=?)`,
    source,
  )) {
    const detail = JSON.parse(row.detail) as Extract<BrainTidySuggestionExtra, { kind: 'group' }>
    const memberIds = [...new Set(detail.memberIds.map((id) => (id === source ? target : id)))]
    const [first = target, second = first] = memberIds
    run(
      ctx,
      'UPDATE tidy_suggestions SET first_id=?,second_id=?,detail=?,updated_at=? WHERE id=?',
      first,
      second,
      JSON.stringify({ ...detail, memberIds }),
      ctx.now(),
      row.id,
    )
  }
}
export function subjectExists(ctx: Context, row: SuggestionRow): boolean {
  const table = row.subject_type === 'entity' ? 'entities' : 'memories'
  return (
    !!one(ctx, `SELECT 1 FROM ${table} WHERE id=?`, row.first_id) &&
    (!row.second_id || !!one(ctx, `SELECT 1 FROM ${table} WHERE id=?`, row.second_id))
  )
}
/** A detail read clears its own row; writes invalidate removed subjects through their indexes. */
export function closeMissing(ctx: Context, rows: SuggestionRow[]): void {
  for (const row of rows)
    if (!subjectExists(ctx, row)) {
      run(
        ctx,
        "UPDATE tidy_suggestions SET state='cleared',updated_at=? WHERE id=? AND state='open'",
        ctx.now(),
        row.id,
      )
      row.state = 'cleared'
    }
}
/** A suggestion as Brain Agent sees it: scrubbed text, a possible repeat as a repeat. */
export function suggestion(ctx: Context, raw: SuggestionRow): BrainTidySuggestion | null {
  const row: SuggestionRow = {
    ...raw,
    kind: raw.kind === UNCHECKED ? 'same_memory' : raw.kind,
    reason: scrubExcerpt(raw.reason),
    verdict_reason: raw.verdict_reason && scrubExcerpt(raw.verdict_reason),
    title: raw.title && scrubExcerpt(raw.title),
  }
  if (
    row.kind === UNCHECKED ||
    !BRAIN_TIDY_KINDS.includes(row.kind) ||
    !['sweep', 'check', 'flag', 'read'].includes(row.source) ||
    (row.problem !== null && !['wrong', 'outdated', 'duplicate'].includes(row.problem))
  )
    return null
  const table = row.subject_type === 'entity' ? 'entities' : 'memories'
  const column = row.subject_type === 'entity' ? 'label' : 'summary'
  return {
    id: row.id,
    kind: row.kind,
    source: row.source,
    state: row.state,
    subjects: [row.first_id, row.second_id]
      .filter((id): id is string => id !== null)
      .map((id) => ({
        type: row.subject_type,
        id,
        label: scrubExcerpt(
          one<{ label: string }>(ctx, `SELECT ${column} AS label FROM ${table} WHERE id=?`, id)
            ?.label ?? 'Removed',
        ),
      })),
    reason: row.reason,
    verdict: row.verdict
      ? row.verdict === 'replaces'
        ? { kind: 'replaces', newerId: row.newer_id!, reason: row.verdict_reason ?? '' }
        : { kind: row.verdict, reason: row.verdict_reason ?? '' }
      : null,
    model: row.model,
    flag: row.problem
      ? { problem: row.problem, sessionId: row.session_id!, title: row.title ?? '' }
      : null,
    detail: row.detail ? (JSON.parse(row.detail) as BrainTidySuggestionExtra) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
export function summary(ctx: Context): BrainTidySummary {
  return {
    automaticFolds: Number(
      one<{ value: string }>(ctx, "SELECT value FROM meta WHERE key='tidy_automatic_folds'")
        ?.value ?? 0,
    ),
    newestAutomaticFoldAt: one<{ newest: number | null }>(
      ctx,
      "SELECT MAX(created_at) AS newest FROM tidy_operations WHERE automatic=1 AND kind='fold'",
    )!.newest,
  }
}
export function openSuggestion(ctx: Context, id: string): SuggestionRow {
  const row = one<SuggestionRow>(
    ctx,
    "SELECT * FROM tidy_suggestions WHERE id=? AND state='open'",
    id,
  )
  if (!row || !suggestion(ctx, row)) throw new Error('This Tidy suggestion is no longer available.')
  return row
}
export function flag(ctx: Context, input: BrainTidyFlag): BrainTidyFlagResult {
  if (
    !['wrong', 'outdated', 'duplicate'].includes(input.problem) ||
    !input.reason.trim() ||
    input.reason.length > 300 ||
    !input.sessionId ||
    input.sessionId.length > 200 ||
    !input.title ||
    input.title.length > 500
  )
    throw new Error('Invalid Brain flag.')
  return transaction(ctx, () => {
    if (
      !one(
        ctx,
        "SELECT 1 FROM memories WHERE id=? AND state IN ('active','disputed')",
        input.memoryId,
      )
    )
      return { status: 'unavailable', suggestionId: null }
    const existing = one<{ id: string }>(
      ctx,
      "SELECT id FROM tidy_suggestions WHERE subject_type='memory' AND first_id=? AND kind='flagged' AND state='open'",
      input.memoryId,
    )
    if (existing) return { status: 'already_flagged', suggestionId: existing.id }
    const key = flagKey(input.memoryId, input.sessionId)
    const previous = one<{ id: string }>(
      ctx,
      'SELECT id FROM tidy_suggestions WHERE pair_key=?',
      key,
    )
    if (previous) return { status: 'already_flagged', suggestionId: previous.id }
    if (
      all(
        ctx,
        "SELECT id FROM tidy_suggestions WHERE session_id=? AND state='open' AND kind='flagged' LIMIT 5",
        input.sessionId,
      ).length >= 5 ||
      all(ctx, "SELECT id FROM tidy_suggestions WHERE state='open' AND kind='flagged' LIMIT 50")
        .length >= 50
    )
      return { status: 'limit', suggestionId: null }
    const id = ctx.id(),
      now = ctx.now()
    run(
      ctx,
      `INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,reason,problem,session_id,title,created_at,updated_at) VALUES (?,?,'flagged','flag','open','memory',?,?,?,?,?,?,?)`,
      id,
      key,
      input.memoryId,
      input.reason,
      input.problem,
      input.sessionId,
      input.title,
      now,
      now,
    )
    recordFlag(ctx, input.memoryId)
    bumpRevision(ctx)
    return { status: 'filed', suggestionId: id }
  })
}
