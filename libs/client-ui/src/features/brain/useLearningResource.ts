import { useEffect, useState } from 'react'

/** Identity changes hide old data; same-target refresh preserves evidence-read review state. */
export function useLearningResource<T>(
  load: () => Promise<T>,
  revision?: unknown,
): {
  data: T | null
  error: string
  retry: () => void
} {
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{
    load: typeof load
    attempt: number
    revision: unknown
    data: T | null
    error: string
  } | null>(null)
  useEffect(() => {
    let disposed = false
    load().then(
      (data) => {
        if (!disposed) setResult({ load, attempt, revision, data, error: '' })
      },
      (cause: unknown) => {
        if (!disposed) setResult({ load, attempt, revision, data: null, error: String(cause) })
      },
    )
    return () => {
      disposed = true
    }
  }, [load, attempt, revision])
  const current = result?.load === load && result.revision === revision ? result : null
  return {
    data: current?.data ?? null,
    error: current?.attempt === attempt ? current.error : '',
    retry: () => setAttempt((n) => n + 1),
  }
}
