import type { LaneArchiveEntry } from '@shared/lane-archive'
import { archivesChanged } from '@/stores/archiveChanges'

/** One permanent cleanup. `removeWorktree` is refused by the machine, never guessed here. */
export function purgeArchive(
  machine: string,
  id: string,
  removeWorktree: boolean,
): Promise<unknown> {
  return machine === 'local'
    ? window.phosphor.invoke('sessions:purgeArchive', id, removeWorktree)
    : window.phosphor.invoke('hosts:purgeArchive', machine, id, removeWorktree)
}

export interface BulkPurgeResult {
  cleaned: number
  /** One line per entry the machine refused, naming the lane. */
  failures: string[]
}

/**
 * Clean up several archives, one at a time, and keep going after a refusal.
 *
 * Sequential because a cleanup is permanent and the machine checks ownership
 * per entry: a worktree another lane still uses is refused on its own, and the
 * rest of the selection is unrelated to that refusal. Stopping at the first
 * failure would make one shared checkout hold up twenty cleanups. The list
 * refreshes once at the end, so whatever survived is still there to retry.
 */
export async function purgeArchives(
  machine: string,
  entries: readonly LaneArchiveEntry[],
  removeWorktree: boolean,
): Promise<BulkPurgeResult> {
  let cleaned = 0
  const failures: string[] = []
  for (const entry of entries) {
    try {
      await purgeArchive(machine, entry.id, removeWorktree && entry.worktree === true)
      cleaned += 1
    } catch (error) {
      failures.push(`${entry.title}: ${error instanceof Error ? error.message : 'Cleanup failed.'}`)
    }
  }
  archivesChanged(machine)
  return { cleaned, failures }
}
