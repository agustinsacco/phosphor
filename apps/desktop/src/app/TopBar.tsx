import clsx from 'clsx'
import { useChatStore } from '@/stores/chat'
import { SwarmBadge } from '@/features/chat/composer/SwarmSwitch'
import { useArtifactsStore } from '@/stores/artifacts'
import { useLayoutStore, sessionPanes } from '@/stores/layout'
import { useSessionsStore } from '@/stores/sessions'
import { runningCount, sessionTerminals, useTerminalStore } from '@/stores/terminal'
import {
  ArtifactsIcon,
  ChangesIcon,
  BranchIcon,
  FileIcon,
  SidebarToggleIcon,
  TerminalIcon,
} from '@/components/icons'
import { SessionMenu } from '@/features/chat/SessionMenu'
import { BranchControl } from '@/features/worktrees/BranchControl'
import { WorkspaceChip } from '@/features/workspaces/WorkspaceChip'
import { sessionTitle } from '@/lib/sessionTitle'
import { useNameTransition } from '@/features/sessions/nameTransition'
import { formatShortcut } from '@/lib/shortcuts'
import { useCurrentWork } from '@/features/chat/currentWork'

/**
 * The window's one and only title bar.
 *
 * Every column used to grow its own `h-11` header, and only the chat's carried
 * `.titlebar-inset-end` — the padding that keeps content clear of the OS
 * close/minimize buttons that Electron paints over the top-right of the page
 * on Windows and Linux. That worked exactly until a right-hand pane opened, at
 * which point the *pane* owned the top-right corner and its expand/close
 * buttons rendered underneath the real window controls.
 *
 * Hoisting the bar above all three columns fixes that structurally rather than
 * by tuning padding per column: one element spans the window, so one inset is
 * both necessary and sufficient, and no future pane can reintroduce the bug.
 * It also gives the workspace and branch controls a fixed home instead of
 * moving between the home composer and the chat header.
 */
export function TopBar({ workspacePath }: { workspacePath: string }): React.JSX.Element {
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const sidebarVisible = useLayoutStore((s) => s.sidebarVisible)

  return (
    <header className="titlebar-drag titlebar-inset-start titlebar-inset-end border-border bg-bg flex h-11 shrink-0 items-center gap-2 border-b">
      <IconButton
        title={`${sidebarVisible ? 'Hide' : 'Show'} sidebar (${formatShortcut('mod', 'B')})`}
        active={false}
        onClick={() => useLayoutStore.getState().toggleSidebar()}
      >
        <SidebarToggleIcon />
      </IconButton>

      {/* Folder then branch: the two halves of "where am I working", both
          clickable, in the order Claude Desktop puts them.

          Session screens only. The home screen renders the same two controls
          directly above its composer, where choosing them is the point of the
          screen rather than window furniture — and rendering them in both
          places at once would put two identical folder chips on one screen,
          which is the "two answers to one question" problem the top bar was
          meant to solve, reintroduced. One surface owns them per screen. */}
      {activeSessionId ? (
        <>
          <WorkspaceChip workspacePath={workspacePath} compact />
          <BranchControl workspacePath={workspacePath} />
          <ActiveSessionControls sessionId={activeSessionId} />
        </>
      ) : (
        <div className="min-w-0 flex-1" />
      )}
    </header>
  )
}

/**
 * Session title plus the pane switches. Split out so the bar renders the same
 * height and gutters on the home screen, where there is no session to describe.
 */
function ActiveSessionControls({ sessionId }: { sessionId: string }): React.JSX.Element {
  const sessionName = useChatStore((s) => s.sessions[sessionId]?.meta?.sessionName)
  // pi never auto-titles, so fall back to the thread's own first prompt — the
  // same chain the sidebar uses (see lib/sessionTitle).
  const firstUserText = useChatStore((s) => {
    const first = s.sessions[sessionId]?.items.find((item) => item.kind === 'user')
    return first?.kind === 'user' ? first.text : undefined
  })
  const title = sessionTitle({ explicitName: sessionName, firstUserText })
  const naming = useNameTransition(sessionId)
  const rightPane = useLayoutStore((s) => sessionPanes(s, sessionId).pane)

  return (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span
          // See the sidebar row: re-keyed so the generated name animates in
          // rather than replacing the placeholder text in place.
          key={title ?? ''}
          title={naming.pending ? 'Naming this chat…' : undefined}
          className={clsx(
            'text-text truncate text-lg font-semibold',
            naming.pending && 'name-pending',
            naming.settled && 'name-enter',
          )}
        >
          {title ?? 'New session'}
        </span>
        <SwarmBadge sessionId={sessionId} />
      </div>
      {/* Reference order: terminal, files, changes, artifacts, subagents, kebab. */}
      <TerminalButton sessionId={sessionId} active={rightPane === 'terminal'} />
      <IconButton
        title={`Files pane (${formatShortcut('mod', 'shift', 'E')})`}
        active={rightPane === 'files'}
        onClick={() => useLayoutStore.getState().toggleRightPane('files', sessionId)}
      >
        <FileIcon />
      </IconButton>
      <IconButton
        title={`Changes pane (${formatShortcut('mod', 'shift', 'G')})`}
        active={rightPane === 'changes'}
        onClick={() => useLayoutStore.getState().toggleRightPane('changes', sessionId)}
      >
        <ChangesIcon />
      </IconButton>
      <ArtifactsButton sessionId={sessionId} active={rightPane === 'artifacts'} />
      <SubagentsButton sessionId={sessionId} active={rightPane === 'subagents'} />
      <SessionMenu sessionId={sessionId} />
    </>
  )
}

function SubagentsButton({
  sessionId,
  active,
}: {
  sessionId: string
  active: boolean
}): React.JSX.Element {
  const { entries, incomplete } = useCurrentWork(sessionId)
  const count = entries.reduce((sum, entry) => sum + entry.active, 0)
  const attention = entries.some((entry) => entry.active && entry.attention)
  const unknown = incomplete || entries.some((entry) => entry.state === 'status unavailable')
  return (
    <div className="relative">
      <IconButton
        title="Subagents pane"
        active={active}
        onClick={() => useLayoutStore.getState().toggleRightPane('subagents', sessionId)}
      >
        <BranchIcon size={16} />
      </IconButton>
      <CountBadge count={count} tone="accent" title={`${count} subagents active`} />
      {(attention || unknown) && (
        <span
          className="text-warning absolute -left-0.5 -top-1 text-xs"
          title={attention ? 'Needs parent attention' : 'Status unavailable'}
        >
          {attention ? '!' : '?'}
        </span>
      )}
    </div>
  )
}

/** Numeric badge anchored to a bar button's bottom-right corner. */
function CountBadge({
  count,
  tone = 'neutral',
  title,
}: {
  count: number
  tone?: 'neutral' | 'success' | 'accent'
  title?: string
}): React.JSX.Element | null {
  if (count === 0) return null
  return (
    <span
      title={title}
      className={clsx(
        'pointer-events-none absolute -bottom-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5 text-2xs font-bold',
        tone === 'success'
          ? 'bg-success/15 text-success'
          : tone === 'accent'
            ? 'bg-accent-soft text-accent'
            : 'bg-bg-secondary text-text-secondary',
      )}
    >
      {count > 9 ? '9+' : count}
    </span>
  )
}

function TerminalButton({
  sessionId,
  active,
}: {
  sessionId: string
  active: boolean
}): React.JSX.Element {
  const tabCount = useTerminalStore((s) => sessionTerminals(s, sessionId).tabs.length)
  const running = useTerminalStore((s) => runningCount(s, sessionId))

  return (
    <div className="relative">
      <IconButton
        title={`Terminal pane (${formatShortcut('mod', '`')})`}
        active={active}
        onClick={() => useLayoutStore.getState().toggleRightPane('terminal', sessionId)}
      >
        <TerminalIcon />
      </IconButton>
      <CountBadge
        count={tabCount}
        tone={running > 0 ? 'success' : 'neutral'}
        title={
          running > 0 ? `${running} running` : `${tabCount} terminal${tabCount > 1 ? 's' : ''}`
        }
      />
      {running > 0 && (
        <span
          className="bg-success absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full"
          title={`${running} process${running > 1 ? 'es' : ''} running`}
        />
      )}
    </div>
  )
}

function ArtifactsButton({
  sessionId,
  active,
}: {
  sessionId: string
  active: boolean
}): React.JSX.Element | null {
  const count = useArtifactsStore((s) => Object.keys(s.bySession[sessionId] ?? {}).length)
  const unseen = useArtifactsStore((s) => s.unseen[sessionId] ?? 0)
  if (count === 0) return null

  return (
    <div className="relative">
      <IconButton
        title="Artifacts pane"
        active={active}
        onClick={() => useLayoutStore.getState().toggleRightPane('artifacts', sessionId)}
      >
        <ArtifactsIcon />
      </IconButton>
      <CountBadge count={count} tone="accent" title={`${count} artifacts`} />
      {unseen > 0 && !active && (
        <span className="bg-accent absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full" />
      )}
    </div>
  )
}

function IconButton({
  title,
  active,
  onClick,
  children,
}: {
  title: string
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      title={title}
      onClick={onClick}
      className={clsx(
        'flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors',
        active
          ? 'bg-accent-soft text-accent'
          : 'text-text-tertiary hover:text-text hover:bg-bg-secondary',
      )}
    >
      {children}
    </button>
  )
}
