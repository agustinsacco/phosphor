import clsx from 'clsx'
import { useMenuTriggers, type ContextMenuItem } from '@/components/ContextMenu'
import { TooltipButton } from '@/components/Tooltip'
import { ChevronIcon } from '@/components/icons'
import { PhosphorLoader } from '@/components/PhosphorLoader'
import type { SubtitleSegment } from './sessionSubtitle'

type LaneActivity = 'opening' | 'starting' | 'working'
const ACTIVITY_LABEL: Record<LaneActivity, string> = {
  opening: 'Opening',
  starting: 'Starting',
  working: 'Working',
}

export function SubtitleSegments({
  segments,
  activity,
}: {
  segments: SubtitleSegment[]
  activity?: LaneActivity
}): React.JSX.Element {
  const leadingActivity = activity && !segments.some((segment) => segment.key === 'time')
  return (
    <>
      {leadingActivity && (
        <span className="lane-activity-label shrink-0">{ACTIVITY_LABEL[activity]}</span>
      )}
      {segments.map((segment, i) => (
        <span
          key={segment.key}
          data-segment={segment.key}
          className={clsx(
            'flex items-center',
            // The branch is the only segment allowed to give up space.
            // Both classes set flex-shrink, so they must be exclusive:
            // emitting `shrink-0 shrink` let source order decide and
            // `shrink-0` won, which is what pushed long branch names past
            // the sidebar edge and produced a horizontal scrollbar.
            segment.truncate ? 'min-w-0 shrink' : 'shrink-0',
          )}
        >
          {(i > 0 || leadingActivity) && <span className="pr-1">·</span>}
          {segment.key === 'time' && activity ? (
            <span className="lane-activity-label" data-tooltip={`Last activity: ${segment.text}`}>
              {ACTIVITY_LABEL[activity]}
            </span>
          ) : segment.key === 'worktree' ? (
            <span
              className="bg-chip text-text-secondary rounded px-1 font-medium"
              data-tooltip="Runs in a git worktree"
            >
              wt
            </span>
          ) : segment.key === 'branch' ? (
            <span className="truncate" data-tooltip={segment.text}>
              ⎇ {segment.text}
            </span>
          ) : (
            <span className={clsx(segment.key === 'dirty' && 'text-warning')}>{segment.text}</span>
          )}
        </span>
      ))}
    </>
  )
}

/**
 * The dot at the head of a session row, in its four states.
 *
 * `data-testid` and `data-state` are asserted by e2e/smoke.spec.ts — the row
 * types must keep emitting the same values.
 */
export function SessionIndicator({
  state,
}: {
  state: 'streaming' | 'unseen' | 'live' | 'disk'
}): React.JSX.Element {
  return (
    <span
      data-testid="session-indicator"
      data-state={state}
      className="flex size-5 shrink-0 items-center justify-center"
    >
      {state === 'streaming' ? (
        <PhosphorLoader size={20} decorative />
      ) : state === 'unseen' ? (
        <span className="bg-success h-2 w-2 rounded-full" data-tooltip="New activity" />
      ) : state === 'live' ? (
        <span className="border-success h-2 w-2 rounded-full border" data-tooltip="Live session" />
      ) : (
        <span className="border-border-strong h-2 w-2 rounded-full border" />
      )}
    </span>
  )
}

export function LaneRow({
  className,
  ...props
}: React.ComponentPropsWithRef<typeof TooltipButton>): React.JSX.Element {
  return (
    <TooltipButton
      {...props}
      className={clsx(
        'lane-row group flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left transition-[color,background-color,opacity]',
        className,
      )}
    />
  )
}

const NO_MENU = (): ContextMenuItem[] => []

/** A group's header row. `menu` opens on right-click, the menu key or a long-press. */
export function WorkspaceGroupHeader({
  children,
  menu,
  menuTitle,
  ...props
}: React.ComponentProps<'div'> & {
  menu?: () => ContextMenuItem[]
  menuTitle?: string
}): React.JSX.Element {
  const triggers = useMenuTriggers(menu ?? NO_MENU, { title: menuTitle, disabled: !menu })
  return (
    <div
      {...props}
      {...(menu ? triggers : {})}
      className="group/header relative flex w-full items-center gap-1 pb-0.5 pl-2 pr-1 pt-2.5"
    >
      {children}
    </div>
  )
}

export function WorkspaceGroupTitle({
  name,
  collapsed,
  liveCount = 0,
  children,
  ...props
}: Omit<React.ComponentPropsWithRef<typeof TooltipButton>, 'children'> & {
  name: string
  collapsed: boolean
  liveCount?: number
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <TooltipButton
      {...props}
      className="text-text-secondary hover:text-text flex min-w-0 flex-1 items-center gap-1 py-0.5 text-left text-sm font-semibold font-mono uppercase tracking-wider transition-colors"
    >
      <span className="min-w-0 truncate">{name}</span>
      <ChevronIcon
        size={8}
        strokeWidth={3}
        expanded={!collapsed}
        className={clsx(
          'shrink-0 transition-opacity',
          !collapsed && 'opacity-0 group-hover/header:opacity-100',
        )}
      />
      {liveCount > 0 && (
        <span
          className="bg-success h-1.5 w-1.5 shrink-0 rounded-full"
          data-tooltip={`${liveCount} live`}
        />
      )}
      {children}
    </TooltipButton>
  )
}

/** A label over a section of rows that is not a folder group, such as Pinned. */
export function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="text-text-tertiary px-2 pb-0.5 pt-2.5 text-xs font-semibold font-mono uppercase tracking-wider">
      {children}
    </div>
  )
}

/**
 * Placeholder headers for the whole group list, before prefs have landed.
 *
 * Distinct from `SessionRowSkeletons`, which stands in for the sessions
 * *inside* a group whose folders are known. This one covers the earlier
 * window, when which projects exist and what order they take is still
 * unknown, and painting a real header means painting one that may vanish.
 */
export function WorkspaceGroupSkeletons(): React.JSX.Element {
  return (
    <div data-testid="workspace-groups-loading" aria-busy="true">
      {[0, 1].map((i) => (
        <div key={i}>
          <div className="px-2 pb-0.5 pt-2.5">
            <div
              className="bg-sidebar-hover h-3 animate-pulse rounded"
              style={{ width: `${45 - i * 10}%` }}
            />
          </div>
          <SessionRowSkeletons />
        </div>
      ))}
    </div>
  )
}

/**
 * Placeholder rows for a group whose folders have not been scanned yet.
 *
 * Replaces a single "Loading sessions…" line: the line was indistinguishable
 * from the empty state one character at a time, and gave no sense of a list
 * arriving.
 */
export function SessionRowSkeletons(): React.JSX.Element {
  return (
    <div className="space-y-2 px-2 py-2" data-testid="sessions-loading" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-1">
          <div
            className="bg-sidebar-hover h-3 animate-pulse rounded"
            style={{ width: `${70 - i * 12}%` }}
          />
          <div className="bg-sidebar-hover h-2 w-1/3 animate-pulse rounded opacity-60" />
        </div>
      ))}
    </div>
  )
}
