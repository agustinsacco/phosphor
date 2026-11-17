import type { BrainTidyTouched } from '@phosphor/shared/brain-tidy'
import { all, one, type Context } from '../database'
import { sweep } from './sweep'
import type { Selection } from './rows'

/** A saved approval/change must never be reported as failed because maintenance failed. */
export function afterChange(ctx: Context, touched: BrainTidyTouched): void {
  if (!touched.entityIds.length && !touched.memoryIds.length) return
  try {
    sweep(ctx, touched)
  } catch (error) {
    process.emitWarning(
      `Brain saved the change, but local Tidy failed: ${error instanceof Error ? error.message : String(error)}. Run Tidy again to retry.`,
      { code: 'BRAIN_TIDY_SWEEP' },
    )
  }
}
export function afterOperation(ctx: Context, operation: string | null): void {
  if (!operation) return
  const row = one<{ subject_type: string; first_id: string; second_id: string }>(
    ctx,
    'SELECT subject_type,first_id,second_id FROM tidy_operations WHERE id=?',
    operation,
  )
  if (!row || row.subject_type !== 'entity') return
  afterChange(ctx, {
    entityIds: [row.first_id, row.second_id],
    memoryIds: all<{ memory_id: string }>(
      ctx,
      'SELECT memory_id FROM tidy_operation_memories WHERE operation_id=?',
      operation,
    ).map((r) => r.memory_id),
  })
}
export function afterUndo(ctx: Context, selection: Selection): void {
  afterChange(ctx, {
    entityIds: all<{ id: string }>(
      ctx,
      'SELECT id FROM entities WHERE n IN (SELECT value FROM json_each(?))',
      JSON.stringify(selection.entities),
    ).map((r) => r.id),
    memoryIds: all<{ id: string }>(
      ctx,
      'SELECT id FROM memories WHERE n IN (SELECT value FROM json_each(?))',
      JSON.stringify(selection.memories),
    ).map((r) => r.id),
  })
}
