import { useMemo } from 'react'
import { fileListErrorText } from '@shared/host-protocol-files'
import { hostFeatureRefusal } from '@/stores/hostRefusals'
import { useRemoteLanesStore } from '@/stores/remoteLanes'

/** How a machine's files are read; one object per machine, so a view can depend on it. */
export interface MachineFileReads {
  list: (repositoryId: string) => Promise<string[]>
  read: (repositoryId: string, path: string) => Promise<{ binary: boolean; content: string }>
  listError: (failure: unknown) => string
  readError: string
  /** The read-only editor's model path, never one an open local editor uses. */
  modelPath: (repositoryId: string, path: string) => string
}

/** What Machine files browses, read only: a Host's registered repositories. */
export interface MachineFilesSource {
  /** Why nothing can be browsed now, or null. */
  unavailable: string | null
  /** What the choices are called. */
  noun: { one: string; many: string }
  repositories: { id: string; name: string }[]
  reads: MachineFileReads
}

export function useHostFiles(hostId: string): MachineFilesSource {
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const reads = useMemo<MachineFileReads>(
    () => ({
      list: (id) => window.phosphor.invoke('hosts:repositoryFiles', hostId, id),
      read: async (id, path) => {
        const file = await window.phosphor.invoke('hosts:repositoryFile', hostId, id, path)
        return { binary: file.binary, content: file.binary ? 'Binary file' : file.content }
      },
      listError: (failure) => fileListErrorText(failure, 'Could not read files.'),
      readError: 'Could not read this file.',
      modelPath: (id, path) => `host:${hostId}/repository:${id}/${path}`,
    }),
    [hostId],
  )
  return {
    unavailable: hostFeatureRefusal(host, 'workspaces.read') ?? null,
    noun: { one: 'Repository', many: 'Repositories' },
    repositories: host?.repositories ?? [],
    reads,
  }
}
