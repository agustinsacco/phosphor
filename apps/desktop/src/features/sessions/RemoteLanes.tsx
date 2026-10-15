import { hostGroupKey, useLaneReveal } from './laneReveal'
import { openRemoteComposer } from '@/features/home/remoteComposer'
import { HostFolderBrowser } from '@/features/machines/HostFolderBrowser'
import { RemoteLaneRow } from './RemoteLaneRow'
import { PopupMenu, MenuRow } from '@/components/PopupMenu'
import { SearchIcon, MoreIcon, PlusIcon } from '@/components/icons'
import { WorkspaceGroupHeader, WorkspaceGroupTitle } from './SidebarPrimitives'
import { MachineLabelLine } from './MachineSwitcher'
import { LaneSearchBar } from './LaneSearchBar'
import { laneMatches, laneQueryTerms } from './laneSearch'
import { TooltipButton } from '@/components/Tooltip'
import { useRef, useState } from 'react'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { Button } from '@/components/form'
import { useMachinesStore } from '@/stores/machines'
import { useSessionsStore } from '@/stores/sessions'
import {
  REMOTE_NOT_READY,
  REMOTE_UNAVAILABLE,
  canReadHost,
  machineLabel,
  useRemoteLanesStore,
} from '@/stores/remoteLanes'

/** Mirrors the main process's last-repository refusal (electron/hosts/repository-management.ts). */
export const LAST_FOLDER_REFUSAL = 'A machine needs at least one folder. Add another first.'

export function RemoteLanes(): React.JSX.Element | null {
  const hosts = useRemoteLanesStore((s) => s.hosts)
  const filter = useRemoteLanesStore((s) => s.filter)
  const enabled = useMachinesStore((s) => s.remoteEnabled)
  const machines = useMachinesStore((s) => s.machines)
  const error = useRemoteLanesStore((s) => s.error)
  if (!enabled || filter === 'local') return null
  const ids =
    filter === 'all'
      ? [...new Set([...machines.map((m) => m.id), ...Object.keys(hosts)])]
      : [filter]
  return (
    <>
      {ids
        .filter((id) => !hosts[id] || hosts[id]?.state === 'no-address' || canReadHost(hosts[id]!))
        .map((id) => (
          <section key={id} aria-label={machineLabel(id)}>
            {filter === 'all' && <MachineLabelLine id={id} />}
            {hosts[id]?.state !== 'no-address' && hosts[id]?.repositories.length ? (
              hosts[id].repositories.map((repo) => (
                <RemoteRepositoryGroup
                  key={repo.id}
                  hostId={id}
                  repositoryId={repo.id}
                  name={repo.name}
                  onCreate={() => openRemoteComposer(id, repo.id)}
                />
              ))
            ) : (
              <div className="text-text-tertiary px-2 py-3 text-sm">
                {!hosts[id] || hosts[id].state === 'no-address'
                  ? 'Setting up…'
                  : hosts[id].state === 'ready'
                    ? 'No repositories configured'
                    : REMOTE_NOT_READY}
              </div>
            )}
          </section>
        ))}
      {error && (
        <p className="text-danger px-2 py-2 text-sm" role="alert">
          {error}
        </p>
      )}
    </>
  )
}

function RemoteRepositoryGroup({
  hostId,
  repositoryId,
  name,
  onCreate,
}: {
  hostId: string
  repositoryId: string
  name: string
  onCreate: () => void
}): React.JSX.Element {
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const active = useSessionsStore((s) =>
    s.activeSessionId ? s.live[s.activeSessionId] : undefined,
  )
  const [collapsed, setCollapsed] = useState(false)
  const [searching, setSearching] = useState(false)
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState(false)
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [removeBusy, setRemoveBusy] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const readable = !!host && canReadHost(host)
  const ready = readable && host.state === 'ready'
  const lanes = readable ? host.lanes.filter((lane) => lane.repositoryId === repositoryId) : []
  const terms = laneQueryTerms(query)
  const visible = lanes.filter((lane) =>
    laneMatches(`${lane.title ?? ''} ${lane.branch ?? ''}`.toLowerCase(), terms),
  )
  const clear = (): void => {
    setSearching(false)
    setDraft('')
    setQuery('')
  }
  useLaneReveal(hostGroupKey(hostId, repositoryId), () => {
    setCollapsed(false)
    clear()
  })
  const controlClass =
    'text-text-tertiary hover:text-text hover:bg-sidebar-hover flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-colors'
  return (
    <div>
      {adding && <HostFolderBrowser hostId={hostId} onClose={() => setAdding(false)} />}
      {removing && (
        <ModalOverlay
          onClose={() => {
            if (!removeBusy) setRemoving(false)
          }}
        >
          <ModalPanel title={`Remove from ${machineLabel(hostId)}?`} width={420}>
            <div className="space-y-4 p-4">
              <p>{name}: files are kept. A repository with a live lane cannot be removed.</p>
              {removeError && (
                <p role="alert" className="text-danger">
                  {removeError}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button disabled={removeBusy} onClick={() => setRemoving(false)}>
                  Cancel
                </Button>
                <Button
                  disabled={
                    removeBusy || !ready || !host?.capabilities.includes('workspaces.write')
                  }
                  onClick={() => {
                    setRemoveBusy(true)
                    void window.phosphor
                      .invoke('hosts:removeRepository', hostId, repositoryId)
                      .then(() => setRemoving(false))
                      .catch((error: unknown) =>
                        setRemoveError(
                          // Only the fixed last-folder refusal is shown verbatim; anything
                          // else keeps the generic text rather than echoing error details.
                          error instanceof Error && error.message.includes(LAST_FOLDER_REFUSAL)
                            ? LAST_FOLDER_REFUSAL
                            : 'The Host could not remove this folder. Stop its lanes before retrying.',
                        ),
                      )
                      .finally(() => setRemoveBusy(false))
                  }}
                >
                  Remove folder
                </Button>
              </div>
            </div>
          </ModalPanel>
        </ModalOverlay>
      )}
      <WorkspaceGroupHeader>
        <WorkspaceGroupTitle
          name={name}
          collapsed={collapsed}
          onClick={() => setCollapsed(!collapsed)}
        >
          {!ready && (
            <span className="text-text-tertiary shrink-0 rounded bg-chip px-1 text-2xs font-normal normal-case tracking-normal">
              last known
            </span>
          )}
        </WorkspaceGroupTitle>
        <TooltipButton
          className={controlClass}
          aria-label={`Search lanes in ${name}`}
          aria-expanded={searching}
          title="Search lanes"
          onClick={() => {
            if (searching) clear()
            else {
              setSearching(true)
              setCollapsed(false)
            }
          }}
        >
          <SearchIcon size={12} />
        </TooltipButton>
        <TooltipButton
          ref={trigger}
          className={controlClass}
          aria-label={`Workspace options for ${name}`}
          title="Workspace options"
          onClick={() => setMenu(!menu)}
        >
          <MoreIcon size={14} />
        </TooltipButton>
        {menu && (
          <PopupMenu
            triggerRef={trigger}
            onClose={() => setMenu(false)}
            className="absolute right-1 top-full z-40 mt-1 min-w-36 py-1"
          >
            <MenuRow
              active={false}
              disabled={!ready || !host?.capabilities.includes('workspaces.write')}
              onClick={() => {
                setMenu(false)
                setAdding(true)
              }}
            >
              Add folder on {machineLabel(hostId)}…
            </MenuRow>
            <MenuRow
              active={false}
              disabled={!ready || !host?.capabilities.includes('workspaces.write')}
              onClick={() => {
                setMenu(false)
                setRemoving(true)
              }}
            >
              Remove from {machineLabel(hostId)}
            </MenuRow>
            <MenuRow
              active={false}
              onClick={() => {
                setCollapsed(!collapsed)
                setMenu(false)
              }}
            >
              {collapsed ? 'Expand' : 'Collapse'} lanes
            </MenuRow>
          </PopupMenu>
        )}
        <TooltipButton
          className={controlClass}
          aria-label={`New lane in ${name}`}
          title={
            !ready
              ? REMOTE_NOT_READY
              : !host.capabilities.includes('sessions.control')
                ? REMOTE_UNAVAILABLE
                : 'New session here'
          }
          disabled={!ready || !host.capabilities.includes('sessions.control')}
          onClick={onCreate}
        >
          <PlusIcon size={12} strokeWidth={2.5} />
        </TooltipButton>
      </WorkspaceGroupHeader>
      {searching && (
        <LaneSearchBar
          value={draft}
          applied={!!query}
          matchCount={visible.length}
          total={lanes.length}
          onChange={setDraft}
          onCommit={() => setQuery(draft)}
          onClear={clear}
        />
      )}
      {!collapsed && (
        <div className={!ready ? 'opacity-50' : undefined}>
          {visible.map((lane) => (
            <RemoteLaneRow
              key={lane.laneId}
              hostId={hostId}
              lane={lane}
              ready={ready}
              active={
                active?.target?.kind === 'remote' &&
                active.target.hostId === hostId &&
                active.laneId === lane.laneId
              }
            />
          ))}
          {!visible.length && (
            <p className="text-text-tertiary px-2 py-2 text-sm">
              {query ? `No lanes match “${query}”` : 'No lanes yet'}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
