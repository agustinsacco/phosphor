import { useSessionsStore } from '@/stores/sessions'
import { REMOTE_UNAVAILABLE, REMOTE_NOT_READY, useRemoteLanesStore } from '@/stores/remoteLanes'
import { MachineChip } from '@/features/machines/RemoteLaneControls'
import { TooltipButton } from '@/components/Tooltip'
import { memo } from 'react'
import clsx from 'clsx'
import { useLayoutStore, sessionPanes, type RightPane as RightPaneId } from '@/stores/layout'
import { PaneShell, PaneTitle } from '@/components/PaneShell'
import { FilesPane } from './FilesPane'
import { RemoteFilesPane } from './RemoteFilesPane'
import { FilesChangedPane } from './FilesChangedPane'
import { TerminalPane } from '@/features/terminal/TerminalPane'
import { RemoteArtifactsPane } from '@/features/artifacts/RemoteArtifactsPane'
import { ArtifactsPane } from '@/features/artifacts/ArtifactsPane'
import { SubagentPanel } from '@/features/chat/SubagentPanel'

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
  const target = useSessionsStore((s) => s.live[sessionId]?.target)
  const remote = target?.kind === 'remote'
  const host = useRemoteLanesStore((s) =>
    target?.kind === 'remote' ? s.hosts[target.hostId] : undefined,
  )
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
        {remote && (
          // Same card and headers as This Mac. Terminal and Artifacts bring their own
          // header; Files/Changes and the fixed refusals add the machine chip.
          <RemotePaneBody
            pane={rightPane}
            sessionId={sessionId}
            workspacePath={workspacePath}
            ready={host?.state === 'ready'}
            known={!!host}
            terminal={!!host?.capabilities.includes('terminal')}
          />
        )}
        {!remote && rightPane === 'files' && (
          <PaneShell title={<PaneSwitcher active="files" />}>
            <FilesPane workspacePath={workspacePath} />
          </PaneShell>
        )}
        {!remote && rightPane === 'changes' && (
          <PaneShell title={<PaneSwitcher active="changes" />}>
            <FilesChangedPane workspacePath={workspacePath} />
          </PaneShell>
        )}
        {!remote && rightPane === 'terminal' && (
          <TerminalPane sessionId={sessionId} workspacePath={workspacePath} />
        )}
        {!remote && rightPane === 'artifacts' && (
          <ArtifactsPane sessionId={sessionId} workspacePath={workspacePath} />
        )}
        {!remote && rightPane === 'subagents' && <SubagentPanel sessionId={sessionId} />}
      </div>
    </div>
  )
})

function RemotePaneBody({
  pane,
  sessionId,
  workspacePath,
  ready,
  known,
  terminal,
}: {
  pane: NonNullable<RightPaneId>
  sessionId: string
  workspacePath: string
  ready: boolean
  known: boolean
  terminal: boolean
}): React.JSX.Element {
  if (pane === 'files' || pane === 'changes')
    return (
      <PaneShell
        title={
          <>
            <PaneSwitcher active={pane} />
            <MachineChip sessionId={sessionId} />
          </>
        }
      >
        <RemoteFilesPane
          key={sessionId}
          workspacePath={workspacePath}
          sessionId={sessionId}
          changes={pane === 'changes'}
        />
      </PaneShell>
    )
  if (ready && pane === 'artifacts')
    return <RemoteArtifactsPane sessionId={sessionId} workspacePath={workspacePath} />
  if (ready && pane === 'terminal' && terminal)
    return <TerminalPane sessionId={sessionId} workspacePath={workspacePath} />
  const label = { terminal: 'Terminal', artifacts: 'Artifacts', subagents: 'Subagents' }[pane]
  return (
    <PaneShell
      title={
        <>
          <PaneTitle label={label} />
          <MachineChip sessionId={sessionId} />
        </>
      }
    >
      <p className="p-4">{known && !ready ? REMOTE_NOT_READY : REMOTE_UNAVAILABLE}</p>
    </PaneShell>
  )
}

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
    <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label="Pane">
      {(
        [
          { id: 'files', label: 'Files' },
          { id: 'changes', label: 'Changes' },
        ] as const
      ).map(({ id, label }) => (
        <TooltipButton
          key={id}
          aria-pressed={active === id}
          onClick={() => useLayoutStore.getState().setRightPane(id)}
          className={clsx(
            'min-h-8 rounded-sm px-2 py-1 text-base font-medium transition-colors focus-visible:-outline-offset-2',
            active === id ? 'bg-bg-secondary text-text' : 'text-text-secondary hover:text-text',
          )}
        >
          {label}
        </TooltipButton>
      ))}
    </div>
  )
}
