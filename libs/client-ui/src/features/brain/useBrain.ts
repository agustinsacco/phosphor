import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrainStatus } from '@shared/brain'

export type BrainAction = (operation: () => Promise<unknown>) => Promise<boolean>

/** A mounted local page owns polling; replies cannot cross a machine change/unmount. */
export function useBrain(): {
  status: BrainStatus | null
  error: string
  busy: boolean
  refresh: () => Promise<void>
  act: BrainAction
} {
  const [status, setStatus] = useState<BrainStatus | null>(null)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const mounted = useRef(false)
  const loading = useRef(false)
  const acting = useRef(false)
  const refresh = useCallback(async (): Promise<void> => {
    if (!mounted.current || loading.current || document.visibilityState === 'hidden') return
    loading.current = true
    try {
      const next = await window.phosphor.invoke('brain:status')
      if (mounted.current) {
        setStatus(next)
        setLoadError('')
      }
    } catch (cause) {
      if (mounted.current) setLoadError(String(cause))
    } finally {
      loading.current = false
    }
  }, [])
  useEffect(() => {
    mounted.current = true
    void refresh()
    const timer = setInterval(() => {
      void refresh()
    }, 3000)
    const visible = (): void => {
      void refresh()
    }
    document.addEventListener('visibilitychange', visible)
    return () => {
      mounted.current = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [refresh])
  const act: BrainAction = async (operation) => {
    if (!mounted.current || acting.current) return false
    acting.current = true
    setBusy(true)
    setError('')
    try {
      await operation()
      await refresh()
      return mounted.current
    } catch (cause) {
      if (mounted.current) setError(String(cause))
      return false
    } finally {
      acting.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const retry = async (): Promise<void> => {
    setError('')
    await refresh()
  }
  return { status, error: error || loadError, busy, refresh: retry, act }
}
