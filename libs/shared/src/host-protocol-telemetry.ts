/**
 * The Host's `machine.telemetry` answer: one machine-wide sample of CPU,
 * memory, disk and the Host's own process tree, for the host popover.
 *
 * It carries monotonic counters, never rates. The Host keeps no sampler state
 * — it answers each call with what the kernel says right now — and the client
 * turns two consecutive samples into a percentage. A client that opens the
 * popover at any moment gets the same truth, and a gap in the poll (a
 * reconnect, a backgrounded tab) costs one delta rather than lying.
 *
 * A read that the OS refuses is `null`, never zero: an unreadable volume and an
 * empty disk, a census that `ps` could not give and a machine with no children
 * are different facts, and the popover must be able to tell them apart.
 *
 * A Host's process list reaches every client that can see it, so the parse
 * projects reviewed fields only: no path, argv, environment or user. The tree
 * is the Host's own subtree, so a session that is not under that process — a
 * Desktop lane in in-app mode — is simply not in it.
 */
import { integer, member, record, text } from './host-protocol/primitives'

/** Hard caps on one answer, whatever the machine reports. */
export const TELEMETRY_LIMITS = { cores: 256, procs: 96, labelBytes: 48 } as const

/** A process name is what the Host's sampler can emit: a bare lowercase word. */
const LABEL = /^[a-z0-9._+-]+$/

export type TelemetryProcKind = 'host' | 'pi' | 'shell' | 'mcp' | 'other'

/** Kernel jiffies since boot. `busy` excludes idle and iowait. */
export interface TelemetryCounters {
  idle: number
  busy: number
}

/** CPU-seconds and RSS split by what the process is, so the popover can add up. */
export interface TelemetryKind {
  kind: TelemetryProcKind
  procs: number
  /** Cumulative CPU-seconds of every process of this kind since it started. */
  cpuSec: number
  /** Resident set in bytes, summed. Shared pages count twice, so it is an upper bound. */
  rss: number
}

export interface TelemetryProc {
  pid: number
  ppid: number
  kind: TelemetryProcKind
  /** Executable basename, never a path or argv. */
  label: string
  /** Cumulative CPU-seconds since the process started. */
  cpuSec: number
  rss: number
  uptimeSec: number
}

/** The process tree and its per-kind totals, or null when the census failed. */
export interface TelemetryCensus {
  /** Grouped by kind, one row per kind, counted over the whole tree. */
  kinds: TelemetryKind[]
  /** The largest-RSS rows, capped at `TELEMETRY_LIMITS.procs`. */
  procs: TelemetryProc[]
}

export interface MachineTelemetry {
  /** Host wall clock in epoch ms. A client ages a sample on its own clock instead. */
  at: number
  uptimeSec: number
  /** `loadavg`, one per core at full use on the platforms that have it. */
  load: [number, number, number]
  /** One pair per core, at most `TELEMETRY_LIMITS.cores` of them; its length is the core count. */
  cpu: { perCore: TelemetryCounters[] }
  mem: {
    total: number
    free: number
    /** Neither free nor reclaimable cache, so `used + cache + free ≈ total`. */
    used: number
    cache: number
    swapTotal: number
    swapUsed: number
  }
  /** The volume holding the Host's state folder, or null when it could not be read. */
  disk: { total: number; free: number } | null
  /** The Host's own process tree, or null when the census could not be taken. */
  census: TelemetryCensus | null
}

const seconds = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e12
const jiffies = (v: unknown): v is number => integer(v) && v <= 1e15

function counters(v: unknown): TelemetryCounters | null {
  if (!record(v) || !jiffies(v.idle) || !jiffies(v.busy)) return null
  return { idle: v.idle, busy: v.busy }
}

function proc(v: unknown): TelemetryProc | null {
  if (
    !record(v) ||
    !integer(v.pid, 1) ||
    !integer(v.ppid) ||
    !member(v.kind, KINDS) ||
    !text(v.label, TELEMETRY_LIMITS.labelBytes) ||
    !LABEL.test(v.label) ||
    !seconds(v.cpuSec) ||
    !integer(v.rss) ||
    !seconds(v.uptimeSec)
  )
    return null
  return {
    pid: v.pid,
    ppid: v.ppid,
    kind: v.kind,
    label: v.label,
    cpuSec: v.cpuSec,
    rss: v.rss,
    uptimeSec: v.uptimeSec,
  }
}

/**
 * The whole answer, or null: an unparseable sample is an unsupported Host.
 * Absent is not the same as null here — `used`, `cache` and the swap fields
 * default to 0 because the Host always computes them, while `disk` and `census`
 * are null only when the Host knows it could not read them.
 */
export function parseMachineTelemetry(v: unknown): MachineTelemetry | null {
  if (!record(v) || !integer(v.at, 0) || !seconds(v.uptimeSec)) return null
  const [one, five, fifteen] = Array.isArray(v.load) ? v.load : []
  if (!seconds(one) || !seconds(five) || !seconds(fifteen)) return null
  if (!record(v.cpu) || !Array.isArray(v.cpu.perCore)) return null
  const perCore = list(v.cpu.perCore, TELEMETRY_LIMITS.cores, counters)
  if (!perCore) return null
  if (!record(v.mem) || !integer(v.mem.total, 1) || !integer(v.mem.free)) return null
  const mem = {
    total: v.mem.total,
    free: v.mem.free,
    used: integer(v.mem.used) ? v.mem.used : 0,
    cache: integer(v.mem.cache) ? v.mem.cache : 0,
    swapTotal: integer(v.mem.swapTotal) ? v.mem.swapTotal : 0,
    swapUsed: integer(v.mem.swapUsed) ? v.mem.swapUsed : 0,
  }
  // The Host computes these from one another, so a part larger than its whole
  // is a Host that lied, and every bar the popover draws would be nonsense.
  if (mem.used > mem.total || mem.free > mem.total || mem.swapUsed > mem.swapTotal) return null
  const disk = readDisk(v.disk)
  if (v.disk !== null && !disk) return null
  if (disk && disk.free > disk.total) return null
  const census = readCensus(v.census)
  if (v.census !== null && !census) return null
  return {
    at: v.at,
    uptimeSec: v.uptimeSec,
    load: [one, five, fifteen],
    cpu: { perCore },
    mem,
    disk,
    census,
  }
}

/** A bounded, fully parsed list, or null if it is oversized or any item is unusable. */
function list<T>(values: unknown[], max: number, parse: (v: unknown) => T | null): T[] | null {
  if (values.length < 1 || values.length > max) return null
  const out: T[] = []
  for (const value of values) {
    const item = parse(value)
    if (item === null) return null
    out.push(item)
  }
  return out
}

function readDisk(v: unknown): MachineTelemetry['disk'] {
  if (!record(v) || !integer(v.total, 1) || !integer(v.free)) return null
  return { total: v.total, free: v.free }
}

function readCensus(v: unknown): MachineTelemetry['census'] {
  if (!record(v) || !Array.isArray(v.kinds) || !Array.isArray(v.procs)) return null
  if (v.kinds.length > KINDS.length || v.procs.length > TELEMETRY_LIMITS.procs) return null
  const kinds: TelemetryKind[] = []
  for (const kind of v.kinds) {
    if (
      !record(kind) ||
      !member(kind.kind, KINDS) ||
      !integer(kind.procs, 1) ||
      !seconds(kind.cpuSec) ||
      !integer(kind.rss)
    )
      return null
    // One row per kind: a Host that sent two would double every total built from them.
    if (kinds.some((seen) => seen.kind === kind.kind)) return null
    kinds.push({ kind: kind.kind, procs: kind.procs, cpuSec: kind.cpuSec, rss: kind.rss })
  }
  const procs: TelemetryProc[] = []
  for (const row of v.procs) {
    const parsed = proc(row)
    if (!parsed) return null
    procs.push(parsed)
  }
  return { kinds, procs }
}

/** The machine's whole idle/busy counters: the sum of its cores, computed once. */
export function sumCounters(
  perCore: readonly TelemetryCounters[],
): TelemetryCounters & { cores: number } {
  return perCore.reduce<{ cores: number; idle: number; busy: number }>(
    (sum, core) => ({
      cores: sum.cores + 1,
      idle: sum.idle + core.idle,
      busy: sum.busy + core.busy,
    }),
    { cores: 0, idle: 0, busy: 0 },
  )
}

/** Percent of one core, from two consecutive counter samples; null when either is unusable. */
export function counterDeltaPct(prev: TelemetryCounters, next: TelemetryCounters): number | null {
  const idle = next.idle - prev.idle
  const busy = next.busy - prev.busy
  if (idle < 0 || busy < 0 || idle + busy <= 0) return null
  return (busy / (idle + busy)) * 100
}

/** The same for one process: CPU-seconds elapsed divided by the wall-clock gap. */
export function procDeltaPct(
  prevSec: number,
  nextSec: number,
  elapsedSec: number,
  cores: number,
): number | null {
  const used = nextSec - prevSec
  if (used < 0 || elapsedSec <= 0) return null
  return Math.min(100 * cores, (used / elapsedSec) * 100)
}

const KINDS: readonly TelemetryProcKind[] = ['host', 'pi', 'shell', 'mcp', 'other']
