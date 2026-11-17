import { useState } from 'react'
import type { LaneArchiveEntry } from '@shared/lane-archive'
import { useSessionsStore } from '@/stores/sessions'
import { useDraftsStore } from '@/stores/drafts'
import { archivesChanged } from '@/stores/archiveChanges'

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

export function useArchiveMutation(machine: string, writable: boolean | undefined) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [purging, setPurging] = useState<LaneArchiveEntry | null>(null)
  const mutate = async (entry: LaneArchiveEntry, purge: boolean, removeWorktree = false) => {
    if (!writable || busy) return
    setBusy(entry.id)
    setError(null)
    try {
      if (purge) {
        if (machine === 'local')
          await window.phosphor.invoke('sessions:purgeArchive', entry.id, removeWorktree)
        else await window.phosphor.invoke('hosts:purgeArchive', machine, entry.id, removeWorktree)
      } else await restoreArchive(machine, entry.id)
      setPurging(null)
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'Operation failed. Nothing else will be cleaned up.',
      )
    } finally {
      setBusy(null)
      archivesChanged(machine)
    }
  }
  return { busy, error, purging, setError, setPurging, mutate }
}
