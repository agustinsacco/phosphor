import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { TooltipButton } from '@/components/Tooltip'
import { useOpenSettings } from '@/features/settings/useOpenSettings'
import { usePlatform } from '@/platform/Platform'
import { EMPTY_MACHINE_UPDATE, useMachineUpdatesStore } from '@/stores/machineUpdates'
import { useMachinesStore } from '@/stores/machines'
import { machineLabel, useRemoteLanesStore } from '@/stores/remoteLanes'
import type { HostsSnapshot } from '@shared/ipc'
import { deriveMachineUpdate, type MachineUpdateEntry } from './machineUpdateState'
import { useUpdatesStore } from './updatesStore'
import {
  actionable,
  appUpdateRow,
  availableShows,
  EMPTY_FOOTER,
  footerMachineId,
  machineUpdateRow,
  rowExpiresAt,
  sameRow,
  settleSlot,
  START_DELAY_MS,
  type FooterState,
  type UpdateRowView,
} from './updatesFooterRows'

/**
 * The machine row's target before dwell and collapse: the run or the machine
 * in scope, with "Update available" gated on a read and 3 s of ready, and
 * held through a reconnect until a read on the new connection answers.
 */
function machineTarget(
  input: {
    scope: string
    hosts: HostsSnapshot
    byMachine: Record<string, MachineUpdateEntry>
    terminal: boolean
    previous: UpdateRowView | null
  },
  now: number,
  wake: (number | undefined)[],
): UpdateRowView | null {
  const { hosts, byMachine, previous } = input
  const id = footerMachineId(input.scope, hosts, byMachine, now)
  if (!id) return null
  const entry = byMachine[id] ?? EMPTY_MACHINE_UPDATE
  const host = hosts[id]
  const state = deriveMachineUpdate({
    machineId: id,
    label: machineLabel(id),
    host,
    entry,
    peers: Object.values(hosts),
    configure: false,
    terminal: input.terminal,
    owner: false,
    now,
  })
  const row = machineUpdateRow(state, now)
  wake.push(rowExpiresAt(entry))
  const offered = previous?.machineId === id && previous.tone === 'action'
  if (!row && offered && host?.ops && entry.readToken !== host.connectionToken) return previous
  if (state.phase !== 'available') return row
  const gate = availableShows(host, entry, offered, now)
  wake.push(gate.wakeAt)
  return gate.shows ? row : null
}

/** The next footer state from the targets, or the same object when nothing changed. */
function nextFooter(
  before: FooterState,
  targets: FooterState['targets'],
  now: number,
  wake: (number | undefined)[],
): FooterState {
  const app = settleSlot(before.slots.app, targets.app, now)
  const machine = settleSlot(before.slots.machine, targets.machine, now)
  wake.push(app.wakeAt, machine.wakeAt)
  if (
    app.slot === before.slots.app &&
    machine.slot === before.slots.machine &&
    sameRow(targets.app, before.targets.app) &&
    sameRow(targets.machine, before.targets.machine)
  )
    return before
  return {
    slots: { app: app.slot, machine: machine.slot },
    last: {
      app: app.slot.row ?? before.last.app,
      machine: machine.slot.row ?? before.last.machine,
    },
    targets,
  }
}

/**
 * The rows to show now, by the show-delay, dwell and collapse rules, and when
 * to look again. The state lives in the store, so a remount continues it.
 */
function useUpdateRows(appInfo: boolean, terminal: boolean): FooterState {
  const update = useUpdatesStore((s) => s.update)
  const hosts = useRemoteLanesStore((s) => s.hosts)
  const scope = useRemoteLanesStore((s) => s.filter)
  const byMachine = useMachineUpdatesStore((s) => s.byMachine)
  const machines = useMachinesStore((s) => s.machines)
  const startedAt = useMachineUpdatesStore((s) => s.startedAt)
  const footer = useMachineUpdatesStore((s) => s.footer ?? EMPTY_FOOTER)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const now = Date.now()
    const before = useMachineUpdatesStore.getState().footer ?? EMPTY_FOOTER
    const wake: (number | undefined)[] = []
    const targets: FooterState['targets'] = { app: null, machine: null }
    // Nothing during the app's start; a sidebar mounted later shows its rows at once.
    if (startedAt !== undefined && now - startedAt < START_DELAY_MS)
      wake.push(startedAt + START_DELAY_MS)
    else {
      targets.app = appInfo ? appUpdateRow(update) : null
      const previous = before.slots.machine.row
      targets.machine = machineTarget({ scope, hosts, byMachine, terminal, previous }, now, wake)
    }
    const next = nextFooter(before, targets, now, wake)
    if (next !== before) useMachineUpdatesStore.setState({ footer: next })
    const at = Math.min(...wake.filter((t): t is number => t !== undefined && t > now))
    if (!Number.isFinite(at)) return
    const timer = setTimeout(() => setTick((n) => n + 1), at - now)
    return () => clearTimeout(timer)
  }, [appInfo, terminal, update, hosts, scope, byMachine, machines, startedAt, tick])

  return footer
}

const TONE: Record<UpdateRowView['tone'], string> = {
  action: 'bg-accent-soft text-accent hover:bg-accent hover:text-bg font-medium',
  progress: 'text-text-secondary cursor-default',
  good: 'text-text-secondary hover:text-text hover:bg-bg-secondary',
  warn: 'text-warning hover:bg-bg-secondary',
}
const DOT: Record<UpdateRowView['tone'], string> = {
  action: 'bg-accent',
  progress: 'bg-text-tertiary motion-safe:animate-pulse',
  good: 'bg-success',
  warn: 'bg-warning',
}

/** One fixed 28 px slot: its height animates open and shut; its text cross-fades in place. */
function UpdateSlot({
  slot,
  row,
  last,
  target,
  onClick,
}: {
  slot: UpdateRowView['id']
  row: UpdateRowView | null
  last: UpdateRowView | null
  /** What the slot would show now: a click runs its action, never a dwelling row's. */
  target: UpdateRowView | null
  onClick: (row: UpdateRowView) => void
}) {
  const acting = useUpdatesStore((s) => s.acting)
  const view = row ?? last
  const clickable = !!row && actionable(target) && !acting
  return (
    <div
      data-update-row={slot}
      className={clsx('px-update-slot', row && 'px-update-slot-open')}
      // Collapsed, its button is disabled and so unfocusable; nothing in the shell is made inert.
      aria-hidden={row ? undefined : true}
    >
      <div className="min-h-0 overflow-hidden">
        {view && (
          <TooltipButton
            type="button"
            title={view.title}
            disabled={!clickable}
            onClick={() => clickable && target && onClick(target)}
            className={clsx(
              '-mx-1 mb-1 flex h-7 w-[calc(100%+8px)] items-center gap-2 rounded-md px-1.5 text-left text-base transition-colors',
              TONE[view.tone],
            )}
          >
            <span
              aria-hidden
              className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', DOT[view.tone])}
            />
            <span
              key={`${view.name}·${view.text}`}
              className="px-update-text min-w-0 flex-1 truncate"
            >
              <span className="text-text-tertiary">{view.name} · </span>
              {view.text}
              {view.percent !== undefined && (
                <span className="inline-block w-[4ch] text-right tabular-nums">
                  {' '}
                  {view.percent}%
                </span>
              )}
            </span>
          </TooltipButton>
        )}
      </div>
    </div>
  )
}

/**
 * The bottom-left update rows, above the account row on every client: the
 * Desktop app (where `appInfo`), then the machine in scope or the machine an
 * update is running on. The machine row never starts an update: it opens
 * that machine's Settings → Advanced, where the one confirm lives.
 */
export function UpdatesFooter(): React.JSX.Element {
  const { appInfo, terminal } = usePlatform()
  const openSettings = useOpenSettings()
  const footer = useUpdateRows(appInfo, terminal)
  useEffect(() => (appInfo ? useUpdatesStore.getState().subscribe() : undefined), [appInfo])
  const open = (row: UpdateRowView) => {
    if (row.machineId) openSettings(row.machineId, 'advanced')
    else void useUpdatesStore.getState().restartAndInstall()
  }
  return (
    <div data-testid="updates-footer">
      {(['app', 'machine'] as const).map((slot) => (
        <UpdateSlot
          key={slot}
          slot={slot}
          row={footer.slots[slot].row}
          last={footer.last[slot]}
          target={footer.targets[slot]}
          onClick={open}
        />
      ))}
    </div>
  )
}
