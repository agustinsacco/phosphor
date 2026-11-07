import { useEffect, useState } from 'react'

/**
 * The phone's lane file list, with git status for Changes, read again when
 * `reload` changes. `loading` is whether a read is expected; a failure goes to
 * `setError`.
 */
export function useLaneFileList(
  workspace: string | undefined,
  { canRead, loading: expected, changes }: { canRead: boolean; loading: boolean; changes: boolean },
  reload: { epoch?: string; token?: string; refresh: number },
  setError: (error: string) => void,
) {
  const [files, setFiles] = useState<string[]>([])
  const [status, setStatus] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let current = true
    setError('')
    setFiles([])
    setStatus({})
    setLoading(expected)
    if (canRead && workspace)
      void Promise.all([
        window.phosphor.invoke('fs:listFiles', workspace),
        changes ? window.phosphor.invoke('git:statusMap', workspace) : Promise.resolve({}),
      ]).then(
        ([files, status]) => {
          if (current) {
            setFiles(files)
            setStatus(status)
            setLoading(false)
          }
        },
        () => {
          if (current) {
            setError('Could not read files.')
            setLoading(false)
          }
        },
      )
    return () => {
      current = false
    }
  }, [workspace, canRead, expected, changes, reload.epoch, reload.token, reload.refresh, setError])
  return { files, status, loading }
}
