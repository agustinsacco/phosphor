import { TooltipButton } from '@/components/Tooltip'
import { useEffect, useId, useMemo, useRef } from 'react'
import clsx from 'clsx'
import { TextInput } from '@/components/form'
import { CloseIcon, SearchIcon } from '@/components/icons'
import { useEscapeKey } from '@/components/Modal'
import { Highlighted } from '@/components/search/Highlighted'
import { useMatchCursor } from '@/components/search/useFind'
import type { SettingEntry } from './settingsIndex'
import { searchSettings, type SettingsResultGroup } from './settingsQuery'
import { useSettingsUiStore, type SettingsTab } from './settingsUiStore'

export interface SettingsSearch {
  query: string
  listing: boolean
  groups: Array<SettingsResultGroup & { start: number }>
  results: SettingEntry[]
  /** Matches per tab while there is a query; null without one. */
  counts: Map<SettingsTab, number> | null
  /** Highlighted result, -1 for none. */
  active: number
  setActive: (index: number) => void
  step: (delta: number) => void
  choose: (index: number) => void
  listId: string
}

const optionId = (listId: string, index: number): string => `${listId}-${index}`

/** Search state over the tabs in `available`, shared by the field and the results. */
export function useSettingsSearch(available: ReadonlySet<SettingsTab>): SettingsSearch {
  const query = useSettingsUiStore((s) => s.query)
  const listing = useSettingsUiStore((s) => s.listing)
  const listId = useId()

  const { groups, results, counts } = useMemo(() => {
    const found = query.trim() ? searchSettings(query, available) : []
    let start = 0
    return {
      groups: found.map((group) => {
        const placed = { ...group, start }
        start += group.entries.length
        return placed
      }),
      results: found.flatMap((group) => group.entries),
      counts: query.trim()
        ? new Map(found.map((group) => [group.tab, group.entries.length]))
        : null,
    }
  }, [query, available])

  const { active, setActive, step } = useMatchCursor(results.length)
  // A new query starts from its best result.
  useEffect(() => {
    setActive(0)
  }, [query, setActive])

  const choose = (index: number): void => {
    const entry = results[index]
    if (entry) useSettingsUiStore.getState().openResult(entry.tab, entry.title)
  }

  return { query, listing, groups, results, counts, active, setActive, step, choose, listId }
}

/**
 * The sidebar's search field, a combobox over the results list. ↑/↓ move,
 * Enter opens (or lists the results again), Escape clears before it closes.
 */
export function SettingsSearchField({
  search,
  inputRef,
}: {
  search: SettingsSearch
  inputRef: React.RefObject<HTMLInputElement | null>
}): React.JSX.Element {
  const { query, listing, active, listId } = search
  const setQuery = useSettingsUiStore((s) => s.setQuery)
  // Inside the overlay, so it outranks the overlay's own Escape-to-close.
  useEscapeKey(() => setQuery(''), query !== '')

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!listing) return
      event.preventDefault()
      search.step(event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Enter' && query.trim()) {
      event.preventDefault()
      if (listing) search.choose(active)
      else setQuery(query)
    }
  }

  return (
    <div role="search" className="relative">
      <SearchIcon
        size={12}
        className="text-text-tertiary pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2"
      />
      <TextInput
        ref={inputRef}
        size="sm"
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Search settings"
        aria-label="Search settings"
        role="combobox"
        aria-expanded={listing}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={listing && active >= 0 ? optionId(listId, active) : undefined}
        spellCheck={false}
        className="find-field w-full pl-7 pr-7"
      />
      {query && (
        <TooltipButton
          type="button"
          aria-label="Clear search"
          title="Clear search (Esc)"
          onClick={() => {
            setQuery('')
            inputRef.current?.focus()
          }}
          className="text-text-tertiary hover:text-text hover:bg-bg-secondary absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded transition-colors"
        >
          <CloseIcon size={10} strokeWidth={2.5} />
        </TooltipButton>
      )}
    </div>
  )
}

/** Results grouped by tab, in place of the tab panel while the field has a query. */
export function SettingsSearchResults({ search }: { search: SettingsSearch }): React.JSX.Element {
  const { query, groups, results, active, listId } = search
  const activeRef = useRef<HTMLDivElement>(null)
  // A block body: Chromium's scrollIntoView returns a promise, which React
  // would take for a cleanup.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [active])

  return (
    <div>
      <p role="status" className="text-text-tertiary mb-3 pr-8 text-sm">
        {results.length === 0
          ? `No settings match “${query.trim()}”.`
          : `${results.length} ${results.length === 1 ? 'result' : 'results'}`}
      </p>
      <div id={listId} role="listbox" aria-label="Settings search results">
        {groups.map((group) => (
          <div key={group.tab} role="group" aria-label={group.label} className="mb-4 last:mb-0">
            <div className="text-text-tertiary mb-1 px-2.5 font-mono text-xs font-semibold uppercase tracking-wider">
              {group.label}
            </div>
            {group.entries.map((entry, offset) => {
              const index = group.start + offset
              const selected = index === active
              return (
                <div
                  key={`${entry.section}/${entry.title}`}
                  id={optionId(listId, index)}
                  ref={selected ? activeRef : undefined}
                  role="option"
                  data-tooltip={entry.title}
                  aria-selected={selected}
                  onMouseMove={() => search.setActive(index)}
                  onClick={() => search.choose(index)}
                  className={clsx(
                    'flex cursor-pointer flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 rounded-lg px-2.5 py-2 transition-colors',
                    selected && 'bg-bg-secondary',
                  )}
                >
                  <span className="min-w-0 text-lg">
                    <Highlighted text={entry.title} query={query} />
                  </span>
                  {(entry.section || entry.detail) && (
                    <span className="text-text-tertiary flex shrink-0 items-center gap-2 text-sm">
                      {entry.section && (
                        <span>
                          <Highlighted text={entry.section} query={query} />
                        </span>
                      )}
                      {entry.detail && (
                        <kbd className="bg-bg-secondary border-border rounded-md border px-1.5 font-mono text-xs">
                          {entry.detail}
                        </kbd>
                      )}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
