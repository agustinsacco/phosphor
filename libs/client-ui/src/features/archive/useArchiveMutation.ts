import { useState } from 'react'
import type { LaneArchiveEntry } from '@shared/lane-archive'
import { useSessionsStore } from '@/stores/sessions'
import { useDraftsStore } from '@/stores/drafts'
import { archivesChanged } from '@/stores/archiveChanges'
import { purgeArchive, purgeArchives } from './purgeArchives'

export async function restoreArchive(machine: string, id: string): Promise<void> {
  if (machine !== 'local') return window.phosphor.invoke('hosts:restoreArchive', machine, id)
  const restored = await window.phosphor.invoke('sessions:restoreArchive', id)
  if (!restored.path) {
    const sessionId = await useSessionsStore.getState().createSession(restored.cwd)
    const completed = await window.phosphor.invoke('sessions:restoreArchive', id, sessionId)
    if (completed.draftKey && completed.restoredDraftKey)
      useDraftsStore.getState().rekey(completed.draftKey, completed.restoredDraftKey)
  }
  await useSessionsStore.getState().refreshDisk(restored.cwd)
}

/**
 * One machine's archive actions.
 *
 * `running` covers a single row's operation and a bulk cleanup alike, because
 * both hold the whole list: an archive is a manifest the other operations read,
 * and two at once can act on an entry the other already removed.
 */
export function useArchiveMutation(machine: string, writable: boolean | undefined) {
  const [busy, setBusy] = useState<{ id: string; purge: boolean } | null>(null)
  const [bulk, setBulk] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [purging, setPurging] = useState<LaneArchiveEntry | null>(null)
  const running = busy !== null || bulk > 0
  /** Which operation this row is running, so only that button changes its label. */
  const busyFor = (id: string): 'restore' | 'purge' | null =>
    busy?.id === id ? (busy.purge ? 'purge' : 'restore') : null
  const fail = (cause: unknown, fallback: string): void =>
    setError(cause instanceof Error ? cause.message : fallback)

  const mutate = async (entry: LaneArchiveEntry, purge: boolean, removeWorktree = false) => {
    if (!writable || running) return
    setBusy({ id: entry.id, purge })
    setError(null)
    try {
      if (purge) await purgeArchive(machine, entry.id, removeWorktree)
      else await restoreArchive(machine, entry.id)
      setPurging(null)
    } catch (cause) {
      fail(cause, 'Operation failed. Nothing else will be cleaned up.')
    } finally {
      setBusy(null)
      archivesChanged(machine)
    }
  }

  /** Clean up the selection. Returns how many went, so the caller can drop them from it. */
  const purgeMany = async (entries: readonly LaneArchiveEntry[], removeWorktree: boolean) => {
    if (!writable || running || !entries.length) return
    setBulk(entries.length)
    setError(null)
    try {
      const { cleaned, failures } = await purgeArchives(machine, entries, removeWorktree)
      if (failures.length)
        setError(
          `${cleaned} cleaned up, ${failures.length} kept. ${failures[0]}${
            failures.length > 1 ? ` (and ${failures.length - 1} more)` : ''
          }`,
        )
      return cleaned
    } catch (cause) {
      fail(cause, 'Cleanup failed. The archives it did not report are still listed.')
      return 0
    } finally {
      setBulk(0)
    }
  }

  return {
    running,
    busyFor,
    bulkCount: bulk,
    error,
    purging,
    setError,
    setPurging,
    mutate,
    purgeMany,
  }
}
