import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  compileQuery,
  DEFAULT_SEARCH_OPTIONS,
  escapeRegExp,
  type CompiledQuery,
  type SearchOptions,
} from '@shared/text-search'
import { focusedEditorSelection } from '@/lib/monacoInstance'

/**
 * One find bar's state: whether it is open, what it is looking for, and the
 * regex that query compiles to. Every surface (the transcript, an artifact)
 * owns one of these and decides for itself where to look and how to reveal a
 * hit; the bar and the matching rules are shared.
 */
export interface FindState {
  open: boolean
  query: string
  options: SearchOptions
  /** `empty` while the bar is closed, so a surface stops painting on close. */
  compiled: CompiledQuery
  inputRef: React.RefObject<HTMLInputElement | null>
  /** Bumps on every `show`, so the bar re-focuses and re-selects its field. */
  focusRequest: number
  /**
   * Open (or re-focus) the bar, replacing the query with `seed` when given —
   * escaped while the regex toggle is on, since a seed is text the reader
   * selected, not a pattern.
   */
  show: (seed?: string) => void
  /** Close and hand focus back to whatever had it before `show`. */
  close: () => void
  setQuery: (text: string) => void
  toggleOption: (key: keyof SearchOptions) => void
}

export function useFind(): FindState {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<SearchOptions>(DEFAULT_SEARCH_OPTIONS)
  const [focusRequest, setFocusRequest] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const optionsRef = useRef(options)
  useEffect(() => {
    optionsRef.current = options
  })

  const compiled = useMemo<CompiledQuery>(
    () => (open ? compileQuery({ text: query, ...options }) : { status: 'empty' }),
    [open, query, options],
  )

  const show = useCallback((seed?: string) => {
    const focused = document.activeElement
    // Re-showing from inside the bar (⌘F in its own field) must not make the
    // bar its own return target.
    if (
      focused instanceof HTMLElement &&
      focused !== inputRef.current &&
      !focused.closest('[data-find-bar]')
    ) {
      returnFocusRef.current = focused
    }
    if (seed) setQuery(optionsRef.current.regex ? escapeRegExp(seed) : seed)
    setOpen(true)
    setFocusRequest((n) => n + 1)
  }, [])

  const close = useCallback(() => {
    setOpen(false)
    const target = returnFocusRef.current
    returnFocusRef.current = null
    if (target?.isConnected) target.focus({ preventScroll: true })
  }, [])

  const toggleOption = useCallback((key: keyof SearchOptions) => {
    setOptions((current) => ({ ...current, [key]: !current[key] }))
  }, [])

  return {
    open,
    query,
    options,
    compiled,
    inputRef,
    focusRequest,
    show,
    close,
    setQuery,
    toggleOption,
  }
}

/**
 * Which of `count` matches is the current one. The stored index is clamped on
 * read, so a list that shrinks under the cursor (a streaming row re-rendered,
 * an artifact edited) never leaves it pointing past the end. -1 when there is
 * nothing to point at.
 */
export function useMatchCursor(count: number): {
  active: number
  setActive: (index: number) => void
  /** Move by `delta`, wrapping at either end as every find bar does. */
  step: (delta: number) => void
} {
  const [raw, setRaw] = useState(0)
  const active = count === 0 ? -1 : Math.min(Math.max(raw, 0), count - 1)
  const step = useCallback(
    (delta: number) => {
      if (count === 0) return
      setRaw((current) => {
        const from = Math.min(Math.max(current, 0), count - 1)
        return (((from + delta) % count) + count) % count
      })
    },
    [count],
  )
  return { active, setActive: setRaw, step }
}

/**
 * What to seed a freshly opened bar with: the focused editor's selection, or
 * else the page's, when it is a short single-line phrase. A selected
 * paragraph is someone copying, not someone about to search for the paragraph.
 */
export function selectionSeed(): string | undefined {
  const text = focusedEditorSelection() ?? window.getSelection()?.toString() ?? ''
  if (text === '' || text.length > 200 || /[\r\n]/.test(text)) return undefined
  return text
}
