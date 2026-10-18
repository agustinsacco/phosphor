import { useEffect, useState } from 'react'
import { inspectSubagent, type SubagentInspection } from './subagentInspect'
import type { SubagentTarget } from './subagentView'

/** Only the selected, visible inspection polls. No fleet-wide transcript service. */
export function useSubagentInspection(
  sessionId: string,
  target: SubagentTarget | undefined,
  enabled: boolean,
  active: boolean,
) {
  const key = `${sessionId}:${target?.runId}:${target?.childId}`
  const [read, setRead] = useState<{
    key: string
    inspection: SubagentInspection
    readAt: string
  }>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    setError(undefined)
    setLoading(false)
    if (!target || !enabled) return
    let disposed = false
    let busy = false
    let failures = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    const visible = (): boolean => document.visibilityState === 'visible' && document.hasFocus()
    const load = async (): Promise<void> => {
      if (disposed || busy) return
      busy = true
      setLoading(true)
      controller = new AbortController()
      const signal = controller.signal
      try {
        const inspection = await inspectSubagent(sessionId, target.runId, target.childId, signal)
        if (!disposed && !signal.aborted) {
          setRead({ key, inspection, readAt: new Date().toISOString() })
          setError(undefined)
          failures = 0
        }
      } catch (error) {
        if (!disposed && !signal.aborted) {
          failures++
          setError(error instanceof Error ? error.message : String(error))
        }
      } finally {
        busy = false
        if (!disposed) {
          setLoading(false)
          if (active && visible() && failures < 3)
            timer = setTimeout(() => void load(), failures ? 15_000 * failures : 5_000)
        }
      }
    }
    const visibility = (): void => {
      clearTimeout(timer)
      if (visible() && active && failures < 3) void load()
      else controller?.abort()
    }
    void load()
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('focus', visibility)
    window.addEventListener('blur', visibility)
    return () => {
      disposed = true
      clearTimeout(timer)
      controller?.abort()
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('focus', visibility)
      window.removeEventListener('blur', visibility)
    }
  }, [sessionId, target?.runId, target?.childId, enabled, active, key, revision])
  return {
    ...(read?.key === key ? read : {}),
    error,
    loading,
    refresh: () => setRevision((n) => n + 1),
  }
}
