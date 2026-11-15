import { useEffect, useState } from 'react'
import { ipcErrorText } from '@shared/errors'
import { brainToast, useBrain } from './useBrain'

/** Ignore replies for a previous selection; every load has an explicit retry. */
export function useBrainResource<T>(
  load: () => Promise<T>,
  enabled = true,
): {
  data: T | null
  error: string
  retry: () => void
} {
  const currentRevision = useBrain((s) => s.status?.revision ?? 0)
  const currentGeneration = useBrain((s) => s.status?.generation ?? '')
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let alive = true
    setData(null)
    setError('')
    if (!enabled) return
    void load()
      .then((value) => {
        if (alive) setData(value)
      })
      .catch((cause: unknown) => {
        if (alive) {
          const text = ipcErrorText(cause)
          setError(text)
          brainToast(text, 'error')
        }
      })
    return () => {
      alive = false
    }
  }, [load, currentRevision, currentGeneration, attempt, enabled])
  return { data, error, retry: () => setAttempt((value) => value + 1) }
}
