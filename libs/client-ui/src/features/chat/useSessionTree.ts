import { useCallback, useEffect, useState } from 'react'
import { ipcErrorText } from '@shared/errors'
import type { SessionTree } from '@shared/ipc'
import { readHostTree, type HostEditLane } from './hostLaneEditing'

/** A closed picker, a later reload, or a newly selected lane invalidates the outstanding read. */
export function useSessionTree(path: string, hostLane?: HostEditLane) {
  const [tree, setTree] = useState<SessionTree | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const reload = useCallback(() => setAttempt((n) => n + 1), [])
  useEffect(() => {
    let current = true
    setError(null)
    setTree(null)
    void (
      hostLane ? readHostTree(hostLane) : window.phosphor.invoke('sessions:readTree', path)
    ).then(
      (next) => {
        if (current) setTree(next)
      },
      (reason) => {
        if (current) setError(ipcErrorText(reason))
      },
    )
    return () => {
      current = false
    }
  }, [attempt, path, hostLane])
  return { tree, error, reload }
}
