import { useCallback, useEffect, useEffectEvent, useState } from 'react'
import { ipcErrorText } from '@shared/errors'
import { SettingsNotice } from '@/components/form'

/** Whether a section's data has loaded: a failed load always offers a retry. */
export type SectionStatus = 'loading' | 'ready' | { error: string; retry: () => void }

/**
 * Loads a section's data on mount, and again on `retry`. A failed load leaves
 * `data` as it was and says why; it never stays stuck on "loading".
 */
export function useSectionLoad<T>(load: () => Promise<T>): {
  data: T | null
  status: SectionStatus
} {
  const [attempt, setAttempt] = useState(0)
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  const read = useEffectEvent(load)
  useEffect(() => {
    let alive = true
    setError(null)
    read().then(
      (value) => alive && setData(value),
      (reason: unknown) => alive && setError(ipcErrorText(reason)),
    )
    return () => {
      alive = false
    }
  }, [attempt])
  return {
    data,
    status: error !== null ? { error, retry } : data === null ? 'loading' : 'ready',
  }
}

/** A failed load as a danger notice with Retry; nothing otherwise. */
export function SectionStatusNotice({
  status,
  title,
}: {
  status: SectionStatus
  title: string
}): React.JSX.Element | null {
  if (typeof status === 'string') return null
  return (
    <SettingsNotice
      tone="danger"
      title={title}
      body={status.error}
      action={{ label: 'Retry', onClick: status.retry }}
    />
  )
}
