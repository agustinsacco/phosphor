import { machineReachability } from '@/features/machines/machineReachability'
import type { MachineView } from '@shared/control-api'
import { isUnseen } from './unseen'
import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { HostConnectionView } from '@shared/ipc'
import { ChoiceMenu } from '@/components/ChoiceMenu'
import { MachinesIcon } from '@/components/icons'
import { PhosphorLoader } from '@/components/PhosphorLoader'
import { useMachinesStore } from '@/stores/machines'
import { usePlatform } from '@/platform/Platform'
import { hostReconnecting, useRemoteLanesStore, machineLabel } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useChatStore } from '@/stores/chat'
import { useExtensionUiStore } from '@/stores/extensionUi'

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
  const host = useRemoteLanesStore((s) => s.hosts[id])
  const machine = useMachinesStore((s) => s.machines.find((m) => m.id === id))
  const now = useMachinesStore((s) => s.nowMs)
  const loading = useRemoteLanesStore((s) => s.snapshotStatus === 'loading')
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
        {id === 'local' ? <LocalActivityText /> : machineStateText(host, machine, now, loading)}
      </div>
    </div>
  )
}
/** A Host on its way (or not yet in the first snapshot) is connecting, not unreachable. */
export function machineStateText(
  host: HostConnectionView | undefined,
  machine: MachineView | undefined,
  now: number,
  loading: boolean,
): string {
  return host?.state === 'ready'
    ? activityText(remoteActivity(host))
    : (host ? hostReconnecting(host.state) : loading)
      ? 'Connecting…'
      : machine
        ? machineReachability(machine, host?.state, now || Date.now()).short
        : 'Not reachable yet'
}

function LocalActivityText(): React.JSX.Element {
  return <>{activityText(useLocalMachineActivity())}</>
}

function useLocalMachineActivity(): MachineActivity {
  const live = useSessionsStore((s) => s.live)
  const disk = useSessionsStore((s) => s.disk)
  const seen = useSessionsStore((s) => s.seenSessions)
  const unread = useSessionsStore((s) => s.unread)
  const newPaths = useMemo(
    () =>
      new Set(
        Object.values(disk)
          .flat()
          .filter((meta) => isUnseen(seen, meta.path, meta.lastActivityAt))
          .map((meta) => meta.path),
      ),
    [disk, seen],
  )
  const newCount = useMemo(() => {
    const paths = new Set(newPaths)
    for (const [id, count] of Object.entries(unread)) {
      if (count && live[id]?.target?.kind !== 'remote') paths.add(live[id]?.diskPath ?? id)
    }
    return paths.size
  }, [newPaths, unread, live])
  const localIds = useMemo(
    () =>
      Object.values(live)
        .filter((entry) => entry.target?.kind !== 'remote')
        .map((entry) => entry.phosphorId),
    [live],
  )
  const dialogIds = useExtensionUiStore(
    useShallow((s) => localIds.filter((id) => s.dialogs.some((d) => d.sessionId === id))),
  )
  const [running, needsYou] = useChatStore(
    useShallow(
      (s) =>
        [
          localIds.filter((id) => s.sessions[id]?.isStreaming === true).length,
          localIds.filter((id) => !!s.sessions[id]?.error || dialogIds.includes(id)).length,
        ] as const,
    ),
  )
  return { running, new: newCount, needsYou }
}

/** Chooses the lane scope: a machine id, `local` or `all`. */
export type MachineScopeChange = (scope: string) => void
const setFilter: MachineScopeChange = (scope) => useRemoteLanesStore.getState().setFilter(scope)

/**
 * The only machine-scope control. It shows `useRemoteLanesStore.filter`;
 * `onScope` lets a shell keep the scope elsewhere (the browser's URL) and
 * project it back into the filter.
 */
export function MachineSwitcher({
  onScope = setFilter,
}: {
  onScope?: MachineScopeChange
}): React.JSX.Element | null {
  const enabled = useMachinesStore((s) => s.remoteEnabled)
  return enabled ? <EnabledMachineSwitcher onScope={onScope} /> : null
}

/** Activity per machine, local included, keyed like the filter. */
function useMachineActivity(): { ids: string[]; activity: Record<string, MachineActivity> } {
  const machines = useMachinesStore((s) => s.machines)
  const hosts = useRemoteLanesStore((s) => s.hosts)
  const local = useLocalMachineActivity()
  const ids = [...new Set([...machines.map((m) => m.id), ...Object.keys(hosts)])]
  return {
    ids,
    activity: {
      local,
      ...Object.fromEntries(ids.map((id) => [id, remoteActivity(hosts[id])])),
    },
  }
}

/**
 * What is happening on the machines the sidebar is NOT showing. It sits on the
 * Machines nav row, not on the scope control: there it read as the selected
 * machine's own counts. Visible text, not a hover-only hint, so it reads the
 * same on a touch screen.
 */
export function OtherMachinesActivity(): React.JSX.Element | null {
  const enabled = useMachinesStore((s) => s.remoteEnabled)
  return enabled ? <EnabledOtherMachinesActivity /> : null
}

function EnabledOtherMachinesActivity(): React.JSX.Element | null {
  const selected = useRemoteLanesStore((s) => s.filter)
  const others = otherMachineActivity(useMachineActivity().activity, selected)
  if (!others.running && !others.new && !others.needsYou) return null
  return (
    <span
      aria-label="Activity on other machines"
      data-tooltip={`Other machines: ${[others.running && `${others.running} running`, others.new && `${others.new} new`, others.needsYou && `${others.needsYou} need you`].filter(Boolean).join(' · ')}`}
      className="ml-auto flex shrink-0 items-center gap-2 text-xs tabular-nums"
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
  )
}

/**
 * The sidebar's lane scope: which machine's lanes the list below shows. It is
 * a picker, not a page link, so it must not look like the nav rows above it —
 * a divider and a "Lanes on" caption, a bordered field, a status dot rather than
 * the Machines icon, and the state spelled out (not colour alone).
 */
function EnabledMachineSwitcher({ onScope }: { onScope: MachineScopeChange }): React.JSX.Element {
  const { localLanes } = usePlatform()
  const machines = useMachinesStore((s) => s.machines)
  const now = useMachinesStore((s) => s.nowMs)
  const hosts = useRemoteLanesStore((s) => s.hosts)
  const loading = useRemoteLanesStore((s) => s.snapshotStatus === 'loading')
  const selected = useRemoteLanesStore((s) => s.filter)
  const { ids, activity } = useMachineActivity()
  const aggregate = otherMachineActivity(activity, '')
  const detailFor = (id: string): string =>
    id === 'local'
      ? activityText(activity.local!)
      : id === 'all'
        ? activityText(aggregate)
        : machineStateText(
            hosts[id],
            machines.find((m) => m.id === id),
            now,
            loading,
          )
  const row = (id: string): React.ReactNode => {
    const state = id === 'local' ? 'ready' : hosts[id]?.state
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
          <span className="text-text-tertiary block truncate text-sm">{detailFor(id)}</span>
        </span>
      </span>
    )
  }
  return (
    <div className="border-border mx-2 mb-1 mt-0.5 shrink-0 border-t pt-2.5">
      <div
        aria-hidden="true"
        className="text-text-tertiary px-1 pb-1 text-xs font-medium uppercase tracking-wider"
      >
        Lanes on
      </div>
      <ChoiceMenu
        value={selected}
        label="Machine filter"
        triggerClassName="border-border bg-surface hover:border-border-strong text-text flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-base transition-colors pointer-coarse:min-h-11"
        header={
          <div className="text-text-tertiary flex justify-between px-3 py-2 text-xs">
            <span className="font-semibold uppercase tracking-wider">Machines</span>
            <span>{ids.length + Number(localLanes)} total</span>
          </div>
        }
        choices={[
          ...(localLanes ? [{ value: 'local', label: row('local') }] : []),
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
          } else onScope(id)
        }}
      >
        {selected === 'all' ? (
          <span
            aria-hidden="true"
            className="border-text-tertiary size-2 shrink-0 rounded-full border"
          />
        ) : (
          <MachineDot state={selected === 'local' ? 'ready' : hosts[selected]?.state} />
        )}
        <span className="min-w-0 truncate font-medium">
          {selected === 'local'
            ? 'This Mac'
            : selected === 'all'
              ? 'All machines'
              : machineLabel(selected)}
        </span>
        <span
          data-testid="machine-filter-state"
          className="text-text-tertiary ml-auto min-w-0 shrink-[3] truncate text-xs"
        >
          {detailFor(selected)}
        </span>
      </ChoiceMenu>
    </div>
  )
}
