import { BRAIN_REASON_MAX } from '@phosphor/shared/brain-agent'
import { run, type Context } from '../database'
import { scrubExcerpt } from '../secrets'
import type { BrainChangeNote } from './types'

export type JournalNote = BrainChangeNote & { jobId?: string }
export function cleanNote(note: JournalNote): JournalNote {
  const reason = note.reason.trim()
  if (!reason || reason.length > BRAIN_REASON_MAX || /[\r\n\u2028\u2029]/u.test(reason))
    throw new Error(`A reason needs one line of 1 to ${BRAIN_REASON_MAX} characters.`)
  const clean = scrubExcerpt(reason)
  if (!clean || clean.length > BRAIN_REASON_MAX)
    throw new Error(`A reason needs one line of 1 to ${BRAIN_REASON_MAX} characters.`)
  return { ...note, reason: clean }
}
export function saveNote(
  ctx: Context,
  id: string,
  role: 'made' | 'undid',
  note: JournalNote,
): void {
  const clean = cleanNote(note)
  run(
    ctx,
    'INSERT INTO agent_notes VALUES (?,?,?,?,?,?)',
    id,
    role,
    clean.runId,
    clean.reason,
    clean.jobId ?? null,
    ctx.now(),
  )
}
/** Latest run stays whole for Undo run; recent erasures must survive the rolling-hour cap. */
export function pruneOperations(ctx: Context): void {
  run(
    ctx,
    `DELETE FROM tidy_operations WHERE id NOT IN
    (SELECT id FROM tidy_operations ORDER BY created_at DESC,rowid DESC LIMIT 200)
    AND id NOT IN (SELECT operation_id FROM agent_notes WHERE role='made' AND run_id=
      (SELECT id FROM agent_runs ORDER BY queued_at DESC,rowid DESC LIMIT 1))
    AND NOT (kind='erase' AND created_at>=?)`,
    ctx.now() - 3_600_000,
  )
}
/**
 * Row images can be removed by Forget; keep is reversible without images; erase never is, nor a
 * read rejected before v8, which had no saved memories to bring back.
 */
export const undoableSql = `(o.undone_at IS NULL AND o.kind NOT IN ('erase','reject') AND
  (o.kind='keep' OR EXISTS(SELECT 1 FROM tidy_operation_rows r WHERE r.operation_id=o.id)))`
