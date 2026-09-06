import { memo } from 'react'
import clsx from 'clsx'
import { useLayoutStore, sessionPanes, type RightPane as RightPaneId } from '@/stores/layout'
import { PaneShell } from '@/components/PaneShell'
import { FilesPane } from './FilesPane'
import { FilesChangedPane } from './FilesChangedPane'
import { TerminalPane } from '@/features/terminal/TerminalPane'
import { ArtifactsPane } from '@/features/artifacts/ArtifactsPane'

/**
 * Inset IDE panel, hosting exactly one pane at a time inside a shared shell.
 */
export const RightPane = memo(function RightPane({
  workspacePath,
  sessionId,
}: {
  workspacePath: string
  sessionId: string
}): React.JSX.Element | null {
  // Read via `sessionId` rather than the active-session hook: this component
  // is already told which session it renders, and the two must not disagree.
  const rightPane = useLayoutStore((s) => sessionPanes(s, sessionId).pane)
  const side = useLayoutStore((s) => sessionPanes(s, sessionId).side)
  const expanded = useLayoutStore((s) => sessionPanes(s, sessionId).expanded)
  if (!rightPane) return null

  return (
    // Gutter + rounded card so the pane reads as a panel resting on the app
    // background rather than a flush column welded to the window edge. The
    // narrow gutter edge faces the chat; fullscreen gets an even inset.
    <div
      className={clsx(
        'h-full',
        expanded ? 'p-2' : side === 'left' ? 'py-2 pl-2 pr-1' : 'py-2 pl-1 pr-2',
      )}
    >
      <div
        data-testid="right-pane"
        className="border-border bg-surface flex h-full flex-col overflow-hidden rounded-md border"
      >
        {rightPane === 'files' && (
          <PaneShell title={<PaneSwitcher active="files" />}>
            <FilesPane workspacePath={workspacePath} />
          </PaneShell>
        )}
        {rightPane === 'changes' && (
          <PaneShell title={<PaneSwitcher active="changes" />}>
            <FilesChangedPane workspacePath={workspacePath} />
          </PaneShell>
        )}
        {rightPane === 'terminal' && (
          <TerminalPane sessionId={sessionId} workspacePath={workspacePath} />
        )}
        {rightPane === 'artifacts' && <ArtifactsPane workspacePath={workspacePath} />}
      </div>
    </div>
  )
})

/**
 * Files ⇄ Changes are two views of the same "working tree" surface, so they
 * keep a segmented switcher in the title slot. Terminal and Artifacts are
 * distinct panes and render a plain title instead.
 */
function PaneSwitcher({
  active,
}: {
  active: Extract<RightPaneId, 'files' | 'changes'>
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-0.5" role="group" aria-label="Pane">
      {(
        [
          { id: 'files', label: 'Files' },
          { id: 'changes', label: 'Changes' },
        ] as const
      ).map(({ id, label }) => (
        <button
          key={id}
          aria-pressed={active === id}
          onClick={() => useLayoutStore.getState().setRightPane(id)}
          className={clsx(
            'rounded-sm px-2 py-1 text-base font-medium transition-colors',
            active === id ? 'bg-bg-secondary text-text' : 'text-text-tertiary hover:text-text',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
