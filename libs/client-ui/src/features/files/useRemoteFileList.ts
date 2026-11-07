import { useEffect, useState, type RefObject } from 'react'
import type { HostConnectionView } from '@shared/ipc'
import { fileListErrorText } from '@shared/host-protocol-files'
import { useSessionsStore } from '@/stores/sessions'

/**
 * A Host lane's files and git status, read again on its summary, connection or
 * runtime changing, or `refresh`. A failed status read still lists the files. A
 * failed list goes to `setError`; a good one clears it unless edits are unsaved.
 */
export function useRemoteFileList(
  {
    workspacePath,
    sessionId,
    host,
  }: { workspacePath: string; sessionId: string; host?: HostConnectionView },
  { available, refresh }: { available: boolean; refresh: number },
  dirtyRef: RefObject<boolean>,
  setError: (error: string | null) => void,
) {
  const [loading, setLoading] = useState(false)
  const [files, setFiles] = useState<string[]>([])
  const [gitUnavailable, setGitUnavailable] = useState(false)
  const [status, setStatus] = useState<Record<string, string>>({})
  const laneId = useSessionsStore((s) => s.live[sessionId]?.laneId)
  // Host objects are replaced by unrelated lanes and control/stream updates.
  const summary = JSON.stringify(host?.lanes.find((lane) => lane.laneId === laneId))
  const connectionState = host?.state
  const runtimeEpoch = host?.cursor?.epoch
  useEffect(() => {
    let alive = true
    setLoading(available)
    setFiles([])
    setStatus({})
    if (available)
      void Promise.all([
        window.phosphor.invoke('fs:listFiles', workspacePath),
        window.phosphor.invoke('git:statusMap', workspacePath).catch(() => null),
      ]).then(
        ([files, status]) => {
          if (alive) {
            setLoading(false)
            setFiles(files)
            setGitUnavailable(status === null)
            setStatus(status ?? {})
            if (!dirtyRef.current) setError(null)
          }
        },
        (error: unknown) => {
          if (!alive) return
          setLoading(false)
          setError(fileListErrorText(error, 'Could not read files.'))
        },
      )
    return () => {
      alive = false
    }
  }, [
    workspacePath,
    available,
    summary,
    connectionState,
    runtimeEpoch,
    refresh,
    dirtyRef,
    setError,
  ])
  return { loading, files, gitUnavailable, status }
}
