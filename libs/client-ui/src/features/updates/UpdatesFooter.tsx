import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { TooltipButton } from '@/components/Tooltip'
import { useOpenSettings } from '@/features/settings/useOpenSettings'
import { usePlatform } from '@/platform/Platform'
import { EMPTY_MACHINE_UPDATE, useMachineUpdatesStore } from '@/stores/machineUpdates'
import { useMachinesStore } from '@/stores/machines'
import { machineLabel, useRemoteLanesStore } from '@/stores/remoteLanes'
import { deriveMachineUpdate } from './machineUpdateState'
import { useUpdatesStore } from './updatesStore'
import {
  appUpdateRow,
  availableShows,
  footerMachineId,
  machineUpdateRow,
  rowExpiresAt,
  settleSlot,
  START_DELAY_MS,
  trackReadiness,
  type Readiness,
  type Slot,
  type UpdateRowView,
} from './updatesFooterRows'

type Slots = Record<UpdateRowView['id'], Slot>
type Shown = Record<UpdateRowView['id'], { row: UpdateRowView | null; last: UpdateRowView | null }>
const EMPTY_SLOT: Slot = { row: null, since: 0 }
const NOTHING: Shown = { app: { row: null, last: null }, machine: { row: null, last: null } }

/** The rows to show now, by the show-delay, dwell and collapse rules, and when to look again. */
function useUpdateRows(appInfo: boolean, terminal: boolean): Shown {
  const update = useUpdatesStore((s) => s.update)
  const hosts = useRemoteLanesStore((s) => s.hosts)
  const scope = useRemoteLanesStore((s) => s.filter)
  const byMachine = useMachineUpdatesStore((s) => s.byMachine)
  const machines = useMachinesStore((s) => s.machines)
  const [tick, setTick] = useState(0)
  const [shown, setShown] = useState<Shown>(NOTHING)
  const startedAt = useRef<number | undefined>(undefined)
  const readiness = useRef(new Map<string, Readiness>())
  const slots = useRef<Slots>({ app: EMPTY_SLOT, machine: EMPTY_SLOT })

  useEffect(() => {
    const now = Date.now()
    startedAt.current ??= now
    trackReadiness(readiness.current, hosts, now)
    const wake: (number | undefined)[] = []
    let app: UpdateRowView | null = null
    let machine: UpdateRowView | null = null
    if (now - startedAt.current < START_DELAY_MS) wake.push(startedAt.current + START_DELAY_MS)
    else {
      app = appInfo ? appUpdateRow(update) : null
      const id = footerMachineId(scope, hosts, byMachine, now)
      const entry = (id && byMachine[id]) || EMPTY_MACHINE_UPDATE
      if (id) {
        const state = deriveMachineUpdate({
          machineId: id,
          label: machineLabel(id),
          host: hosts[id],
          entry,
          peers: Object.values(hosts),
          configure: false,
          terminal,
          owner: false,
        })
        machine = machineUpdateRow(state, now)
        wake.push(rowExpiresAt(entry))
        if (state.phase === 'available') {
          const showing = slots.current.machine.row?.machineId === id
          const gate = availableShows(
            hosts[id],
            entry,
            readiness.current.get(id) ?? {},
            showing,
            now,
          )
          if (!gate.shows) machine = null
          wake.push(gate.wakeAt)
        }
      }
    }
    const nextApp = settleSlot(slots.current.app, app, now)
    const nextMachine = settleSlot(slots.current.machine, machine, now)
    wake.push(nextApp.wakeAt, nextMachine.wakeAt)
    if (nextApp.slot !== slots.current.app || nextMachine.slot !== slots.current.machine) {
      slots.current = { app: nextApp.slot, machine: nextMachine.slot }
      setShown((before) => ({
        app: { row: nextApp.slot.row, last: nextApp.slot.row ?? before.app.last },
        machine: { row: nextMachine.slot.row, last: nextMachine.slot.row ?? before.machine.last },
      }))
    }
    const at = Math.min(...wake.filter((t): t is number => t !== undefined && t > now))
    if (!Number.isFinite(at)) return
    const timer = setTimeout(() => setTick((n) => n + 1), at - now)
    return () => clearTimeout(timer)
  }, [appInfo, terminal, update, hosts, scope, byMachine, machines, tick])

  return shown
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
  onClick,
}: {
  slot: UpdateRowView['id']
  row: UpdateRowView | null
  last: UpdateRowView | null
  onClick: (row: UpdateRowView) => void
}) {
  const acting = useUpdatesStore((s) => s.acting)
  const view = row ?? last
  const clickable = !!row && (slot === 'machine' || row.tone === 'action') && !acting
  return (
    <div
      data-update-row={slot}
      className={clsx('px-update-slot', row && 'px-update-slot-open')}
      aria-hidden={row ? undefined : true}
      inert={!row}
    >
      <div className="min-h-0 overflow-hidden">
        {view && (
          <TooltipButton
            type="button"
            title={view.title}
            disabled={!clickable}
            onClick={() => row && onClick(row)}
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
  const shown = useUpdateRows(appInfo, terminal)
  useEffect(() => (appInfo ? useUpdatesStore.getState().subscribe() : undefined), [appInfo])
  const open = (row: UpdateRowView) => {
    if (row.machineId) openSettings(row.machineId, 'advanced')
    else void useUpdatesStore.getState().restartAndInstall()
  }
  return (
    <div data-testid="updates-footer">
      <UpdateSlot slot="app" {...shown.app} onClick={open} />
      <UpdateSlot slot="machine" {...shown.machine} onClick={open} />
    </div>
  )
}
