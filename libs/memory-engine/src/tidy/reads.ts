import { undoableSql } from '../agent/notes'
import {
  type BrainTidySuggestionDetail,
  type BrainTidyChanges,
  type BrainTidyOperation,
} from '@phosphor/shared/brain-tidy'
import { all, one, type Context } from '../database'
import { entity } from '../explorer'
import { memory } from '../knowledge'
import { revision } from '../prefs'
import { closeMissing, suggestion, type SuggestionRow } from './suggestions'
import { allowedActions } from './action-guards'

function limitOf(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new Error('Invalid Tidy page limit.')
}
/** One suggestion with its subjects and the actions Brain Agent may take. */
export function detail(ctx: Context, id: string): BrainTidySuggestionDetail | null {
  const row = one<SuggestionRow>(ctx, 'SELECT * FROM tidy_suggestions WHERE id=?', id)
  if (!row) return null
  if (row.state === 'open') closeMissing(ctx, [row])
  const item = suggestion(ctx, row)
  if (!item) return null
  return {
    suggestion: item,
    ...allowedActions(ctx, row),
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
