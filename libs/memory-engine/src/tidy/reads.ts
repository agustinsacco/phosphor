import { undoableSql } from '../agent/notes'
import {
  BRAIN_TIDY_KINDS,
  type BrainTidyKind,
  type BrainTidySuggestionDetail,
  type BrainTidyChanges,
  type BrainTidyOperation,
} from '@phosphor/shared/brain-tidy'
import { all, one, type Context } from '../database'
import { entity } from '../explorer'
import { memory } from '../knowledge'
import { revision } from '../prefs'
import { closeMissing, COUNTED, suggestion, type SuggestionRow } from './suggestions'
import { allowedActions } from './action-guards'
import { publicCoverage } from './sweep'

function limitOf(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new Error('Invalid Tidy page limit.')
}
export function page(
  ctx: Context,
  kind: BrainTidyKind | null,
  cursor: string | null,
  limit: number,
) {
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
  const rows = all<SuggestionRow>(
    ctx,
    `SELECT * FROM tidy_suggestions WHERE state='open' AND ${kind ? 'kind=?' : `kind IN (${COUNTED})`} AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?`,
    ...(kind ? [kind] : []),
    time,
    time,
    id,
    limit + 1,
  )
  closeMissing(ctx, rows)
  const counts = Object.fromEntries(BRAIN_TIDY_KINDS.map((k) => [k, 0])) as Record<
    BrainTidyKind,
    number
  >
  for (const row of all<{ kind: BrainTidyKind; count: number }>(
    ctx,
    "SELECT kind,COUNT(*) AS count FROM tidy_suggestions WHERE state='open' GROUP BY kind",
  ))
    if (BRAIN_TIDY_KINDS.includes(row.kind)) counts[row.kind] = row.count
  const last = rows.slice(0, limit).at(-1)
  return {
    items: rows
      .slice(0, limit)
      .flatMap((r) => (r.state === 'open' ? (suggestion(ctx, r) ?? []) : [])),
    next:
      rows.length > limit && last
        ? Buffer.from(JSON.stringify([last.created_at, last.id])).toString('base64url')
        : null,
    counts,
    revision: revision(ctx),
    coverage: publicCoverage(ctx),
  }
}
export function detail(
  ctx: Context,
  id: string,
  curator = false,
): BrainTidySuggestionDetail | null {
  const row = one<SuggestionRow>(ctx, 'SELECT * FROM tidy_suggestions WHERE id=?', id)
  if (!row) return null
  if (row.state === 'open') closeMissing(ctx, [row])
  const item = suggestion(ctx, row, curator)
  if (!item) return null
  return {
    suggestion: item,
    ...allowedActions(ctx, row, curator),
    subjects: item.subjects.flatMap((s): BrainTidySuggestionDetail['subjects'] => {
      const table = s.type === 'entity' ? 'entities' : 'memories'
      if (!one(ctx, `SELECT 1 FROM ${table} WHERE id=?`, s.id)) return []
      return s.type === 'entity'
        ? [{ type: 'entity', value: entity(ctx, s.id) }]
        : [{ type: 'memory', value: memory(ctx, s.id) }]
    }),
    revision: revision(ctx),
  }
}
export function changes(ctx: Context, limit: number): BrainTidyChanges {
  limitOf(limit)
  const rows = all<BrainTidyOperation>(
    ctx,
    `SELECT o.id,o.kind,o.summary,o.created_at AS createdAt,o.undone_at AS undoneAt,o.suggestion_id AS suggestionId,
      CASE WHEN o.kind='read' THEN 'automatic' WHEN a.operation_id IS NOT NULL THEN 'agent'
        WHEN o.automatic=1 THEN 'automatic' ELSE 'you' END AS who,
      a.reason,a.run_id AS runId,CASE WHEN o.kind='read' THEN o.first_id ELSE a.job_id END AS jobId,
      ${undoableSql} AS undoable
      FROM tidy_operations o LEFT JOIN agent_notes a ON a.operation_id=o.id AND a.role='made'
      ORDER BY o.created_at DESC,o.id DESC LIMIT ?`,
    limit,
  )
  return { items: rows.map((r) => ({ ...r, undoable: !!r.undoable })), revision: revision(ctx) }
}
