import { PopupMenu, MenuRow } from '@/components/PopupMenu'
import { ChoiceMenu } from '@/components/ChoiceMenu'
import { SearchIcon, MoreIcon, PlusIcon } from '@/components/icons'
import {
  LaneRow,
  WorkspaceGroupHeader,
  WorkspaceGroupTitle,
  SessionIndicator,
  SubtitleSegments,
} from './SidebarPrimitives'
import { MachineLabelLine } from './MachineSwitcher'
import { LaneSearchBar } from './LaneSearchBar'
import { laneMatches, laneQueryTerms } from './laneSearch'
import { relativeTimeShort } from '@/lib/time'
import { MachinePicker } from '@/features/machines/MachinePicker'
import { TooltipButton } from '@/components/Tooltip'
import { useEffect, useRef, useState } from 'react'
import { isLaneBranchName } from '@shared/host-protocol'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { Button, TextInput } from '@/components/form'
import { useMachinesStore } from '@/stores/machines'
import { useSessionsStore } from '@/stores/sessions'
import {
  REMOTE_NOT_READY,
  REMOTE_UNAVAILABLE,
  adoptRemoteLane,
  canReadHost,
  machineLabel,
  openRemoteLane,
  useRemoteLanesStore,
} from '@/stores/remoteLanes'

export function RemoteLanes(): React.JSX.Element | null {
  const hosts = useRemoteLanesStore((s) => s.hosts)
  const filter = useRemoteLanesStore((s) => s.filter)
  const enabled = useMachinesStore((s) => s.remoteEnabled)
  const machines = useMachinesStore((s) => s.machines)
  const error = useRemoteLanesStore((s) => s.error)
  const [creating, setCreating] = useState<{ hostId: string; repositoryId?: string } | null>(null)
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
                  onCreate={() => setCreating({ hostId: id, repositoryId: repo.id })}
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
      {creating && (
        <NewRemoteLane
          key={creating.hostId}
          hostId={creating.hostId}
          initialRepositoryId={creating.repositoryId}
          onMachine={(hostId) => setCreating(hostId ? { hostId } : null)}
          onClose={() => setCreating(null)}
        />
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
  const controlClass =
    'text-text-tertiary hover:text-text hover:bg-sidebar-hover flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-colors'
  return (
    <div>
      <WorkspaceGroupHeader>
        <WorkspaceGroupTitle
          name={name}
          collapsed={collapsed}
          onClick={() => setCollapsed(!collapsed)}
          liveCount={ready ? lanes.filter((l) => l.activity === 'working').length : 0}
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
            <LaneRow
              key={lane.laneId}
              disabled={!ready}
              tooltip={!ready ? REMOTE_NOT_READY : lane.title || 'Untitled lane'}
              aria-current={
                active?.target?.kind === 'remote' &&
                active.target.hostId === hostId &&
                active.laneId === lane.laneId
                  ? 'page'
                  : undefined
              }
              data-testid="remote-session-row"
              data-activity={ready && lane.activity === 'working' ? 'working' : undefined}
              className={
                active?.target?.kind === 'remote' &&
                active.target.hostId === hostId &&
                active.laneId === lane.laneId
                  ? 'bg-sidebar-active'
                  : 'hover:bg-sidebar-hover'
              }
              onClick={() => void openRemoteLane(hostId, lane.laneId)}
            >
              <SessionIndicator
                state={
                  ready && lane.activity === 'working'
                    ? 'streaming'
                    : lane.attention > lane.read
                      ? 'unseen'
                      : ready
                        ? 'live'
                        : 'disk'
                }
              />
              <span className="min-w-0 flex-1">
                <span className="text-text block truncate text-lg font-medium leading-5">
                  {lane.title || 'Untitled lane'}
                </span>
                <span className="text-text-secondary flex items-center gap-1 text-base leading-4">
                  <SubtitleSegments
                    segments={[
                      { key: 'time', text: relativeTimeShort(Date.parse(lane.updatedAt)) },
                      ...(lane.worktree ? [{ key: 'worktree' as const, text: 'wt' }] : []),
                      ...(lane.branch
                        ? [{ key: 'branch' as const, text: lane.branch, truncate: true }]
                        : []),
                    ]}
                    activity={ready && lane.activity === 'working' ? 'working' : undefined}
                  />
                  {(lane.activity === 'failed' || lane.activity === 'needs-input') && (
                    <span className="text-warning shrink-0">needs you</span>
                  )}
                </span>
              </span>
            </LaneRow>
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

export function NewRemoteLane({
  hostId,
  initialRepositoryId,
  onMachine,
  onClose,
}: {
  hostId: string
  initialRepositoryId?: string
  onMachine: (hostId: string | null) => void
  onClose: () => void
}): React.JSX.Element {
  const mounted = useRef(true)
  const navigation = useRef<number | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      const sessions = useSessionsStore.getState()
      if (navigation.current !== null && sessions.navSeq === navigation.current) sessions.claimNav()
    }
  }, [])
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const [repositoryId, setRepositoryId] = useState(
    initialRepositoryId ?? host?.repositories[0]?.id ?? '',
  )
  const [branch, setBranch] = useState('')
  const [name, setName] = useState('')
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function create(): Promise<void> {
    if (busy || host?.state !== 'ready' || !host.capabilities.includes('sessions.control')) return
    if (
      !host.repositories.some((repo) => repo.id === repositoryId) ||
      (branch && !isLaneBranchName(branch)) ||
      !!model !== !!provider
    ) {
      setError('Choose a repository, a valid branch, and both provider and model or neither.')
      return
    }
    setBusy(true)
    const nav = useSessionsStore.getState().claimNav()
    navigation.current = nav
    try {
      const info = await window.phosphor.invoke('hosts:createLane', hostId, {
        repositoryId,
        ...(branch ? { worktree: { branch } } : {}),
        ...(name ? { name } : {}),
        ...(model ? { model, provider } : {}),
      })
      if (!mounted.current) return
      await adoptRemoteLane(info, nav)
      if (mounted.current) onClose()
    } catch {
      setError('The Host could not confirm creation. Check the lane list before retrying.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <ModalOverlay onClose={onClose}>
      <ModalPanel
        width={420}
        title={`New lane on ${machineLabel(hostId)}`}
        subtitle="Start in a configured repository on this machine."
      >
        <form
          className="space-y-3 p-4"
          onSubmit={(event) => {
            event.preventDefault()
            void create()
          }}
        >
          <MachinePicker
            value={hostId}
            capability="sessions.control"
            onChange={(id) => {
              if (id === 'local') {
                useSessionsStore.getState().activate(null)
                onClose()
              } else onMachine(id)
            }}
          />
          {host?.state !== 'ready' && <p>Machine not connected. Wait for reconnection.</p>}
          <label className="text-text-secondary block text-sm">Repository</label>
          <ChoiceMenu
            label="Repository"
            value={repositoryId}
            choices={(host?.repositories ?? []).map((repo) => ({
              value: repo.id,
              label: repo.name,
            }))}
            onChange={setRepositoryId}
          >
            {host?.repositories.find((repo) => repo.id === repositoryId)?.name ??
              'Choose repository'}
          </ChoiceMenu>
          <TextInput
            aria-label="New branch (optional)"
            placeholder="New branch (optional)"
            className="w-full"
            maxLength={200}
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
          />
          <TextInput
            aria-label="Lane name (optional)"
            placeholder="Name (optional)"
            className="w-full"
            maxLength={200}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <TextInput
            aria-label="Provider (optional)"
            placeholder="Provider (optional)"
            className="w-full"
            maxLength={200}
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
          />
          <TextInput
            aria-label="Model (optional)"
            placeholder="Model (optional)"
            className="w-full"
            maxLength={200}
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
          {error && <p role="alert">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={
                busy ||
                !repositoryId ||
                host?.state !== 'ready' ||
                !host.capabilities.includes('sessions.control')
              }
            >
              Create lane
            </Button>
          </div>
        </form>
      </ModalPanel>
    </ModalOverlay>
  )
}
