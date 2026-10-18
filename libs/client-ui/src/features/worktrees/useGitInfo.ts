import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitInfo } from '@shared/models'

/** One refresh path so workspace changes and mutation/focus refreshes cannot race. */
export function useGitInfo(workspacePath: string): {
  info: GitInfo | null
  refresh: (force?: boolean) => void
} {
  const [snapshot, setSnapshot] = useState<{ path: string; info: GitInfo } | null>(null)
  const generation = useRef(0)
  const refresh = useCallback(
    (force = false): void => {
      const request = ++generation.current
      void window.phosphor
        .invoke('git:info', workspacePath, { force })
        .then((info) => {
          if (request === generation.current) setSnapshot({ path: workspacePath, info })
        })
        .catch(() => {
          // Keep the last successful value for this workspace; retry on the next trigger.
        })
    },
    [workspacePath],
  )

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    refresh()
    void window.phosphor.invoke('fs:watchWorkspace', workspacePath).catch(() => {})
    const unsubscribe = window.phosphor.onFsChanged((payload) => {
      if (payload.workspacePath !== workspacePath) return
      clearTimeout(timer)
      timer = setTimeout(() => refresh(), 500)
    })
    // .git is intentionally not watched. Focus must bypass even a fresh TTL.
    const onFocus = (): void => refresh(true)
    window.addEventListener('focus', onFocus)
    return () => {
      generation.current++
      clearTimeout(timer)
      unsubscribe()
      window.removeEventListener('focus', onFocus)
    }
  }, [workspacePath, refresh])

  return { info: snapshot?.path === workspacePath ? snapshot.info : null, refresh }
}
