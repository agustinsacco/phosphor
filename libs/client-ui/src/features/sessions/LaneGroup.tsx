import { useRef, useState } from 'react'
import clsx from 'clsx'
import type { ContextMenuItem } from '@/components/ContextMenu'
import { MoreIcon, SearchIcon } from '@/components/icons'
import { PopupMenu } from '@/components/PopupMenu'
import { TooltipButton } from '@/components/Tooltip'
import type { GroupSearch } from './groupSearch'
import { LaneSelectionRows } from './LaneSelectionRows'
import { useLaneReveal } from './laneReveal'
import { LaneSearchBar } from './LaneSearchBar'
import { WorkspaceGroupHeader, WorkspaceGroupTitle } from './SidebarPrimitives'

/** `sidebar` is Desktop's dense list; `page` gives the header controls touch-sized targets. */
export type LaneGroupDensity = 'sidebar' | 'page'

export interface LaneGroupProps {
  /** Reveal and collapse key: `localLaneGroupKey` or `remoteLaneGroupKey`. */
  groupKey: string
  name: string
  /** The title's tooltip, such as the folder's path. */
  tooltip?: string
  liveCount?: number
  /** Beside the name, such as "last known". */
  badge?: React.ReactNode
  /** The header's right-click menu. */
  menu?: () => ContextMenuItem[]
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
  /** What a group with no rows shows instead of "No lanes yet", such as its scan state. */
  empty?: React.ReactNode
  bulkDelete: React.ReactNode
}

const IDLE_CONTROL = 'text-text-tertiary hover:text-text hover:bg-sidebar-hover'

/**
 * One folder group and its lanes, on any machine: the header (collapse,
 * search, the machine's own controls), a notice, the search bar, the rows or
 * the empty line, and the group's bulk delete. A machine adapter supplies the
 * data and the slots; the shell owns the layout, reveal and the empty copy.
 */
export function LaneGroup({
  groupKey,
  name,
  tooltip,
  liveCount,
  badge,
  menu,
  collapse: [collapsed, setCollapsed],
  search,
  total,
  shown,
  density = 'sidebar',
  controls,
  notice,
  dimmed = false,
  rows,
  empty,
  bulkDelete,
}: LaneGroupProps): React.JSX.Element {
  useLaneReveal(groupKey, () => {
    setCollapsed(false)
    search.clear()
  })
  const controlBox = clsx(
    'flex shrink-0 items-center justify-center rounded-md transition-colors',
    density === 'page' ? 'h-7 w-7' : 'h-5 w-5',
  )
  const controlClass = clsx(IDLE_CONTROL, controlBox)
  return (
    <section aria-label={name} className="min-w-0">
      <WorkspaceGroupHeader menu={menu} menuTitle={name}>
        <WorkspaceGroupTitle
          name={name}
          collapsed={collapsed}
          liveCount={liveCount}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
          data-testid="workspace-group"
          title={tooltip}
        >
          {badge}
        </WorkspaceGroupTitle>
        <SearchToggle
          name={name}
          search={search}
          className={clsx(
            controlBox,
            'active:scale-90',
            search.query ? 'bg-accent-soft text-accent' : IDLE_CONTROL,
          )}
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
          {!shown && <EmptyLine query={search.query} total={total} empty={empty} />}
        </div>
      )}
      {bulkDelete}
    </section>
  )
}

/**
 * A group with no rows to show: no match for the applied search when it has
 * lanes, else the machine's own state, else "No lanes yet".
 */
function EmptyLine({
  query,
  total,
  empty,
}: {
  query: string
  total: number
  empty: React.ReactNode
}): React.ReactNode {
  if (query && total)
    return (
      <p data-testid="lane-search-empty" className="text-text-tertiary px-2 py-2 text-sm">
        No lanes match “{query}”
      </p>
    )
  if (empty !== undefined) return empty
  return <p className="text-text-tertiary px-2 py-2 text-sm">No lanes yet</p>
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
      data-testid="workspace-group-search"
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

/**
 * A group's "⋯" menu, on any machine: lane selection for bulk delete and
 * collapse, then the machine's own folder rows. Permanent, not hover-revealed:
 * a control you cannot see is a control you do not know exists.
 */
export function LaneGroupOptions({
  name,
  className,
  selection,
  folderRows,
}: {
  name: string
  className: string
  selection: Omit<React.ComponentProps<typeof LaneSelectionRows>, 'onDone'>
  /** The machine's folder rows; `close` closes the menu. */
  folderRows: (close: () => void) => React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const close = (): void => setOpen(false)
  return (
    <>
      <TooltipButton
        ref={trigger}
        className={className}
        aria-label={`Workspace options for ${name}`}
        aria-expanded={open}
        data-testid="workspace-group-menu"
        title="Workspace options"
        onClick={() => setOpen(!open)}
      >
        <MoreIcon size={14} />
      </TooltipButton>
      {open && (
        <PopupMenu
          triggerRef={trigger}
          onClose={close}
          className="absolute right-1 top-full z-40 mt-1 min-w-36 py-1"
        >
          <LaneSelectionRows {...selection} onDone={close} />
          {folderRows(close)}
        </PopupMenu>
      )}
    </>
  )
}
