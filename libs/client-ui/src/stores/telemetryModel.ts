/**
 * The client's view of one Host's telemetry, built from the samples it polls.
 *
 * `machine.telemetry` answers counters, so every percentage here comes from two
 * consecutive samples, and the first sample after a gap — a cold open, a
 * reconnect, a missed poll — has no rate to show rather than an invented one.
 * Age and spacing use the client's own clock (`receivedAt`), because the Host's
 * clock can be minutes off from this one.
 *
 * The history is one fixed ring of compact points covering an hour. A range
 * control asks it for a slice; it never re-reads the Host.
 */
import {
  censusCpuSec,
  censusProcs,
  censusRss,
  counterDeltaPct,
  procDeltaPct,
  sumCounters,
  type MachineTelemetry,
  type TelemetryCensus,
  type TelemetryProcKind,
} from '@phosphor/shared/host-protocol-telemetry'

/** Points in the ring: 1 800 of them is an hour at the 2 s poll. */
export const RING_POINTS = 1_800
/** Past this the poll stalled: the next sample has no rate, only a new first point. */
export const MAX_RATE_GAP_MS = 6_000

/** Percentages, not absolutes: the popover's bars all want 0…100. */
export interface TelemetryPoint {
  /** Client ms. The Host's clock may be minutes off from this one. */
  receivedAt: number
  /** Percent of the whole machine busy. Null when no counters preceded it. */
  cpu: number | null
  memPct: number
  /** Phosphor's share of CPU. Held between samples that cannot measure it. */
  phosphorPct: number
}

/** One Host row: the latest sample, plus the rates two samples make. */
export interface TelemetryView {
  /** Latest sample, or null before the first one lands — never a zeroed fake. */
  current: MachineTelemetry | null
  /** Machine-wide CPU since the previous sample. Null with nothing to compare against. */
  cpu: number | null
  /** Percent per core, as long as `current.cpu.perCore`; null without a predecessor. */
  corePct: number[] | null
  /** `used / total`; null with no sample. */
  memPct: number | null
  /** Bytes in the Host's own subtree. Null with no sample, 0 when its census failed. */
  phosphorRss: number | null
  /** Processes in that subtree. Null with no sample, 0 when its census failed. */
  phosphorProcs: number | null
  /** That subtree's CPU-seconds per wall second, as a percent of one core. */
  phosphorPct: number | null
  /** `swapUsed / swapTotal`, null when there is no swap or no sample. */
  swapPct: number | null
  /** `load[1]` per core, and `load[15]` per core: how full the run queue runs. */
  load1Pct: number | null
  load15Pct: number | null
  /** CPU-seconds per wall second by process kind. Empty without a predecessor. */
  procPct: Partial<Record<TelemetryProcKind, number>>
  /** Compact points for the graph, oldest first. */
  points: readonly TelemetryPoint[]
  /** Client ms of the last sample that arrived, for the popover's "sampled Ns ago". */
  receivedAt: number | null
}

export const EMPTY_POINTS: readonly TelemetryPoint[] = Object.freeze([])

export const EMPTY_VIEW: TelemetryView = Object.freeze({
  current: null,
  cpu: null,
  corePct: null,
  memPct: null,
  phosphorRss: null,
  phosphorProcs: null,
  phosphorPct: null,
  swapPct: null,
  load1Pct: null,
  load15Pct: null,
  procPct: {},
  points: EMPTY_POINTS,
  receivedAt: null,
})

/** A fresh view for a Host that has never been sampled. */
export function newView(): TelemetryView {
  return { ...EMPTY_VIEW }
}

/**
 * Fold one sample into the view. `gap` says a sample was missed since the one
 * on screen, which is the only honest reason to withhold a rate: a percentage
 * drawn across a gap is an average of a period nobody watched.
 */
export function withSample(
  previous: TelemetryView,
  telemetry: MachineTelemetry,
  gap: boolean,
  receivedAt: number,
): TelemetryView {
  const prior = previous.current
  const elapsedMs =
    gap || !prior || previous.receivedAt === null ? 0 : receivedAt - previous.receivedAt
  const usable = elapsedMs > 0 && elapsedMs <= MAX_RATE_GAP_MS
  const elapsedSec = elapsedMs / 1000
  const cores = Math.max(1, telemetry.cpu.perCore.length)
  const memPct = pct(telemetry.mem.used, telemetry.mem.total)
  const phosphorPct =
    usable && prior?.census && telemetry.census
      ? procDeltaPct(totalSec(prior.census), totalSec(telemetry.census), elapsedSec, cores)
      : null
  const point: TelemetryPoint = {
    receivedAt,
    cpu: usable && prior ? counterDeltaPct(sum(prior), sum(telemetry)) : null,
    memPct: memPct ?? 0,
    phosphorPct: phosphorPct ?? lastPhosphorPct(previous.points),
  }
  return {
    current: telemetry,
    cpu: point.cpu,
    corePct: usable && prior ? corePcts(prior, telemetry) : null,
    memPct,
    phosphorPct,
    phosphorRss: censusRss(telemetry.census),
    phosphorProcs: censusProcs(telemetry.census),
    swapPct: pct(telemetry.mem.swapUsed, telemetry.mem.swapTotal),
    load1Pct: telemetry.load[1] / cores,
    load15Pct: telemetry.load[2] / cores,
    procPct:
      usable && prior?.census && telemetry.census
        ? procPcts(prior.census, telemetry.census, elapsedSec, cores)
        : {},
    points: pushPoint(previous.points, point),
    receivedAt,
  }
}

/**
 * The last `lastMs` of points, or all of them when the ring is younger than the
 * window. A fresh array each call: ask for it from render with `useMemo`, not
 * from a store selector, or every poll redraws the graph's caller.
 */
export function ringWindow(
  points: readonly TelemetryPoint[],
  lastMs: number,
  nowMs: number,
): readonly TelemetryPoint[] {
  if (points.length === 0) return EMPTY_POINTS
  const from = nowMs - lastMs
  let first = points.length
  while (first > 0) {
    const point = points[first - 1]
    if (!point || point.receivedAt <= from) break
    first--
  }
  const window = points.slice(first)
  return window.length === 0 ? EMPTY_POINTS : Object.freeze(window)
}

function sum(telemetry: MachineTelemetry) {
  return sumCounters(telemetry.cpu.perCore)
}

/** Per-core percent. A core that vanished between samples (a Host reboot mid-poll) reads 0. */
function corePcts(prior: MachineTelemetry, telemetry: MachineTelemetry): number[] {
  return telemetry.cpu.perCore.map((core, index) => {
    const was = prior.cpu.perCore[index]
    return was ? (counterDeltaPct(was, core) ?? 0) : 0
  })
}

function procPcts(
  prior: TelemetryCensus,
  census: TelemetryCensus,
  elapsedSec: number,
  cores: number,
): TelemetryView['procPct'] {
  const out: TelemetryView['procPct'] = {}
  for (const kind of census.kinds) {
    const pct = procDeltaPct(
      kindSec(prior, kind.kind),
      kindSec(census, kind.kind),
      elapsedSec,
      cores,
    )
    if (pct !== null) out[kind.kind] = pct
  }
  return out
}

const kindSec = (census: TelemetryCensus, kind: TelemetryProcKind): number =>
  census.kinds.find((entry) => entry.kind === kind)?.cpuSec ?? 0

const totalSec = (census: TelemetryCensus): number => censusCpuSec(census)

function lastPhosphorPct(points: readonly TelemetryPoint[]): number {
  return points.at(-1)?.phosphorPct ?? 0
}

/** Append to the ring, dropping the oldest points past the cap. */
function pushPoint(
  points: readonly TelemetryPoint[],
  point: TelemetryPoint,
): readonly TelemetryPoint[] {
  const next = [...points, point]
  return next.length > RING_POINTS ? next.slice(next.length - RING_POINTS) : next
}

const pct = (value: number, total: number): number | null =>
  total > 0 ? Math.min(100, (value / total) * 100) : null
