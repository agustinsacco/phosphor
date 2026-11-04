import { useMemo } from 'react'
import { fileListErrorText } from '@shared/host-protocol-files'
import { REMOTE_NOT_READY, REMOTE_UNAVAILABLE, useRemoteLanesStore } from '@/stores/remoteLanes'
import { useWorkspacesStore } from '@/stores/workspaces'

/** How a machine's files are read; one object per machine, so a view can depend on it. */
export interface MachineFileReads {
  list: (repositoryId: string) => Promise<string[]>
  read: (repositoryId: string, path: string) => Promise<{ binary: boolean; content: string }>
  listError: (failure: unknown) => string
  readError: string
  /** The read-only editor's model path, never one an open local editor uses. */
  modelPath: (repositoryId: string, path: string) => string
}

/** What Machine files browses, read only: This Mac's recent folders or a Host's repositories. */
export interface MachineFilesSource {
  /** Why nothing can be browsed now, or null. */
  unavailable: string | null
  repositories: { id: string; name: string }[]
  reads: MachineFileReads
}

export function useHostFiles(hostId: string): MachineFilesSource {
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const ready = host?.state === 'ready' && host.capabilities.includes('workspaces.read')
  const reads = useMemo<MachineFileReads>(
    () => ({
      list: (id) => window.phosphor.invoke('hosts:repositoryFiles', hostId, id),
      read: async (id, path) => {
        const file = await window.phosphor.invoke('hosts:repositoryFile', hostId, id, path)
        return { binary: file.binary, content: file.binary ? 'Binary file' : file.content }
      },
      listError: (failure) => fileListErrorText(failure, REMOTE_UNAVAILABLE),
      readError: REMOTE_UNAVAILABLE,
      modelPath: (id, path) => `host:${hostId}/repository:${id}/${path}`,
    }),
    [hostId],
  )
  return {
    unavailable: ready ? null : host?.state !== 'ready' ? REMOTE_NOT_READY : REMOTE_UNAVAILABLE,
    repositories: host?.repositories ?? [],
    reads,
  }
}

const LOCAL_READS: MachineFileReads = {
  list: (folder) => window.phosphor.invoke('fs:listFiles', folder),
  read: async (folder, path) => {
    const file = await window.phosphor.invoke('fs:readFile', `${folder}/${path}`)
    if (file.binary) return { binary: true, content: 'Binary file' }
    if (file.tooLarge) return { binary: true, content: 'Too large to preview' }
    return { binary: false, content: file.content }
  },
  listError: () => 'Could not list these files.',
  readError: 'Could not read this file.',
  modelPath: (folder, path) => `local:${folder}/${path}`,
}

/** This Mac's recent folders, the ones its sidebar lists. */
export function useLocalFiles(): MachineFilesSource {
  const recents = useWorkspacesStore((s) => s.recents)
  return {
    unavailable: null,
    repositories: recents.map((workspace) => ({ id: workspace.path, name: workspace.name })),
    reads: LOCAL_READS,
  }
}
