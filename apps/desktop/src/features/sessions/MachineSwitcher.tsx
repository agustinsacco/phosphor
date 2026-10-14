import { isUnseen } from './unseen'
import { useEffect } from 'react'
import type { HostConnectionView } from '@shared/ipc'
import { ChoiceMenu } from '@/components/ChoiceMenu'
import { MachinesIcon } from '@/components/icons'
import { PhosphorLoader } from '@/components/PhosphorLoader'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore, machineLabel } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useChatStore } from '@/stores/chat'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { relativeTime } from '@/features/machines/machinePresentation'

export interface MachineActivity {
  running: number
  new: number
  needsYou: number
}
const emptyActivity = (): MachineActivity => ({ running: 0, new: 0, needsYou: 0 })
export function remoteActivity(host?: HostConnectionView): MachineActivity {
  const counts = emptyActivity()
  for (const lane of host?.lanes ?? []) {
    counts.running += Number(lane.activity === 'working')
    counts.new += Number(lane.attention > lane.read)
    counts.needsYou += Number(lane.activity === 'needs-input' || lane.activity === 'failed')
  }
  return counts
}
export function otherMachineActivity(
  activity: Record<string, MachineActivity>,
  selected: string,
): MachineActivity {
  const total = emptyActivity()
  if (selected === 'all') return total
  for (const [id, counts] of Object.entries(activity)) {
    if (id === selected) continue
    total.running += counts.running
    total.new += counts.new
    total.needsYou += counts.needsYou
  }
  return total
}
export function MachineGlyph({ local = false }: { local?: boolean }): React.JSX.Element {
  return local ? (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
    >
      <rect x="3" y="2" width="10" height="8" rx="1" stroke="currentColor" />
      <path d="M1 12h14l-1 2H2l-1-2Z" stroke="currentColor" />
    </svg>
  ) : (
    <MachinesIcon size={15} />
  )
}
export function MachineDot({ state }: { state?: HostConnectionView['state'] }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={`size-2 shrink-0 rounded-full ${state === 'ready' ? 'bg-success' : state === 'connecting' || state === 'reconnecting' ? 'bg-warning animate-pulse' : !state || state === 'no-address' ? 'bg-info' : 'bg-text-tertiary'}`}
    />
  )
}
export function activityText(counts: MachineActivity): string {
  return (
    [
      counts.running && `${counts.running} running`,
      counts.new && `${counts.new} new`,
      counts.needsYou && `${counts.needsYou} needs you`,
    ]
      .filter(Boolean)
      .join(' · ') || 'Idle'
  )
}
export function MachineLabelLine({ id }: { id: string }): React.JSX.Element {
  const local = useLocalMachineActivity()
  const host = useRemoteLanesStore((s) => s.hosts[id])
  const machine = useMachinesStore((s) => s.machines.find((m) => m.id === id))
  const now = useMachinesStore((s) => s.nowMs)
  return (
    <div className="border-border mt-4 border-t px-2 pt-3">
      <div className="text-text-secondary flex items-center gap-2 text-sm font-medium">
        <MachineGlyph local={id === 'local'} />
        <span className="min-w-0 flex-1 truncate">
          {id === 'local' ? 'This Mac' : machineLabel(id)}
        </span>
        <MachineDot state={id === 'local' ? 'ready' : host?.state} />
      </div>
      <div className="text-text-tertiary mt-1 text-xs">
        {id === 'local' ? activityText(local) : machineStateText(host, machine?.lastSeenAt, now)}
      </div>
    </div>
  )
}
function machineStateText(
  host: HostConnectionView | undefined,
  lastSeenAt: string | null | undefined,
  now: number,
): string {
  const state = host?.state
  return state === 'ready'
    ? activityText(remoteActivity(host))
    : state === 'connecting' || state === 'reconnecting'
      ? 'Reconnecting…'
      : !state || state === 'no-address'
        ? 'Setting up…'
        : `Down${lastSeenAt ? ` · seen ${relativeTime(lastSeenAt, now || Date.now())}` : ''}`
}

function useLocalMachineActivity(): MachineActivity {
  const live = useSessionsStore((s) => s.live)
  const disk = useSessionsStore((s) => s.disk)
  const seen = useSessionsStore((s) => s.seenSessions)
  const unread = useSessionsStore((s) => s.unread)
  const chats = useChatStore((s) => s.sessions)
  const dialogs = useExtensionUiStore((s) => s.dialogs)
  const local = emptyActivity()
  const newPaths = new Set(
    Object.values(disk)
      .flat()
      .filter((meta) => isUnseen(seen, meta.path, meta.lastActivityAt))
      .map((meta) => meta.path),
  )
  for (const [id, count] of Object.entries(unread)) {
    if (count && live[id]?.target?.kind !== 'remote') newPaths.add(live[id]?.diskPath ?? id)
  }
  local.new = newPaths.size
  for (const entry of Object.values(live)) {
    if (entry.target?.kind === 'remote') continue
    const chat = chats[entry.phosphorId]
    local.running += Number(chat?.isStreaming === true)
    local.needsYou += Number(!!chat?.error || dialogs.some((d) => d.sessionId === entry.phosphorId))
  }
  return local
}

export function MachineSwitcher(): React.JSX.Element | null {
  const enabled = useMachinesStore((s) => s.remoteEnabled)
  const machines = useMachinesStore((s) => s.machines)
  const now = useMachinesStore((s) => s.nowMs)
  const hosts = useRemoteLanesStore((s) => s.hosts)
  const selected = useRemoteLanesStore((s) => s.filter)
  const local = useLocalMachineActivity()
  useEffect(() => {
    useRemoteLanesStore.getState().setFilter('local')
  }, [])
  useEffect(() => {
    if (!enabled) useRemoteLanesStore.getState().setFilter('local')
  }, [enabled])
  if (!enabled) return null
  const ids = [...new Set([...machines.map((m) => m.id), ...Object.keys(hosts)])]
  const activity: Record<string, MachineActivity> = {
    local,
    ...Object.fromEntries(ids.map((id) => [id, remoteActivity(hosts[id])])),
  }
  const others = otherMachineActivity(activity, selected)
  const aggregate = otherMachineActivity(activity, '')
  const row = (id: string): React.ReactNode => {
    const host = hosts[id]
    const machine = machines.find((m) => m.id === id)
    const state = id === 'local' ? 'ready' : host?.state
    const detail =
      id === 'local' ? activityText(local) : machineStateText(host, machine?.lastSeenAt, now)
    return (
      <span className="flex items-start gap-2.5">
        <span className="text-text-tertiary pt-1">
          <MachineGlyph local={id === 'local'} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <MachineDot state={state} />
            <span className="truncate font-medium">
              {id === 'local' ? 'This Mac' : machineLabel(id)}
            </span>
          </span>
          <span className="text-text-tertiary block truncate text-sm">{detail}</span>
        </span>
      </span>
    )
  }
  return (
    <div className="h-10 shrink-0 px-2 pb-1 pt-1">
      <ChoiceMenu
        value={selected}
        label="Machine filter"
        triggerClassName="text-text group flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1 text-left text-lg transition-colors hover:bg-sidebar-hover"
        header={
          <div className="text-text-tertiary flex justify-between px-3 py-2 text-xs">
            <span className="font-semibold uppercase tracking-wider">Machines</span>
            <span>{ids.length + 1} total</span>
          </div>
        }
        choices={[
          { value: 'local', label: row('local') },
          ...ids.map((id) => ({ value: id, label: row(id) })),
          {
            value: 'all',
            label: (
              <span className="border-border flex flex-col border-t pt-2">
                <span>All machines</span>
                <span className="text-text-tertiary text-sm">{activityText(aggregate)}</span>
              </span>
            ),
          },
          { value: 'add', label: <span className="text-accent">+ Add machine</span> },
        ]}
        onChange={(id) => {
          if (id === 'add') {
            useMachinesStore.getState().show({ kind: 'list' })
            useMachinesStore.setState({ adding: true })
          } else useRemoteLanesStore.getState().setFilter(id)
        }}
      >
        <span className="text-text-secondary group-hover:text-text flex size-[22px] shrink-0 items-center justify-center">
          <MachineGlyph local={selected === 'local'} />
        </span>
        <span className="min-w-0 flex-1 truncate">
          {selected === 'local'
            ? 'This Mac'
            : selected === 'all'
              ? 'All machines'
              : machineLabel(selected)}
        </span>
        {!!(others.running || others.new || others.needsYou) && (
          <span
            aria-label="Activity on other machines"
            data-tooltip={`Other machines: ${[others.running && `${others.running} running`, others.new && `${others.new} new`, others.needsYou && `${others.needsYou} need you`].filter(Boolean).join(' · ')}`}
            className="flex shrink-0 items-center gap-2 text-xs tabular-nums"
          >
            {!!others.running && (
              <span
                aria-label={`${others.running} running`}
                className="text-accent flex items-center gap-1"
              >
                <PhosphorLoader size={12} decorative />
                {others.running}
              </span>
            )}
            {!!others.new && (
              <span
                aria-label={`${others.new} new`}
                className="bg-accent-soft text-accent rounded px-1 py-px"
              >
                {others.new} new
              </span>
            )}
            {!!others.needsYou && (
              <span
                className="text-warning flex items-center gap-1"
                aria-label={`${others.needsYou} need you`}
              >
                <span className="bg-warning size-1.5 rounded-full" />
                {others.needsYou}
              </span>
            )}
          </span>
        )}
      </ChoiceMenu>
    </div>
  )
}
