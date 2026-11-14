import { TooltipButton } from '@/components/Tooltip'
import { useRef } from 'react'
import clsx from 'clsx'
import type { GhPrDetail, GhPrSummary } from '@shared/models'
import type { CheckGroups } from './checkGroups'
import { reviewPeople } from './PrPeopleTabs'

export type PrTabId = 'overview' | 'checks' | 'reviews' | 'threads' | 'activity'

export interface PrTab {
  id: PrTabId
  label: string
  count?: string
}

/** Overview, Checks N, Reviews N, Threads N, Activity. A count GitHub capped reads `100+`. */
export function prTabs(
  summary: GhPrSummary | undefined,
  detail: GhPrDetail | undefined,
  groups: CheckGroups,
): PrTab[] {
  const checks = groups.known ? `${groups.counts.total}${groups.truncated ? '+' : ''}` : undefined
  const reviews = summary ? String(reviewPeople(summary, detail).length) : undefined
  const unresolved = summary
    ? summary.threads
      ? String(summary.threads.unresolved)
      : '100+'
    : detail
      ? `${detail.threads.length}${detail.threadsTruncated ? '+' : ''}`
      : undefined
  return [
    { id: 'overview', label: 'Overview' },
    { id: 'checks', label: 'Checks', count: checks },
    { id: 'reviews', label: 'Reviews', count: reviews },
    { id: 'threads', label: 'Threads', count: unresolved },
    { id: 'activity', label: 'Activity' },
  ]
}

export const tabId = (base: string, id: PrTabId) => `${base}-tab-${id}`
export const panelId = (base: string, id: PrTabId) => `${base}-panel-${id}`

/** One tab stop; arrow keys, Home and End move between tabs and show each. */
export function PrTabList({
  base,
  tabs,
  active,
  onChange,
}: {
  base: string
  tabs: PrTab[]
  active: PrTabId
  onChange: (id: PrTabId) => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const move = (event: React.KeyboardEvent): void => {
    const index = tabs.findIndex((tab) => tab.id === active)
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % tabs.length
        : event.key === 'ArrowLeft'
          ? (index - 1 + tabs.length) % tabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : null
    if (next === null) return
    event.preventDefault()
    onChange(tabs[next]!.id)
    ref.current?.querySelector<HTMLElement>(`#${CSS.escape(tabId(base, tabs[next]!.id))}`)?.focus()
  }
  return (
    <div
      ref={ref}
      role="tablist"
      aria-label="Pull request sections"
      onKeyDown={move}
      className="border-border mt-2 flex gap-0.5 overflow-x-auto border-b px-2"
    >
      {tabs.map((tab) => {
        const selected = tab.id === active
        return (
          <TooltipButton
            key={tab.id}
            id={tabId(base, tab.id)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={panelId(base, tab.id)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={clsx(
              'focus-visible:outline-accent -mb-px flex shrink-0 items-center gap-1 whitespace-nowrap rounded-t-md border-b-2 px-2 pb-1.5 pt-1 text-base focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2',
              selected
                ? 'border-accent text-text'
                : 'text-text-secondary hover:text-text border-transparent',
            )}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span className="text-text-tertiary font-mono text-sm tabular-nums">{tab.count}</span>
            )}
          </TooltipButton>
        )
      })}
    </div>
  )
}
