import type { BrainAgentRun } from '@phosphor/shared/brain-agent'
import { all, one, run, transaction, type Context } from '../database'
import { revision } from '../prefs'
import { scrubExcerpt } from '../secrets'
import { undo } from '../tidy/journal'
import { afterUndo } from '../tidy/hooks'
import { pruneOperations, undoableSql } from './notes'
import type { BrainRunPatch } from './types'

function readRun(ctx: Context, id: string): BrainAgentRun {
  const row = one<BrainAgentRun>(
    ctx,
    `SELECT id,state,total,queued_at AS queuedAt,started_at AS startedAt,
    finished_at AS finishedAt,error,session_path AS sessionPath,rules_changed AS rulesChanged,
    (SELECT COUNT(*) FROM agent_notes a WHERE a.run_id=r.id AND a.role='made') AS decided,
    (SELECT COUNT(*) FROM agent_notes a JOIN tidy_operations o ON o.id=a.operation_id WHERE a.run_id=r.id AND a.role='made' AND o.kind='erase') AS erased,
    (SELECT COUNT(*) FROM agent_notes a JOIN tidy_operations o ON o.id=a.operation_id WHERE a.run_id=r.id AND a.role='made' AND ${undoableSql}) AS undoable
    FROM agent_runs r WHERE id=?`,
    id,
  )
  if (!row) throw new Error('Brain Agent run not found.')
  return { ...row, rulesChanged: !!row.rulesChanged }
}
/** Counters include made operations even after undo, never undid notes; undoable is current. */
export function latestRun(ctx: Context): BrainAgentRun | null {
  const row = one<{ id: string }>(
    ctx,
    'SELECT id FROM agent_runs ORDER BY queued_at DESC,rowid DESC LIMIT 1',
  )
  return row ? readRun(ctx, row.id) : null
}
export function createRun(ctx: Context): BrainAgentRun {
  return transaction(ctx, () => {
    const id = ctx.id()
    run(ctx, "INSERT INTO agent_runs(id,state,queued_at) VALUES (?,'queued',?)", id, ctx.now())
    run(
      ctx,
      'DELETE FROM agent_runs WHERE id NOT IN (SELECT id FROM agent_runs ORDER BY queued_at DESC,rowid DESC LIMIT 20)',
    )
    pruneOperations(ctx)
    return readRun(ctx, id)
  })
}
export function updateRun(ctx: Context, id: string, patch: BrainRunPatch): BrainAgentRun {
  const current = readRun(ctx, id),
    value = { ...current, ...patch }
  if (
    !['queued', 'running', 'done', 'stopped', 'failed'].includes(value.state) ||
    !Number.isSafeInteger(value.total) ||
    value.total < 0
  )
    throw new Error('Invalid Brain Agent run.')
  for (const time of [value.startedAt, value.finishedAt])
    if (time !== null && (!Number.isSafeInteger(time) || time < 0))
      throw new Error('Invalid Brain Agent run time.')
  run(
    ctx,
    'UPDATE agent_runs SET state=?,total=?,started_at=?,finished_at=?,error=?,session_path=?,rules_changed=? WHERE id=?',
    value.state,
    value.total,
    value.startedAt,
    value.finishedAt,
    value.error === null ? null : scrubExcerpt(value.error).slice(0, 1200),
    value.sessionPath,
    value.rulesChanged ? 1 : 0,
    id,
  )
  return readRun(ctx, id)
}
export function interruptRuns(ctx: Context, message: string): void {
  run(
    ctx,
    "UPDATE agent_runs SET state='failed',finished_at=?,error=? WHERE state IN ('queued','running')",
    ctx.now(),
    scrubExcerpt(message).slice(0, 1200),
  )
}
export function undoRun(ctx: Context, runId: string): { undone: number; kept: number } {
  readRun(ctx, runId)
  const operations = all<{ id: string; undoable: number }>(
    ctx,
    `SELECT o.id,${undoableSql} AS undoable FROM tidy_operations o JOIN agent_notes a ON a.operation_id=o.id AND a.role='made'
    WHERE a.run_id=? AND o.undone_at IS NULL ORDER BY o.created_at DESC,o.rowid DESC`,
    runId,
  )
  let undone = 0,
    kept = 0
  for (const op of operations) {
    if (!op.undoable) {
      kept++
      continue
    }
    try {
      const selection = undo(ctx, op.id, revision(ctx))
      afterUndo(ctx, selection)
      undone++
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !/Later changes touch|no longer available|already undone/u.test(error.message)
      )
        throw error
      kept++
    }
  }
  return { undone, kept }
}
