import type { HostConnectionView, HostsSnapshot } from '@shared/ipc'
import type { UpdateState } from '@shared/models'
import { serviceScope } from '@/stores/localServiceScope'
import {
  UPDATED_RESULT_MS,
  type MachineUpdateEntry,
  type MachineUpdateState,
  type UpdateRun,
} from './machineUpdateState'

/** One bottom-left row: `name · text`, the tooltip carrying the full sentence. */
export interface UpdateRowView {
  id: 'app' | 'machine'
  name: string
  text: string
  tone: 'action' | 'progress' | 'good' | 'warn'
  title: string
  percent?: number
  /** The machine row's machine, whose Settings it opens. */
  machineId?: string
}

/** Nothing shows during app start. */
export const START_DELAY_MS = 3000
/** "Update available" waits for the machine to be ready this long after a read. */
export const READY_DELAY_MS = 3000
/** A stale "Update available" survives this much disconnection. */
export const STALE_MS = 10 * 60_000
/** "Updated to X" stays this long. */
export const DONE_MS = UPDATED_RESULT_MS
/** A phase shows at least this long. */
export const DWELL_MS = 600
/** A row with nothing to replace it waits this long before collapsing. */
export const COLLAPSE_MS = 150

/** The Desktop app's own update: only what can be acted on or is in progress. */
export function appUpdateRow(update: UpdateState): UpdateRowView | null {
  const base = { id: 'app' as const, name: 'Desktop' }
  const version = update.version ? `version ${update.version}` : 'the update'
  switch (update.phase) {
    case 'downloading':
      return {
        ...base,
        text: 'Downloading',
        tone: 'progress',
        title: `Downloading ${version}.`,
        percent: update.progressPercent,
      }
    case 'installing':
      return { ...base, text: 'Installing…', tone: 'progress', title: `Verifying ${version}.` }
    case 'downloaded':
      return {
        ...base,
        text: 'Restart to update',
        tone: 'action',
        title: `Restart to apply ${version}.`,
      }
    case 'manual-download':
      return { ...base, text: 'Download update', tone: 'action', title: `Download ${version}.` }
    default:
      return null
  }
}

function waitingText(state: MachineUpdateState): string {
  const turns = state.waitingOn?.turns ?? 0
  return turns > 0 ? `Waiting for ${turns} ${turns === 1 ? 'turn' : 'turns'}` : 'Waiting for lanes…'
}

/** A finished run keeps the row: "Updated" for 8 seconds, a failure until its Settings row shows. */
function resultHolds(run: UpdateRun, now: number): boolean {
  if (!run.settled) return true
  if (run.finish === 'updated') return now - (run.settledAt ?? now) < DONE_MS
  return run.finish !== 'current' && run.finish !== 'cancelled' && !run.seen
}

/** The machine row's text for this state, before the show-delay rules. */
export function machineUpdateRow(state: MachineUpdateState, now: number): UpdateRowView | null {
  const { label, run } = state
  const product = state.product === 'service' ? 'The Phosphor service' : 'Phosphor Host'
  const row = (text: string, tone: UpdateRowView['tone'], title: string): UpdateRowView => ({
    id: 'machine',
    name: label,
    text,
    tone,
    title,
    machineId: state.machineId,
  })
  switch (state.phase) {
    case 'available':
      return row(
        'Update available',
        'action',
        `${product} ${state.available} is available on ${label}. Open Settings to update.`,
      )
    case 'downloading':
      return row(
        'Downloading update…',
        'progress',
        `Downloading and verifying the update on ${label}.`,
      )
    case 'waiting':
      return row(waitingText(state), 'progress', `${label} updates once its working lanes finish.`)
    case 'paused':
    case 'restarting':
    case 'health':
      return row('Restarting…', 'progress', `${label} is restarting on the new version.`)
    case 'done':
      return run && resultHolds(run, now)
        ? row(`Updated to ${state.to}`, 'good', `${label} updated to ${state.to}.`)
        : null
    case 'failed':
      return run && resultHolds(run, now)
        ? row(
            'Update didn’t finish',
            'warn',
            `The update on ${label} didn’t finish. Open Settings for details.`,
          )
        : null
    default:
      return null
  }
}

/**
 * A running update outranks the scope until it ends, then its held result;
 * otherwise the machine in scope, if it is one. An active run on any machine
 * comes before another machine's result.
 */
export function footerMachineId(
  scope: string,
  hosts: HostsSnapshot,
  byMachine: Record<string, MachineUpdateEntry>,
  now: number,
): string | undefined {
  const ids = Object.keys(byMachine)
  const running =
    ids.find((id) => {
      const run = byMachine[id]?.run
      return run && !run.settled
    }) ??
    ids.find((id) => {
      const run = byMachine[id]?.run
      return run && resultHolds(run, now)
    })
  if (running) return running
  const id = serviceScope(scope, hosts)
  return hosts[id] ? id : undefined
}

/**
 * Whether an offer the footer showed is still news, from the stored times
 * alone: not after 10 minutes away, while away or across the gap before it
 * came back. A remount therefore cannot revive one that expired meanwhile.
 */
export function offerLasts(entry: MachineUpdateEntry, now: number): boolean {
  const { readySince, downSince } = entry
  if (downSince === undefined) return true
  return (readySince ?? now) - downSince < STALE_MS
}

/**
 * "Update available" appears only after a read and 3 seconds of ready; one
 * already showing (`showing`, still news by `offerLasts`) survives a
 * reconnect. Returns whether it shows, and when that answer can change.
 */
export function availableShows(
  host: HostConnectionView | undefined,
  entry: MachineUpdateEntry,
  showing: boolean,
  now: number,
): { shows: boolean; wakeAt?: number } {
  const { readySince, downSince } = entry
  if (host?.state === 'ready' && readySince !== undefined) {
    if (showing || (entry.status && now - readySince >= READY_DELAY_MS)) return { shows: true }
    return { shows: false, wakeAt: entry.status ? readySince + READY_DELAY_MS : undefined }
  }
  if (showing && downSince !== undefined) return { shows: true, wakeAt: downSince + STALE_MS }
  return { shows: false }
}

/** What a slot shows, and the change it is waiting to make. */
export interface Slot {
  row: UpdateRowView | null
  since: number
  want?: { row: UpdateRowView | null; since: number }
}

export const sameRow = (a: UpdateRowView | null, b: UpdateRowView | null) =>
  a === b ||
  (!!a &&
    !!b &&
    a.machineId === b.machineId &&
    a.name === b.name &&
    a.text === b.text &&
    a.tone === b.tone)

export type UpdateRowId = UpdateRowView['id']

/**
 * The footer's shared state, in the store so a remount continues it: each
 * slot's dwell, the row it last showed (for the collapse), and what each slot
 * would show now, whose action a click runs.
 */
export interface FooterState {
  slots: Record<UpdateRowId, Slot>
  last: Record<UpdateRowId, UpdateRowView | null>
  targets: Record<UpdateRowId, UpdateRowView | null>
}

const NO_SLOT: Slot = { row: null, since: 0 }
export const EMPTY_FOOTER: FooterState = Object.freeze({
  slots: { app: NO_SLOT, machine: NO_SLOT },
  last: { app: null, machine: null },
  targets: { app: null, machine: null },
})

/** The footer without one machine's rows: it was removed. */
export function forgetFooterMachine(footer: FooterState, id: string): FooterState {
  const ours = (row: UpdateRowView | null) => row?.machineId === id
  const { slots, last, targets } = footer
  if (!ours(slots.machine.row) && !ours(last.machine) && !ours(targets.machine)) return footer
  return {
    slots: { ...slots, machine: ours(slots.machine.row) ? NO_SLOT : slots.machine },
    last: { ...last, machine: ours(last.machine) ? null : last.machine },
    targets: { ...targets, machine: ours(targets.machine) ? null : targets.machine },
  }
}

/** A click runs the current target's action: the app's only when it is one to act on. */
export const actionable = (target: UpdateRowView | null): boolean =>
  !!target && (target.machineId !== undefined || target.tone === 'action')

/** What a click on the row does: open a machine's Settings, the app's action, or nothing. */
const actionOf = (row: UpdateRowView): string | undefined =>
  row.machineId !== undefined
    ? `open:${row.machineId}`
    : row.tone === 'action'
      ? row.text
      : undefined

/**
 * The no-flicker rules for one slot: a text with the same action stays 600 ms;
 * a different action (another machine, or another app step) replaces it at
 * once, so a label always says what a click does; nothing replaces it only
 * after 150 ms and the 600 ms, so flipping back and forth does not bounce.
 */
export function settleSlot(
  slot: Slot,
  target: UpdateRowView | null,
  now: number,
): { slot: Slot; wakeAt?: number } {
  if (sameRow(slot.row, target))
    return { slot: slot.row === target && !slot.want ? slot : { row: target, since: slot.since } }
  if (!slot.row) return { slot: { row: target, since: now } }
  const want = slot.want && sameRow(slot.want.row, target) ? slot.want : { row: target, since: now }
  const at = !target
    ? Math.max(want.since + COLLAPSE_MS, slot.since + DWELL_MS)
    : actionOf(target) !== actionOf(slot.row)
      ? now
      : slot.since + DWELL_MS
  return now >= at ? { slot: { row: target, since: now } } : { slot: { ...slot, want }, wakeAt: at }
}

/** When a row's own text expires: "Updated" after 8 seconds. */
export function rowExpiresAt(entry: MachineUpdateEntry | undefined): number | undefined {
  const run = entry?.run
  return run?.settled && run.finish === 'updated' && run.settledAt !== undefined
    ? run.settledAt + DONE_MS
    : undefined
}
