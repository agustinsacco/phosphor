import { useEffect, useState } from 'react'
import { activeLearning, useLearningUi } from './learningUi'

/** Exactly one owner in the local sidebar. Rows only select this bounded projection. */
export function useLearningProjection(ready: boolean): string {
  const refresh = useLearningUi((s) => s.refresh)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!ready) return
    let disposed = false
    let loading = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async (): Promise<void> => {
      if (disposed || loading || document.visibilityState === 'hidden') return
      clearTimeout(timer)
      loading = true
      try {
        const result = await window.phosphor.invoke('brain:learningJobs')
        if (disposed) return
        useLearningUi.setState({
          jobs: result.items,
          truncated: result.truncated,
          policyEpoch: result.policy?.policyEpoch ?? null,
          enabled: result.policy?.enabled ?? false,
          workspaces: result.policy?.workspaces ?? [],
        })
        setError('')
        if (result.items.some(activeLearning))
          timer = setTimeout(() => {
            void load()
          }, 3000)
      } catch (cause) {
        if (!disposed) {
          useLearningUi.setState({ enabled: false, workspaces: [] })
          setError(String(cause))
        }
      } finally {
        loading = false
      }
    }
    const visible = (): void => {
      if (document.visibilityState === 'hidden') clearTimeout(timer)
      else void load()
    }
    void load()
    document.addEventListener('visibilitychange', visible)
    window.addEventListener('focus', visible)
    return () => {
      disposed = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', visible)
      window.removeEventListener('focus', visible)
    }
  }, [ready, refresh])
  return error
}
