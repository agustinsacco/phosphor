import { useRef, useState } from 'react'
import { ChevronDownIcon } from '@/components/icons'
import { MenuRow, PopupMenu } from '@/components/PopupMenu'
import { TooltipButton } from '@/components/Tooltip'
import { HostFolderBrowser } from '@/features/machines/HostFolderBrowser'
import { projectName } from '@/lib/path'
import { machineLabel, useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useActiveWorkspace, useWorkspacesStore } from '@/stores/workspaces'

export function WorkspaceSwitcher(): React.JSX.Element {
  const currentPath = useActiveWorkspace()
  const remote = useSessionsStore((s) => {
    const entry = s.activeSessionId ? s.live[s.activeSessionId] : undefined
    return entry?.target?.kind === 'remote' ? entry : undefined
  })
  const remoteHost = useRemoteLanesStore((s) =>
    remote?.target?.kind === 'remote' ? s.hosts[remote.target.hostId] : undefined,
  )
  const [addingFolder, setAddingFolder] = useState(false)
  const remoteRepo = remoteHost?.repositories.find((repo) =>
    remoteHost.lanes.some(
      (lane) => lane.laneId === remote?.laneId && lane.repositoryId === repo.id,
    ),
  )
  const recents = useWorkspacesStore((s) => s.recents)
  const git = useSessionsStore((s) => (currentPath ? s.gitByCwd[currentPath] : undefined))
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // Project only, no branch: the top bar's folder and branch chips sit a row
  // above this and already answer "where am I". Showing `Phosphor (phosphor/hey-2)`
  // here as well put the branch on screen twice and the folder twice.
  const name =
    remote?.target?.kind === 'remote'
      ? `${remoteRepo?.name ?? 'Repository'} · ${machineLabel(remote.target.hostId)}`
      : currentPath
        ? projectName(currentPath, git)
        : 'Workspace'

  return (
    // Draggable: on Windows/Linux this row sits flush against the top of the
    // window (there is no traffic-light strip above it), so it is the only
    // grab handle the sidebar has. The trigger and the menu opt back out.
    <div className="titlebar-drag relative px-3 pb-1.5 pt-1">
      <TooltipButton
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        data-testid="workspace-switcher"
        tooltip="Switch workspace"
        className="hover:bg-sidebar-hover flex w-full items-center gap-2 rounded-md px-2 py-1 transition-colors"
      >
        <span className="bg-accent-soft text-accent flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-base font-bold uppercase">
          {name.slice(0, 1)}
        </span>
        <span className="min-w-0 flex-1 truncate text-left text-lg font-semibold">{name}</span>
        {!remote && <ChevronDownIcon className="text-text-tertiary shrink-0" />}
      </TooltipButton>

      {addingFolder && remote?.target?.kind === 'remote' && (
        <HostFolderBrowser
          key={remote.target.hostId}
          hostId={remote.target.hostId}
          onClose={() => setAddingFolder(false)}
        />
      )}
      {open && remote && (
        <PopupMenu
          onClose={() => setOpen(false)}
          triggerRef={triggerRef}
          className="absolute left-3 right-3 top-full z-40 mt-1 py-1.5"
        >
          <MenuRow
            active={false}
            disabled={
              remoteHost?.state !== 'ready' ||
              !remoteHost?.capabilities.includes('workspaces.write')
            }
            onClick={() => {
              setOpen(false)
              setAddingFolder(true)
            }}
          >
            Add folder on{' '}
            {remote.target?.kind === 'remote' ? machineLabel(remote.target.hostId) : 'machine'}…
          </MenuRow>
        </PopupMenu>
      )}
      {open && !remote && (
        <PopupMenu
          onClose={() => setOpen(false)}
          triggerRef={triggerRef}
          className="absolute left-3 right-3 top-full z-40 mt-1 py-1.5"
        >
          {recents.map((ws) => (
            <MenuRow
              key={ws.path}
              active={false}
              onClick={() => {
                setOpen(false)
                useWorkspacesStore.getState().openWorkspace(ws.path)
                useSessionsStore.getState().activate(null)
              }}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-lg font-medium">{ws.name}</span>
                <span className="text-text-tertiary block truncate text-sm">{ws.path}</span>
              </span>
              {ws.path === currentPath && <span className="bg-accent h-1.5 w-1.5 rounded-full" />}
            </MenuRow>
          ))}
          <div className="border-border my-1 border-t" />
          <MenuRow
            active={false}
            onClick={() => {
              setOpen(false)
              void useWorkspacesStore
                .getState()
                .pickAndOpen()
                .then((path) => {
                  // Leave the active session, or the derived workspace keeps
                  // returning that session's folder and the newly opened one
                  // never appears.
                  if (path) useSessionsStore.getState().activate(null)
                })
            }}
          >
            <span className="text-lg">Open Folder…</span>
          </MenuRow>
        </PopupMenu>
      )}
    </div>
  )
}
