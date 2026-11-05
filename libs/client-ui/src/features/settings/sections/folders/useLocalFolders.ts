import { useEffect, useMemo, useState } from 'react'
import { ipcErrorText } from '@shared/errors'
import { localMachineLabel } from '@/lib/localMachine'
import { useWorkspacesStore } from '@/stores/workspaces'
import { confirmFolderRemoval } from './confirmFolderRemoval'
import type { FolderSource } from './source'
import { useOnLocalRefresh } from '../../machine/ScopeRefresh'

const CAPS = { add: true, remove: 'forget', trustReview: false, sandboxes: true } as const

/** This Mac's folders: its recent workspaces, without the sandboxes listed apart. */
export function useLocalFolders(): FolderSource {
  const recents = useWorkspacesStore((s) => s.recents)
  const sandboxes = useWorkspacesStore((s) => s.sandboxes)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Item counts change whenever a session writes, so the list is re-read on
  // open rather than trusted from launch.
  const read = (): void =>
    void useWorkspacesStore
      .getState()
      .refreshSandboxes()
      .catch((reason: unknown) => setError(ipcErrorText(reason)))
  useEffect(read, [])
  useOnLocalRefresh(read)
  // A sandbox IS a recent workspace, but listing it twice would mean two
  // Remove buttons for one folder; it belongs to its own list. Both sides are
  // resolved paths (main answers recents that way and reads sandboxes off
  // disk), so this exact-string match holds even under a symlinked data dir.
  const folders = useMemo(() => {
    const sandboxPaths = new Set(sandboxes.map((sandbox) => sandbox.path))
    return recents
      .filter((workspace) => !sandboxPaths.has(workspace.path))
      .map(({ path, name }) => ({ id: path, name, path }))
  }, [recents, sandboxes])
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (reason) {
      setError(ipcErrorText(reason))
    } finally {
      setBusy(false)
    }
  }
  return {
    intro: 'Folders you start lanes in. Removing one forgets it; nothing on disk changes.',
    notice: error ? { tone: 'danger', title: 'That didn’t work', body: error } : null,
    caps: CAPS,
    folders,
    busy,
    // The sidebar's picker: the folder opens on the home screen and joins the list.
    add: () => void run(() => useWorkspacesStore.getState().pickAndOpen()),
    // The sidebar's "Remove from sidebar": it closes the folder's idle chats,
    // refuses (and says why) while one is mid-turn, and steps the home screen off it.
    remove: async (folder) => {
      if (!(await confirmFolderRemoval('forget', folder, localMachineLabel()))) return
      await run(() => useWorkspacesStore.getState().removeWorkspace([folder.path]))
    },
    reviewTrust: () => undefined,
  }
}
