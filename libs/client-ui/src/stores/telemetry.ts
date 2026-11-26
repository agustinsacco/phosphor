/**
 * Host telemetry: one store projection per Host, polled only while someone is
 * looking.
 *
 * The Host is stateless about this (it answers with kernel counters), so the
 * client owns the two things that need memory: the ring of points the graphs
 * draw, and the rate math. Every percentage is a difference between two
 * consecutive samples, so the first sample after opening or reconnecting
 * reports `null` rather than 0.
 *
 * The poll is refcounted the way `machines.ts` refcounts its listener: opening
 * the popover starts one interval per Host, closing it stops that interval, and
 * an in-flight request is never overlapped. Nothing runs while nobody watches.
 * A failed tick is not a dead end — the next one is already scheduled, and the
 * last good sample stays on screen with its age.
 */
import type { MachineTelemetry } from '@phosphor/shared/host-protocol-telemetry'
import { counterDeltaPct, procDeltaPct } from '@phosphor/shared/host-protocol-telemetry'
import { create } from 'zustand'
import {
  emptyHost,
  phosphorRss,
  type TelemetryHost,
  type TelemetryPoint,
  type TelemetryStore,
} from './telemetryModel'

export { emptyHost, phosphorRss } from './telemetryModel'
export type { TelemetryHost, TelemetryPoint, TelemetryStore } from './telemetryModel'

/** Two seconds: fine enough to see a lane's spike, cheap enough to ignore. */
export const TELEMETRY_POLL_MS = 2_000
/** An hour of the compact points. The full sample is only ever the latest one. */
const RING_POINTS = 1_800
/**
 * How many ticks one request may hold the slot. A call that never settles — a
 * renderer bridge torn down mid-flight — must not silence the popover for good.
 */
const STALL_TICKS = 15
/**
 * Two samples further apart than this say nothing about the present, so they
 * make no rate: an averaged-over-hours percent would be a fiction on the graph.
 */
const MAX_RATE_GAP_MS = TELEMETRY_POLL_MS * 3

const hostTimers = new Map<string, ReturnType<typeof setInterval>>()
const hostViewers = new Map<string, number>()
const inFlight = new Map<string, { blocked: number; token: number }>()
let tokenSeed = 0

function point(sample: MachineTelemetry, prev: MachineTelemetry | null): TelemetryPoint {
  return {
    at: sample.at,
    cpu: prev ? counterDeltaPct(prev.cpu.total, sample.cpu.total) : null,
    memUsed: sample.mem.used,
    phosphor: phosphorRss(sample.kinds),
    procs: sample.kinds.reduce((sum, kind) => sum + kind.procs, 0),
  }
}

/** Instantaneous percent per process, from the same pair of samples the CPU uses. */
function procPct(sample: MachineTelemetry, prev: MachineTelemetry | null): Record<number, number> {
  if (!prev) return {}
  const gapSec = (sample.at - prev.at) / 1000
  const before = new Map(prev.procs.map((p) => [p.pid, p.cpuSec]))
  const out: Record<number, number> = {}
  for (const proc of sample.procs) {
    const last = before.get(proc.pid)
    const pct =
      last === undefined ? null : procDeltaPct(last, proc.cpuSec, gapSec, sample.cpu.cores)
    if (pct !== null) out[proc.pid] = pct
  }
  return out
}

function corePct(
  sample: MachineTelemetry,
  prev: MachineTelemetry | null,
): readonly (number | null)[] {
  if (!prev || prev.cpu.perCore.length !== sample.cpu.perCore.length) return []
  return sample.cpu.perCore.flatMap((core, index) => {
    const before = prev.cpu.perCore[index]
    return before ? [counterDeltaPct(before, core)] : []
  })
}

export const useTelemetryStore = create<TelemetryStore>((set, get) => ({
  hosts: {},
  ingest: (hostId, sample) =>
    set((state) => {
      const host = hostOf(state, hostId)
      const previous = usablePrevious(host.sample, sample)
      return {
        hosts: {
          ...state.hosts,
          [hostId]: {
            ...host,
            prev: previous,
            sample,
            points: [...host.points, point(sample, previous)].slice(-RING_POINTS),
            procPct: procPct(sample, previous),
            corePct: corePct(sample, previous),
            loading: false,
            unsupported: false,
            error: null,
          },
        },
      }
    }),
  markLoading: (hostId) =>
    set((state) => ({
      hosts: { ...state.hosts, [hostId]: { ...hostOf(state, hostId), loading: true } },
    })),
  markFailed: (hostId, message, unsupported = false) =>
    set((state) => ({
      hosts: {
        ...state.hosts,
        [hostId]: { ...hostOf(state, hostId), loading: false, error: message, unsupported },
      },
    })),
  setPaused: (hostId, paused) =>
    set((state) => ({
      hosts: { ...state.hosts, [hostId]: { ...hostOf(state, hostId), loading: false, paused } },
    })),
  endPoll: (hostId) =>
    set((state) => ({
      hosts: { ...state.hosts, [hostId]: { ...hostOf(state, hostId), loading: false } },
    })),
  reset: (hostId) =>
    set((state) => {
      const hosts = { ...state.hosts }
      delete hosts[hostId]
      return { hosts }
    }),
  poll: async (hostId) => {
    if (hostOf(get(), hostId).paused) return
    const running = inFlight.get(hostId)
    if (running) {
      // Counted in ticks, not on a clock: the guard exists to skip a tick, and
      // it must give up its slot rather than wedge the popover for good.
      running.blocked++
      if (running.blocked < STALL_TICKS) return
    }
    const token = ++tokenSeed
    inFlight.set(hostId, { blocked: 0, token })
    get().markLoading(hostId)
    try {
      const sample = await window.phosphor.invoke('hosts:telemetry', hostId)
      // A reply to a poll the user has since closed is dropped, not stored.
      if (!hostViewers.has(hostId)) return
      if (sample === null) get().markFailed(hostId, 'This Host does not report resources.', true)
      else get().ingest(hostId, sample)
    } catch {
      if (hostViewers.has(hostId)) get().markFailed(hostId, 'Telemetry unavailable.')
    } finally {
      if (inFlight.get(hostId)?.token === token) inFlight.delete(hostId)
    }
  },
}))

function hostOf(state: Pick<TelemetryStore, 'hosts'>, hostId: string): TelemetryHost {
  return state.hosts[hostId] ?? emptyHost()
}

/** The sample to subtract, or null when it is missing, older than the gap or from the future. */
function usablePrevious(
  before: MachineTelemetry | null,
  sample: MachineTelemetry,
): MachineTelemetry | null {
  if (!before) return null
  const gap = sample.at - before.at
  return gap > 0 && gap <= MAX_RATE_GAP_MS ? before : null
}

/**
 * Watch one Host; the returned function is the only way to stop. It is
 * reference-counted, so two viewers of one Host share an interval and the last
 * one out is the one that ends it.
 */
export function watchTelemetry(hostId: string): () => void {
  if (!hostId) return () => undefined
  const viewers = (hostViewers.get(hostId) ?? 0) + 1
  hostViewers.set(hostId, viewers)
  if (viewers === 1) {
    void useTelemetryStore.getState().poll(hostId)
    hostTimers.set(
      hostId,
      setInterval(() => void useTelemetryStore.getState().poll(hostId), TELEMETRY_POLL_MS),
    )
  }
  let active = true
  return () => {
    if (!active) return
    active = false
    const left = (hostViewers.get(hostId) ?? 1) - 1
    if (left > 0) {
      hostViewers.set(hostId, left)
      return
    }
    hostViewers.delete(hostId)
    const timer = hostTimers.get(hostId)
    if (timer) clearInterval(timer)
    hostTimers.delete(hostId)
    // Nobody is watching, so the overlap guard has nothing left to protect; the
    // next viewer should poll at once rather than inherit a wedged slot.
    inFlight.delete(hostId)
    useTelemetryStore.getState().endPoll(hostId)
  }
}

/** The projection for a Host. Never a fresh object: a new `{}` wakes every subscriber. */
export function telemetryOf(
  state: Pick<TelemetryStore, 'hosts'>,
  hostId: string | undefined,
): TelemetryHost {
  return (hostId === undefined ? undefined : state.hosts[hostId]) ?? EMPTY_HOST
}

const EMPTY_HOST: TelemetryHost = emptyHost()
