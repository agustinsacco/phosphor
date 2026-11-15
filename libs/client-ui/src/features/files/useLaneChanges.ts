import { useEffect, useState } from 'react'

/**
 * A browser lane's git status against HEAD, for its Changes, read again when `reload` changes.
 * `loading` is whether a read is expected; a failure goes to `setError`.
 */
export function useLaneChanges(
  workspace: string | undefined,
  { canRead, loading: expected }: { canRead: boolean; loading: boolean },
  reload: { epoch?: string; token?: string; refresh: number },
  setError: (error: string) => void,
) {
  const [status, setStatus] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let current = true
    setError('')
    setStatus({})
    setLoading(expected)
    if (canRead && workspace)
      void window.phosphor.invoke('git:statusMap', workspace).then(
        (status) => {
          if (current) {
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
  }, [workspace, canRead, expected, reload.epoch, reload.token, reload.refresh, setError])
  return { status, loading }
}
