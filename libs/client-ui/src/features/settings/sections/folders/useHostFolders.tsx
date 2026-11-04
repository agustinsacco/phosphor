import { useState } from 'react'
import { fixedRefusal } from '@shared/host-protocol-repositories'
import { HostFolderBrowser } from '@/features/machines/HostFolderBrowser'
import { useHostSection } from '../../machine/HostSection'
import { confirmFolderRemoval } from './confirmFolderRemoval'
import type { FolderSource } from './source'

/**
 * A Host's registered folders: the only folders its lanes may run in. They need
 * only the link; reviewing a folder's project trust asks for configuration
 * access first, since it runs a reviewed task on the Host.
 */
export function useHostFolders(): FolderSource {
  const { machine, connection, programs, allowed, access, terminalLink } = useHostSection()
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const writable = connection?.capabilities.includes('workspaces.write') === true
  return {
    intro:
      'Folders registered on this Host, the only ones its lanes run in. These are Host paths, never this computer’s files, and registration is not a filesystem sandbox.',
    notice: error
      ? { tone: 'danger', title: 'That didn’t work', body: error }
      : writable
        ? null
        : {
            tone: 'info',
            title: 'Read only',
            body: 'This device’s access to the Host does not include changing its folders.',
          },
    caps: {
      add: writable,
      remove: writable ? 'unregister' : null,
      trustReview: terminalLink,
      sandboxes: false,
    },
    folders: (connection?.repositories ?? []).map(({ id, name, path }) => ({ id, name, path })),
    busy: busy || programs.busy,
    add: () => setAdding(true),
    addDialog: adding && (
      <HostFolderBrowser
        hostId={machine.id}
        onClose={() => setAdding(false)}
        onAdded={() => setAdding(false)}
      />
    ),
    remove: async (folder) => {
      if (!(await confirmFolderRemoval('unregister', folder, machine.label))) return
      setBusy(true)
      setError(null)
      try {
        await window.phosphor.invoke('hosts:removeRepository', machine.id, folder.id)
      } catch (reason) {
        setError(
          fixedRefusal(reason) ??
            'Folder removal not confirmed. Refresh the Host before trying again.',
        )
      } finally {
        setBusy(false)
      }
    },
    reviewTrust: (folder) =>
      allowed ? programs.task({ task: 'folder.trust', repositoryId: folder.id }) : void access(),
  }
}
