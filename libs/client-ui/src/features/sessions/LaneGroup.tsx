import clsx from 'clsx'
import { SearchIcon } from '@/components/icons'
import { TooltipButton } from '@/components/Tooltip'
import type { GroupSearch } from './groupSearch'
import { useLaneReveal } from './laneReveal'
import { LaneSearchBar } from './LaneSearchBar'
import { WorkspaceGroupHeader, WorkspaceGroupTitle } from './SidebarPrimitives'

/** `sidebar` is Desktop's dense list; `page` gives the header controls touch-sized targets. */
export type LaneGroupDensity = 'sidebar' | 'page'

export interface LaneGroupProps {
  /** Reveal and collapse key: `localLaneGroupKey` or `remoteLaneGroupKey`. */
  groupKey: string
  name: string
  /** Beside the name, such as "last known". */
  badge?: React.ReactNode
  collapse: [boolean, (collapsed: boolean) => void]
  search: GroupSearch
  /** Lanes in the group, and those the search shows. */
  total: number
  shown: number
  density?: LaneGroupDensity
  /** The header's machine controls (options menu, new lane), sized by `className`. */
  controls: (className: string) => React.ReactNode
  notice?: string
  dimmed?: boolean
  rows: React.ReactNode
  bulkDelete: React.ReactNode
}

/**
 * One folder group and its lanes, on any machine: the header (collapse,
 * search, the machine's own controls), a notice, the search bar, the rows or
 * the empty line, and the group's bulk delete. A machine adapter supplies the
 * data and the slots; the shell owns the layout, reveal and the empty copy.
 */
export function LaneGroup({
  groupKey,
  name,
  badge,
  collapse: [collapsed, setCollapsed],
  search,
  total,
  shown,
  density = 'sidebar',
  controls,
  notice,
  dimmed = false,
  rows,
  bulkDelete,
}: LaneGroupProps): React.JSX.Element {
  useLaneReveal(groupKey, () => {
    setCollapsed(false)
    search.clear()
  })
  const controlClass = clsx(
    'text-text-tertiary hover:text-text hover:bg-sidebar-hover flex shrink-0 items-center justify-center rounded-md transition-colors',
    density === 'page' ? 'h-7 w-7' : 'h-5 w-5',
  )
  return (
    <section aria-label={name} className="min-w-0">
      <WorkspaceGroupHeader>
        <WorkspaceGroupTitle
          name={name}
          collapsed={collapsed}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        >
          {badge}
        </WorkspaceGroupTitle>
        <SearchToggle
          name={name}
          search={search}
          className={controlClass}
          onOpen={() => setCollapsed(false)}
        />
        {controls(controlClass)}
      </WorkspaceGroupHeader>
      {notice && <p className="text-text-tertiary px-2 py-1 text-sm">{notice}</p>}
      {search.searching && (
        <LaneSearchBar
          value={search.draft}
          applied={!!search.query}
          matchCount={shown}
          total={total}
          onChange={search.setDraft}
          onCommit={search.commit}
          onClear={search.clear}
        />
      )}
      {!collapsed && (
        <div className={dimmed ? 'opacity-50' : undefined}>
          {rows}
          {!shown && (
            <p className="text-text-tertiary px-2 py-2 text-sm">
              {search.query ? `No lanes match “${search.query}”` : 'No lanes yet'}
            </p>
          )}
        </div>
      )}
      {bulkDelete}
    </section>
  )
}

/** The header's search button: opens the search bar, or closes and clears it. */
function SearchToggle({
  name,
  search,
  className,
  onOpen,
}: {
  name: string
  search: GroupSearch
  className: string
  onOpen: () => void
}): React.JSX.Element {
  return (
    <TooltipButton
      className={className}
      aria-label={`Search lanes in ${name}`}
      aria-expanded={search.searching}
      title="Search lanes"
      onClick={() => {
        if (search.searching) search.clear()
        else {
          search.open()
          onOpen()
        }
      }}
    >
      <SearchIcon size={12} />
    </TooltipButton>
  )
}
