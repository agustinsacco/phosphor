import { useCallback, useEffect, useRef, useState } from 'react'
import { BRAIN_TIDY_KINDS, type BrainTidyKind, type BrainTidyPage } from '@shared/brain-tidy'
import { ipcErrorText } from '@shared/errors'
import { useBrain } from '../useBrain'

const PAGE = 20
const CHANGED = 'Brain changed while loading. Retry to see the latest suggestions.'
const ofKind = (page: BrainTidyPage | null, kind: BrainTidyKind): number =>
  page?.items.filter((item) => item.kind === kind).length ?? 0

/** Pages of one kind (or of all, newest first) until `target` rows, all at one revision. */
async function loadTidy(kind: BrainTidyKind | null, target: number): Promise<BrainTidyPage> {
  let result = await window.phosphor.invoke('brain:tidy', kind, null, PAGE)
  while (result.next && result.items.length < target) {
    const next = await window.phosphor.invoke('brain:tidy', kind, result.next, PAGE)
    if (next.revision !== result.revision) throw new Error(CHANGED)
    result = { ...next, items: [...result.items, ...next.items] }
  }
  return result
}

/**
 * The newest suggestions, plus the older rows of each kind the owner asked to see. Every
 * reload loads all of them again together; a late page never restores removed rows.
 */
export function useTidyPage(active: boolean, navigation = 0) {
  const status = useBrain((s) => s.status)
  const [page, setPage] = useState<BrainTidyPage | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const request = useRef(0)
  const latest = useRef<BrainTidyPage | null>(null)
  /** Per kind, how many rows to keep loaded: set by `reload(kind)`, kept by every reload. */
  const shown = useRef<Partial<Record<BrainTidyKind, number>>>({})
  const reload = useCallback(async (more: BrainTidyKind | null = null) => {
    const ticket = ++request.current
    // Counted before loading, so Retry after a failure still loads what was asked for.
    if (more)
      shown.current[more] = Math.max(shown.current[more] ?? 0, ofKind(latest.current, more)) + PAGE
    setLoading(true)
    setError('')
    try {
      const newest = await loadTidy(null, PAGE)
      let items = newest.items
      for (const kind of BRAIN_TIDY_KINDS) {
        const want = Math.min(shown.current[kind] ?? 0, newest.counts[kind])
        if (ofKind(newest, kind) >= want) continue
        const older = await loadTidy(kind, want)
        if (older.revision !== newest.revision) throw new Error(CHANGED)
        const loaded = new Set(items.map((item) => item.id))
        items = [...items, ...older.items.filter((item) => !loaded.has(item.id))]
      }
      if (ticket !== request.current) return null
      const ordered = {
        ...newest,
        items: items.toSorted(
          (a, b) => BRAIN_TIDY_KINDS.indexOf(a.kind) - BRAIN_TIDY_KINDS.indexOf(b.kind),
        ),
      }
      latest.current = ordered
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
