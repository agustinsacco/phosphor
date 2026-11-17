import {
  BRAIN_TIDY_KINDS,
  type BrainTidyKind,
  type BrainTidyPage,
  type BrainTidySuggestionDetail,
  type BrainTidyChanges,
  type BrainTidyOperation,
} from '@phosphor/shared/brain-tidy'
import { all, one, type Context } from '../database'
import { entity } from '../explorer'
import { memory } from '../knowledge'
import { revision } from '../prefs'
import { closeMissing, openSuggestion, suggestion, type SuggestionRow } from './suggestions'
import { coverage } from './sweep'

function limitOf(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new Error('Invalid Tidy page limit.')
}
export function page(
  ctx: Context,
  kind: BrainTidyKind | null,
  cursor: string | null,
  limit: number,
): BrainTidyPage {
  limitOf(limit)
  if (kind !== null && !BRAIN_TIDY_KINDS.includes(kind)) throw new Error('Invalid Tidy kind.')
  let time = Number.MAX_SAFE_INTEGER,
    id = '\uffff'
  if (cursor !== null) {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString())
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      !Number.isSafeInteger(value[0]) ||
      typeof value[1] !== 'string'
    )
      throw new Error('Invalid Tidy cursor.')
    ;[time, id] = value as [number, string]
  }
  closeMissing(ctx)
  const rows = all<SuggestionRow>(
    ctx,
    `SELECT * FROM tidy_suggestions WHERE state='open' AND ${kind ? 'kind=?' : "kind IN ('same_entity','same_memory','conflict','flagged')"} AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?`,
    ...(kind ? [kind] : []),
    time,
    time,
    id,
    limit + 1,
  )
  const counts = { same_entity: 0, same_memory: 0, conflict: 0, flagged: 0 }
  for (const row of all<{ kind: BrainTidyKind; count: number }>(
    ctx,
    "SELECT kind,COUNT(*) AS count FROM tidy_suggestions WHERE state='open' GROUP BY kind",
  ))
    if (BRAIN_TIDY_KINDS.includes(row.kind)) counts[row.kind] = row.count
  const last = rows.slice(0, limit).at(-1)
  return {
    items: rows.slice(0, limit).flatMap((r) => suggestion(ctx, r) ?? []),
    next:
      rows.length > limit && last
        ? Buffer.from(JSON.stringify([last.created_at, last.id])).toString('base64url')
        : null,
    counts,
    revision: revision(ctx),
    coverage: coverage(ctx),
    run: null,
  }
}
export function detail(ctx: Context, id: string): BrainTidySuggestionDetail {
  closeMissing(ctx)
  const row = openSuggestion(ctx, id)
  const item = suggestion(ctx, row)!
  return {
    suggestion: item,
    subjects: item.subjects.map((s) =>
      s.type === 'entity'
        ? { type: 'entity', value: entity(ctx, s.id) }
        : { type: 'memory', value: memory(ctx, s.id) },
    ),
    revision: revision(ctx),
  }
}
export function changes(ctx: Context, limit: number): BrainTidyChanges {
  limitOf(limit)
  const rows = all<Omit<BrainTidyOperation, 'automatic'> & { automatic: number }>(
    ctx,
    `SELECT id,kind,automatic,summary,created_at AS createdAt,undone_at AS undoneAt,suggestion_id AS suggestionId FROM tidy_operations WHERE kind IN ('merge','fold','dispute','replace') ORDER BY created_at DESC,id DESC LIMIT ?`,
    limit,
  )
  return { items: rows.map((r) => ({ ...r, automatic: !!r.automatic })), revision: revision(ctx) }
}
export function subjectExists(ctx: Context, row: SuggestionRow): boolean {
  const table = row.subject_type === 'entity' ? 'entities' : 'memories'
  return (
    !!one(ctx, `SELECT 1 FROM ${table} WHERE id=?`, row.first_id) &&
    (!row.second_id || !!one(ctx, `SELECT 1 FROM ${table} WHERE id=?`, row.second_id))
  )
}
