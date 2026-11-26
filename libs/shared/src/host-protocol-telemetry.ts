/**
 * The Host's `machine.telemetry` answer: one machine-wide sample of CPU,
 * memory, disk and Phosphor's own process census, for the host popover.
 *
 * It carries monotonic counters, never rates. The Host keeps no sampler state
 * — it answers each call with what the kernel says right now — and the client
 * turns two consecutive samples into a percentage. A client that opens the
 * popover at any moment gets the same truth, and a gap in the poll (a
 * reconnect, a backgrounded tab) costs one delta rather than lying.
 *
 * A Host's process list reaches every client that can see it, so the parse
 * projects reviewed fields only: no path, argv, environment or user.
 */
import { integer, member, record, text } from './host-protocol/primitives'

/** Hard caps on one answer, whatever the machine reports. */
export const TELEMETRY_LIMITS = { cores: 64, procs: 96, labelBytes: 48 } as const

export type TelemetryProcKind = 'host' | 'pi' | 'shell' | 'mcp' | 'other'

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

export interface MachineTelemetry {
  /** Host wall clock in epoch ms, so a client can age the sample on its own clock. */
  at: number
  uptimeSec: number
  /** `loadavg`, one per core at full use on the platforms that have it. */
  load: [number, number, number]
  cpu: {
    cores: number
    /** Jiffies since boot. `busy` excludes idle and iowait. */
    total: { idle: number; busy: number }
    perCore: { idle: number; busy: number }[]
  }
  mem: {
    total: number
    free: number
    /** Neither free nor reclaimable cache, so `used + cache + free ≈ total`. */
    used: number
    cache: number
    swapTotal: number
    swapUsed: number
  }
  /** The volume holding the Host's state folder: its size and free space, never a path. */
  disk: { total: number; free: number }
  /** Everything under the Host's own process tree, grouped by kind. */
  kinds: TelemetryKind[]
  /** The tree itself, newest-RSS first, capped at `TELEMETRY_LIMITS.procs`. */
  procs: TelemetryProc[]
}

const KINDS: readonly TelemetryProcKind[] = ['host', 'pi', 'shell', 'mcp', 'other']

const bytes = (v: unknown): v is number => integer(v) && v <= Number.MAX_SAFE_INTEGER
const seconds = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e12
const jiffies = (v: unknown): v is number => integer(v) && v <= 1e15

function counters(v: unknown): { idle: number; busy: number } | null {
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
    !seconds(v.cpuSec) ||
    !bytes(v.rss) ||
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

/** The whole answer, or null: an unparseable sample is an unsupported Host. */
export function parseMachineTelemetry(v: unknown): MachineTelemetry | null {
  if (!record(v) || !integer(v.at, 0) || !seconds(v.uptimeSec)) return null
  const [one, five, fifteen] = Array.isArray(v.load) ? v.load : []
  if (!seconds(one) || !seconds(five) || !seconds(fifteen)) return null
  if (!record(v.cpu) || !integer(v.cpu.cores, 1) || v.cpu.cores > TELEMETRY_LIMITS.cores)
    return null
  const total = counters(v.cpu.total)
  if (!total || !Array.isArray(v.cpu.perCore) || v.cpu.perCore.length !== v.cpu.cores) return null
  const perCore: MachineTelemetry['cpu']['perCore'] = []
  for (const core of v.cpu.perCore) {
    const parsed = counters(core)
    if (!parsed) return null
    perCore.push(parsed)
  }
  if (!record(v.mem) || !bytes(v.mem.total) || !bytes(v.mem.free)) return null
  const mem = {
    total: v.mem.total,
    free: v.mem.free,
    used: bytes(v.mem.used) ? v.mem.used : 0,
    cache: bytes(v.mem.cache) ? v.mem.cache : 0,
    swapTotal: bytes(v.mem.swapTotal) ? v.mem.swapTotal : 0,
    swapUsed: bytes(v.mem.swapUsed) ? v.mem.swapUsed : 0,
  }
  if (!record(v.disk) || !bytes(v.disk.total) || !bytes(v.disk.free)) return null
  if (!Array.isArray(v.kinds) || v.kinds.length > KINDS.length) return null
  const kinds: TelemetryKind[] = []
  for (const kind of v.kinds) {
    if (
      !record(kind) ||
      !member(kind.kind, KINDS) ||
      !integer(kind.procs, 1) ||
      !seconds(kind.cpuSec) ||
      !bytes(kind.rss)
    )
      return null
    kinds.push({ kind: kind.kind, procs: kind.procs, cpuSec: kind.cpuSec, rss: kind.rss })
  }
  if (!Array.isArray(v.procs) || v.procs.length > TELEMETRY_LIMITS.procs) return null
  const procs: TelemetryProc[] = []
  for (const p of v.procs) {
    const parsed = proc(p)
    if (!parsed) return null
    procs.push(parsed)
  }
  return {
    at: v.at,
    uptimeSec: v.uptimeSec,
    load: [one, five, fifteen],
    cpu: { cores: v.cpu.cores, total, perCore },
    mem,
    disk: { total: v.disk.total, free: v.disk.free },
    kinds,
    procs,
  }
}

/** Percent of one core, from two consecutive counter samples; null when either is unusable. */
export function counterDeltaPct(
  prev: { idle: number; busy: number },
  next: { idle: number; busy: number },
): number | null {
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
