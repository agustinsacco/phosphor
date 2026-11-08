import { useEffect, useState } from 'react'
import { ipcErrorText } from '@shared/errors'
import { brainToast } from './useBrain'

/** Ignore replies for a previous selection; every load has an explicit retry. */
export function useBrainResource<T>(
  load: () => Promise<T>,
  revision = 0,
): {
  data: T | null
  error: string
  retry: () => void
} {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let alive = true
    setData(null)
    setError('')
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
  }, [load, revision, attempt])
  return { data, error, retry: () => setAttempt((value) => value + 1) }
}
