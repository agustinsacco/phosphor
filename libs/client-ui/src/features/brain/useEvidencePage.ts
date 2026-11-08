import { useEffect, useState } from 'react'
import type { BrainEvidencePage } from '@shared/brain'

/** Local inventory. Late pages cannot cross scope, cursor, policy or refresh changes. */
export function useEvidencePage(scope: string, cursor: string | undefined, revision: string) {
  const [result, setResult] = useState<{ key: string; page?: BrainEvidencePage; error?: string }>()
  const [attempt, setAttempt] = useState(0)
  const key = JSON.stringify([scope, cursor, revision, attempt])
  useEffect(() => {
    let current = true
    window.phosphor.invoke('brain:evidence', scope, cursor).then(
      (page) => {
        if (current) setResult({ key, page })
      },
      (cause: unknown) => {
        if (current) setResult({ key, error: String(cause) })
      },
    )
    return () => {
      current = false
    }
  }, [scope, cursor, key])
  const current = result?.key === key ? result : undefined
  return {
    page: current?.page,
    error: current?.error ?? '',
    reload: () => setAttempt((value) => value + 1),
  }
}
