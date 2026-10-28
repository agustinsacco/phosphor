import { useEffect, useMemo, useState, type RefObject } from 'react'
import { fuzzyFilter } from '@/lib/fuzzy'

/** Where `@` mentions read files from. `key` names the list, so a new target reads again. */
export interface FileMentionSource {
  key: string
  list: () => Promise<string[]>
}

/** A workspace's files through `fs:listFiles`, the source a composer uses by default. */
export function workspaceFileSource(workspacePath: string): FileMentionSource {
  return { key: workspacePath, list: () => window.phosphor.invoke('fs:listFiles', workspacePath) }
}

/**
 * The `@` file menu: when it is open, what it matches and what picking does.
 * The list loads on the first `@` and is kept per source key.
 */
export function useFileMentions({
  source,
  value,
  onChange,
  textareaRef,
}: {
  source: FileMentionSource | null
  value: string
  onChange: (value: string, caret: number) => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
}) {
  const [mention, setMention] = useState<{ anchor: number; query: string } | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [index, setIndex] = useState<{ key: string; files: string[] } | null>(null)
  useEffect(() => {
    if (!source || !mention || index?.key === source.key) return
    let cancelled = false
    source
      .list()
      .then((files) => {
        if (!cancelled) setIndex({ key: source.key, files })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [mention, source, index])
  // Sending/clearing a draft must close its popup, including attachment-only sends.
  useEffect(() => {
    if (!value) setMention(null)
  }, [value])
  const matches = useMemo(
    () =>
      mention && index && index.key === source?.key
        ? fuzzyFilter(mention.query, index.files, (f) => f, 12)
        : [],
    [mention, index, source?.key],
  )
  const track = (next: string, caret: number): void => {
    const match = /(^|\s)@([^\s@]*)$/.exec(next.slice(0, caret))
    setMention(match ? { anchor: caret - match[2]!.length - 1, query: match[2]! } : null)
    setActiveIndex(0)
  }
  const pick = (file: string): void => {
    if (!mention) return
    const after = value.slice(mention.anchor + 1 + mention.query.length)
    const next = value.slice(0, mention.anchor) + file + (after.startsWith(' ') ? '' : ' ') + after
    onChange(next, mention.anchor + file.length + 1)
    setMention(null)
    textareaRef.current?.focus()
  }
  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean =>
    !!mention &&
    mentionKey(event, matches, activeIndex, setActiveIndex, pick, () => setMention(null))
  return {
    open: mention !== null,
    matches,
    activeIndex,
    setActiveIndex,
    track,
    pick,
    handleKeyDown,
    close: () => setMention(null),
  }
}

/** Arrows, Enter/Tab and Escape while the menu shows matches. True when consumed. */
function mentionKey(
  event: React.KeyboardEvent<HTMLTextAreaElement>,
  matches: string[],
  activeIndex: number,
  setActiveIndex: (update: (index: number) => number) => void,
  pick: (file: string) => void,
  close: () => void,
): boolean {
  if (!matches.length) return false
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const step = event.key === 'ArrowDown' ? 1 : -1
    setActiveIndex((i) => (i + step + matches.length) % matches.length)
    return true
  }
  if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
    event.preventDefault()
    const file = matches[activeIndex]
    if (file) pick(file)
    return true
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    return true
  }
  return false
}
