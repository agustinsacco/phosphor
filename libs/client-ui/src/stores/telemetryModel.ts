/** The shapes the telemetry store keeps, and the frozen values it returns when a Host has none. */
import type { MachineTelemetry, TelemetryKind } from '@phosphor/shared/host-protocol-telemetry'

/** One poll, reduced to what the graphs need. Kept for an hour; a full sample is not. */
export interface TelemetryPoint {
  at: number
  /** Percent of the whole machine, or null when this sample has no predecessor yet. */
  cpu: number | null
  memUsed: number
  /** Bytes held by every process in the Host's own subtree. */
  phosphor: number
  procs: number
}

export interface TelemetryHost {
  sample: MachineTelemetry | null
  /** The sample `sample` was measured against. Null on the first poll and after a gap too wide to subtract. */
  prev: MachineTelemetry | null
  points: readonly TelemetryPoint[]
  /** Instantaneous percent per pid. Empty on the first sample and after a gap. */
  procPct: Readonly<Record<number, number>>
  corePct: readonly (number | null)[]
  loading: boolean
  paused: boolean
  /** The Host answered `unsupported`: it is older than `machine.telemetry`. */
  unsupported: boolean
  error: string | null
}

export interface TelemetryStore {
  hosts: Readonly<Record<string, TelemetryHost>>
  /** Store one answer, deriving its rates from the sample before it. */
  ingest: (hostId: string, sample: MachineTelemetry) => void
  markLoading: (hostId: string) => void
  markFailed: (hostId: string, message: string, unsupported?: boolean) => void
  setPaused: (hostId: string, paused: boolean) => void
  /** Nobody is watching: keep the data, but nothing is loading. */
  endPoll: (hostId: string) => void
  reset: (hostId: string) => void
  poll: (hostId: string) => Promise<void>
}

export const EMPTY_POINTS: readonly TelemetryPoint[] = Object.freeze([])
export const EMPTY_KINDS: readonly TelemetryKind[] = Object.freeze([])

const EMPTY_PROC_PCT: Readonly<Record<number, number>> = Object.freeze({})
const EMPTY_CORE_PCT: readonly (number | null)[] = Object.freeze([])

/** A Host with nothing yet. Frozen, so it is safe to hand to a selector. */
export function emptyHost(): TelemetryHost {
  return Object.freeze({
    sample: null,
    prev: null,
    points: EMPTY_POINTS,
    procPct: EMPTY_PROC_PCT,
    corePct: EMPTY_CORE_PCT,
    loading: false,
    paused: false,
    unsupported: false,
    error: null,
  })
}

/** Bytes Phosphor and its children hold. RSS, so shared pages count twice. */
export function phosphorRss(kinds: readonly TelemetryKind[]): number {
  return kinds.reduce((sum, kind) => sum + kind.rss, 0)
}
