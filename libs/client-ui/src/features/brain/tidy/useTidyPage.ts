import { useCallback, useEffect, useRef, useState } from 'react'
import { BRAIN_TIDY_KINDS, type BrainTidyPage } from '@shared/brain-tidy'
import { ipcErrorText } from '@shared/errors'
import { useBrain } from '../useBrain'

/** Reload the already-visible pages together; a late page never restores removed rows. */
export function useTidyPage(active: boolean, navigation = 0) {
  const status = useBrain((s) => s.status)
  const [page, setPage] = useState<BrainTidyPage | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const request = useRef(0)
  const visible = useRef(20)
  const reload = useCallback(async (more = false): Promise<BrainTidyPage | null> => {
    const ticket = ++request.current
    setLoading(true)
    setError('')
    try {
      const target = visible.current + (more ? 20 : 0)
      let result = await window.phosphor.invoke('brain:tidy', null, null, 20)
      while (result.next && result.items.length < target) {
        const next = await window.phosphor.invoke('brain:tidy', null, result.next, 20)
        if (next.revision !== result.revision)
          throw new Error('Brain changed while loading. Retry to see the latest suggestions.')
        result = { ...next, items: [...result.items, ...next.items] }
      }
      if (ticket !== request.current) return null
      visible.current = Math.max(20, result.items.length)
      const ordered = {
        ...result,
        items: result.items.toSorted(
          (a, b) => BRAIN_TIDY_KINDS.indexOf(a.kind) - BRAIN_TIDY_KINDS.indexOf(b.kind),
        ),
      }
      setPage(ordered)
      return ordered
    } catch (cause) {
      if (ticket === request.current) setError(ipcErrorText(cause))
      return null
    } finally {
      if (ticket === request.current) setLoading(false)
    }
  }, [])
  const invalidate = useCallback(() => {
    request.current++
  }, [])
  const summary = JSON.stringify(status?.tidy)
  useEffect(() => {
    if (active) void reload()
    return invalidate
  }, [active, reload, invalidate, status?.revision, status?.generation, summary, navigation])
  useEffect(() => {
    if (!active || !status?.tidy.running) return
    const timer = setInterval(() => {
      void reload()
    }, 2000)
    return () => clearInterval(timer)
  }, [active, status?.tidy.running, reload])
  return { page, error, loading, reload }
}
