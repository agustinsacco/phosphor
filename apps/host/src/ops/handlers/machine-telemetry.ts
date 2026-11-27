/**
 * The `machine.telemetry` op: the machine's resource sample, said in percentages.
 *
 * The Host method answers monotonic counters and keeps no state, which is right
 * for a client that polls and rates two samples against each other. An agent
 * asking once has no previous sample, so the op reads twice a short window apart
 * and prints the difference — and prints what the machine would not say as
 * unreadable rather than as zero.
 */
import {
  censusCpuSec,
  censusProcs,
  censusRss,
  counterDeltaPct,
  parseMachineTelemetry,
  procDeltaPct,
  sumCounters,
  type MachineTelemetry,
  type TelemetryCensus,
} from '@phosphor/shared/host-protocol-telemetry'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import { op } from '@phosphor/session-runtime/ops/results'
import type { DaemonHandlerDeps } from './index'
import { laneCall } from './lane-target'

/** The window the op measures CPU over: one sample is counters, two are a percent. */
const TELEMETRY_WINDOW_MS = 250

export const machineTelemetryOp = (deps: DaemonHandlerDeps) =>
  op(async () => {
    const [first, sample] = await awaitPair(deps)
    const cores = Math.max(1, sample.cpu.perCore.length)
    const cpuPct = counterDeltaPct(sumCounters(first.cpu.perCore), sumCounters(sample.cpu.perCore))
    const phosphorPct =
      first.census && sample.census
        ? procDeltaPct(
            censusCpuSec(first.census),
            censusCpuSec(sample.census),
            TELEMETRY_WINDOW_MS / 1000,
            cores,
          )
        : null
    return { text: telemetryReadout(first, sample), data: { cores, cpuPct, phosphorPct, sample } }
  })

/** Two samples a window apart, because the machine's percent is a difference. */
async function awaitPair(deps: DaemonHandlerDeps): Promise<[MachineTelemetry, MachineTelemetry]> {
  const first = parseMachineTelemetry(await laneCall(deps.lanes, 'machine.telemetry', {}))
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, TELEMETRY_WINDOW_MS)
    timer.unref?.()
  })
  const sample = parseMachineTelemetry(await laneCall(deps.lanes, 'machine.telemetry', {}))
  if (!first || !sample)
    throw new OpRefusal('unavailable', 'This machine reported no telemetry to read.')
  return [first, sample]
}

/**
 * The op's readout: what the machine is doing, and what Phosphor is doing in it.
 * Exported because the arithmetic and the wording are the op's whole result.
 */
export function telemetryReadout(first: MachineTelemetry, sample: MachineTelemetry): string {
  const cores = Math.max(1, sample.cpu.perCore.length)
  const cpu = counterDeltaPct(sumCounters(first.cpu.perCore), sumCounters(sample.cpu.perCore))
  const swap =
    sample.mem.swapTotal > 0
      ? ` · swap ${size(sample.mem.swapUsed)} of ${size(sample.mem.swapTotal)}`
      : ''
  const phosphor = !sample.census
    ? "Phosphor's processes could not be read on this machine."
    : `Phosphor ${censusProcs(sample.census)} processes, ${size(censusRss(sample.census))} resident, ${Math.round(
        procDeltaPct(
          censusCpuSec(first.census),
          censusCpuSec(sample.census),
          TELEMETRY_WINDOW_MS / 1000,
          cores,
        ) ?? 0,
      )}% of one core — ${kinds(sample.census)}`
  return [
    `CPU ${cpu === null ? 'measuring' : `${Math.round(cpu)}%`} across ${cores} cores · load ${sample.load
      .map((n) => n.toFixed(2))
      .join(' ')} · up ${ago(sample.uptimeSec)}`,
    `Memory ${size(sample.mem.used)} of ${size(sample.mem.total)} used${swap}`,
    sample.disk
      ? `Disk ${size(sample.disk.free)} free of ${size(sample.disk.total)}`
      : 'Disk could not be read',
    phosphor,
  ].join('\n')
}

/** What is running, biggest count first: `4 pi, 2 mcp, 1 host`. */
function kinds(census: TelemetryCensus): string {
  return [...census.kinds]
    .sort((a, b) => b.procs - a.procs)
    .map((kind) => `${kind.procs} ${kind.kind}`)
    .join(', ')
}

const size = (bytes: number): string =>
  bytes >= 1 << 30
    ? `${(bytes / (1 << 30)).toFixed(1)}G`
    : bytes >= 1 << 20
      ? `${Math.round(bytes / (1 << 20))}M`
      : `${Math.round(bytes / 1024)}K`

const ago = (seconds: number): string => {
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}
