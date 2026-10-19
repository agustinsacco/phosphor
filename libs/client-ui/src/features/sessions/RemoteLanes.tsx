import { groupRemoteLanes, type RemoteLaneGroup } from './groupRemoteLanes'
import { machineReachability } from '@/features/machines/machineReachability'
import { remoteLaneGroupKey, useLaneReveal } from './laneReveal'
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
import { RemoteRepositoryRemoval } from './RemoteRepositoryRemoval'
export { LAST_FOLDER_REFUSAL } from './RemoteRepositoryRemoval'
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

export function RemoteLanes(): React.JSX.Element | null {
  const hosts = useRemoteLanesStore((s) => s.hosts)
  const filter = useRemoteLanesStore((s) => s.filter)
  const enabled = useMachinesStore((s) => s.remoteEnabled)
  const machines = useMachinesStore((s) => s.machines)
  const now = useMachinesStore((s) => s.nowMs + s.clockOffsetMs)
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
            {hosts[id]?.state === 'ready' &&
            !hosts[id].repositories.length &&
            !hosts[id].lanes.length ? (
              <NoFolders hostId={id} />
            ) : hosts[id]?.state !== 'no-address' && hosts[id] && canReadHost(hosts[id]) ? (
              groupRemoteLanes(hosts[id].repositories, hosts[id].lanes).map((group) => (
                <RemoteRepositoryGroup
                  key={group.repositoryId}
                  hostId={id}
                  group={group}
                  onCreate={() => openRemoteComposer(id, group.repositoryId)}
                />
              ))
            ) : (
              <div className="text-text-tertiary px-2 py-3 text-sm">
                {!hosts[id] || hosts[id].state === 'no-address'
                  ? (() => {
                      const machine = machines.find((m) => m.id === id)
                      return machine
                        ? machineReachability(machine, hosts[id]?.state, now || Date.now()).short
                        : 'Not reachable yet'
                    })()
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

/** A ready Host with no folders: the one next step is adding one, so offer it right here. */
function NoFolders({ hostId }: { hostId: string }): React.JSX.Element {
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const [adding, setAdding] = useState(false)
  const writable = !!host?.capabilities.includes('workspaces.write')
  return (
    <div className="text-text-tertiary flex flex-col items-start gap-2 px-2 py-3 text-sm">
      <span>No folders yet</span>
      {writable && (
        <Button size="xs" onClick={() => setAdding(true)}>
          Add folder on {machineLabel(hostId)}…
        </Button>
      )}
      {adding && <HostFolderBrowser hostId={hostId} onClose={() => setAdding(false)} />}
    </div>
  )
}

function RemoteRepositoryGroup({
  hostId,
  group,
  onCreate,
}: {
  hostId: string
  group: RemoteLaneGroup
  onCreate: () => void
}): React.JSX.Element {
  const { repositoryId, name, available, lanes } = group
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
  const trigger = useRef<HTMLButtonElement>(null)
  const readable = !!host && canReadHost(host)
  const ready = readable && host.state === 'ready'
  const terms = laneQueryTerms(query)
  const visible = lanes.filter((lane) =>
    laneMatches(`${lane.title ?? ''} ${lane.branch ?? ''}`.toLowerCase(), terms),
  )
  const clear = (): void => {
    setSearching(false)
    setDraft('')
    setQuery('')
  }
  useLaneReveal(remoteLaneGroupKey(hostId, repositoryId), () => {
    setCollapsed(false)
    clear()
  })
  const controlClass =
    'text-text-tertiary hover:text-text hover:bg-sidebar-hover flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-colors'
  return (
    <div>
      {adding && <HostFolderBrowser hostId={hostId} onClose={() => setAdding(false)} />}
      {removing && (
        <RemoteRepositoryRemoval
          hostId={hostId}
          repositoryId={repositoryId}
          name={name}
          onClose={() => setRemoving(false)}
        />
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
        {available && (
          <>
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
          </>
        )}
      </WorkspaceGroupHeader>
      {!available && (
        <p className="text-text-tertiary px-2 py-1 text-sm">Not in this Host’s current folders.</p>
      )}
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
