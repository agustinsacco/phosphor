/**
 * Host telemetry for the popover: one entry per Host, polled only while someone
 * is watching.
 *
 * `hosts:telemetry` answers counters, so each sample is folded into
 * `telemetryModel` and the one before it ages on its own. One loop per Host reads
 * back-to-back with a pause between reads: it cannot overlap itself, so a slow
 * Host delays the next read instead of stacking requests on it, and there is no
 * stale reply to discard because only one is ever in flight.
 *
 * Demand drives it. `watchTelemetry` refcounts viewers so two panels on one Host
 * read it once; a hidden tab or a closed popover stops the loop and keeps the
 * last sample on screen; a new connection starts a clean series, because its
 * counters have no honest relationship to the old connection's.
 */
import { create } from 'zustand'
import { keyedSlice } from './keyedSlice'
import { machineCaps } from './machineCaps'
import { machineReadGeneration } from './machineReadGeneration'
import { useRemoteLanesStore } from './remoteLanes'
import type { MachineTelemetry } from '@phosphor/shared/host-protocol-telemetry'
import { EMPTY_VIEW, newView, withSample, type TelemetryView } from './telemetryModel'

/** How often a watched Host is re-read. */
export const TELEMETRY_POLL_MS = 2_000

interface TelemetryState {
  byHost: Record<string, TelemetryHost>
}

interface TelemetryHost {
  /** Live viewers. The loop runs while at least one is open and the tab is visible. */
  viewers: number
  /** False while the tab is hidden: nobody can see the numbers move. */
  allowed: boolean
  /** The loop is between a read and its pause right now. */
  running: boolean
  /** The connection `view` came from. A reconnect is not a previous sample. */
  generation: number
  /** A read was missed since the sample on screen, so the next has no rate to show. */
  gap: boolean
  /** This connection cannot read the machine: not ready, or no `skills.read`. */
  unreadable: boolean
  view: TelemetryView
}

const EMPTY_HOST: TelemetryHost = {
  viewers: 0,
  allowed: true,
  running: false,
  generation: 0,
  gap: true,
  unreadable: false,
  view: EMPTY_VIEW,
}

/** Subscribe with `useTelemetry((state) => telemetryView(state, hostId))`. */
export const useTelemetry = create<TelemetryState>(() => ({ byHost: {} }))
const hosts = keyedSlice<TelemetryHost>({ ...EMPTY_HOST })

/** One Host's view, or the shared frozen empty one: a poll must not wake every subscriber. */
export function telemetryView(state: TelemetryState, hostId: string | null): TelemetryView {
  return hostId ? hosts.read(state.byHost, hostId).view : EMPTY_VIEW
}

/** Whether this connection may read this machine at all, so the popover can say why it is quiet. */
export function telemetryUnreadable(state: TelemetryState, hostId: string | null): boolean {
  return hostId ? hosts.read(state.byHost, hostId).unreadable : false
}

/**
 * Watch one Host until the returned function runs. A Host the grant cannot read,
 * or that is too old to answer, gets no readings rather than a row of dashes
 * that never fills.
 */
export function watchTelemetry(hostId: string): () => void {
  patch(hostId, (host) => ({ ...host, viewers: host.viewers + 1 }))
  start(hostId)
  return () => patch(hostId, (host) => ({ ...host, viewers: Math.max(0, host.viewers - 1) }))
}

/**
 * Whether telemetry may be read at all — false while the tab is hidden. The last
 * sample stays on screen; the loop stops now and resumes when it is allowed.
 */
export function setTelemetryAllowed(allowed: boolean): void {
  useTelemetry.setState((state) => {
    const byHost: Record<string, TelemetryHost> = {}
    for (const [hostId, host] of Object.entries(state.byHost)) byHost[hostId] = { ...host, allowed }
    return { byHost }
  })
  if (allowed) for (const hostId of Object.keys(useTelemetry.getState().byHost)) start(hostId)
}

/** Start the loop when this Host is wanted on screen and its connection can be read. */
function start(hostId: string): void {
  const entry = hosts.read(useTelemetry.getState().byHost, hostId)
  if (!entry.running)
    patch(hostId, (state) => ({
      ...state,
      unreadable: !machineCaps(hostView(hostId)).can('skills.read'),
    }))
  const current = hosts.read(useTelemetry.getState().byHost, hostId)
  if (current.running || current.viewers <= 0 || !current.allowed || current.unreadable) return
  patch(hostId, (state) => ({ ...state, running: true }))
  void poll(hostId, machineReadGeneration(hostId))
}

// A grant or a connection that arrives while the popover is open restarts what it
// made unpollable. `start` is a no-op for every Host that is not being watched.
useRemoteLanesStore.subscribe(() => {
  for (const hostId of Object.keys(useTelemetry.getState().byHost)) start(hostId)
})

/** Read, pause, repeat — while a viewer is open and the tab is visible. */
async function poll(hostId: string, generation: number): Promise<void> {
  try {
    while (wanted(hostId, generation)) {
      const sample = await read(hostId)
      // A reconnect, a closed popover or a hidden tab mid-read: this sample
      // belongs to a series nobody is watching.
      if (!wanted(hostId, generation)) break
      record(hostId, sample, generation)
      await sleep(TELEMETRY_POLL_MS)
    }
  } finally {
    patch(hostId, (entry) => ({ ...entry, running: false }))
    // A viewer that opened, a tab that reappeared or a Host that reconnected in
    // the meantime gets its loop back. `start` refuses when none of that is true.
    start(hostId)
  }
}

/** Still the same connection, still wanted, still on screen? */
function wanted(hostId: string, generation: number): boolean {
  const entry = hosts.read(useTelemetry.getState().byHost, hostId)
  return (
    machineReadGeneration(hostId) === generation &&
    entry.viewers > 0 &&
    entry.allowed &&
    !entry.unreadable
  )
}

/** One sample, or null: the Host is unreachable, refusing, or older than the read. */
async function read(hostId: string): Promise<MachineTelemetry | null> {
  try {
    return await window.phosphor.invoke('hosts:telemetry', hostId)
  } catch {
    return null
  }
}

function record(hostId: string, sample: MachineTelemetry | null, generation: number): void {
  patch(hostId, (entry) => {
    if (!sample) return { ...entry, gap: true, generation }
    const first = entry.generation !== generation || entry.view.current === null
    return {
      ...entry,
      generation,
      gap: false,
      view: withSample(first ? newView() : entry.view, sample, entry.gap, Date.now()),
    }
  })
}

const hostView = (hostId: string) => useRemoteLanesStore.getState().hosts[hostId]

function patch(hostId: string, update: (host: TelemetryHost) => TelemetryHost): void {
  useTelemetry.setState((state) => ({ byHost: hosts.patch(state.byHost, hostId, update) }))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
