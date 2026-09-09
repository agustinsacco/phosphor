import { useCallback, useMemo, useState } from 'react'
import { filterCommandEntries, type CommandEntry } from './CommandMenu'

/**
 * The `/` menu, shared by the chat composer and the home composer.
 *
 * `ComposerField` deliberately owns no popups (see its docstring), so both
 * composers have to drive this themselves — and the home one simply did not,
 * which is why a new session offered no skills until after its first prompt.
 * Everything that would have been copied to fix that lives here instead: when
 * the menu is open, what it matches, keyboard navigation, and what picking
 * does.
 *
 * The two callers still differ in where the entries come from (a live session's
 * RPC list vs. `stores/piCommands`) and in whether native session commands
 * exist at all, so the hook takes the entries and leaves that to them.
 */

/**
 * The query the composer's text implies, or null when the menu is closed.
 *
 * Only a value that *starts* with `/` and has no whitespace yet: a slash mid
 * prompt is a path, and the first space means the command is chosen and the
 * user is typing arguments.
 */
export function slashQuery(value: string): string | null {
  return value.startsWith('/') && !/\s/.test(value) ? value.slice(1) : null
}

export interface SlashMenu {
  /** Null when closed. */
  query: string | null
  matches: CommandEntry[]
  /** True when the popup should render (open AND non-empty). */
  visible: boolean
  activeIndex: number
  setActiveIndex: (index: number) => void
  close: () => void
  /** Recompute from the composer value; call on every change. */
  sync: (value: string) => void
  /** Arrows/Enter/Tab/Escape while visible. True when the key was consumed. */
  handleKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean
  pick: (entry: CommandEntry) => void
}

export function useSlashMenu({
  entries,
  setText,
  onOpen,
  focus,
}: {
  entries: CommandEntry[]
  setText: (value: string) => void
  /** Fired when the menu opens — the home composer loads its list lazily. */
  onOpen?: () => void
  focus?: () => void
}): SlashMenu {
  const [query, setQuery] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)

  const matches = useMemo(
    () => (query === null ? [] : filterCommandEntries(query, entries)),
    [query, entries],
  )
  const visible = query !== null && matches.length > 0

  const close = useCallback(() => setQuery(null), [])

  const sync = useCallback(
    (value: string) => {
      const next = slashQuery(value)
      setQuery(next)
      setActiveIndex(0)
      if (next !== null) onOpen?.()
    },
    [onOpen],
  )

  const pick = useCallback(
    (entry: CommandEntry) => {
      setQuery(null)
      if (entry.native) {
        setText('')
        entry.native.run()
        return
      }
      // pi commands: prefill "/name " so the user can add arguments, or send
      // on Enter.
      setText(`/${entry.name} `)
      focus?.()
    },
    [setText, focus],
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!visible) return false
      const count = matches.length
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveIndex((i) => (i + 1) % count)
        return true
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex((i) => (i - 1 + count) % count)
        return true
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault()
        const entry = matches[activeIndex]
        if (entry) pick(entry)
        return true
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setQuery(null)
        return true
      }
      return false
    },
    [visible, matches, activeIndex, pick],
  )

  return {
    query,
    matches,
    visible,
    activeIndex,
    setActiveIndex,
    close,
    sync,
    handleKeyDown,
    pick,
  }
}
