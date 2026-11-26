/**
 * One machine-wide telemetry sample, read from the kernel on demand.
 *
 * Nothing here runs on a timer: the client polls `machine.telemetry` while its
 * popover is open, so closing the popover stops the work. Every answer is
 * counters rather than rates (see `@phosphor/shared/host-protocol-telemetry`),
 * which is what lets the Host hold no sampler state at all.
 *
 * The process census is the Host's own subtree, taken with one `ps` pass. Its
 * full argv is read only to tell a lane's pi from a shell from an MCP server,
 * and is then thrown away — just the executable's basename reaches a client.
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { statfs } from 'node:fs'
import { cpus, freemem, loadavg, totalmem, uptime } from 'node:os'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import {
  TELEMETRY_LIMITS,
  type MachineTelemetry,
  type TelemetryKind,
  type TelemetryProc,
  type TelemetryProcKind,
} from '@phosphor/shared/host-protocol-telemetry'

const run = promisify(execFile)
/** Both reads are milliseconds of work; past this they are missing, not slow. */
const READ_DEADLINE_MS = 1_500
const PS_MAX_BYTES = 1024 * 1024
const SHELLS = /^(?:bash|zsh|sh|fish|dash|ksh|tmux|screen)$/

export interface TelemetrySample {
  /** The volume to measure: the Host's home folder sits on its state volume. */
  home: string
  platform?: NodeJS.Platform
  /** Test seam. Defaults to one real `ps` pass. */
  rows?: () => Promise<PsRow[]>
}

/** One line of `ps`, with the fields the census needs and nothing else. */
export interface PsRow {
  pid: number
  ppid: number
  rss: number
  cpuSec: number
  elapsedSec: number
  comm: string
  args: string
}

/** `00:01.02`, `1:02:03` or `1-02:03:04` as seconds. */
export function parseCpuTime(value: string): number {
  const daySplit = value.match(/^(\d+)-(.+)$/)
  const parts = (daySplit?.[2] ?? value).split(':').map(Number)
  if (parts.some((n) => !Number.isFinite(n))) return 0
  const seconds = parts.reduce((total, part) => total * 60 + part, 0)
  return seconds + (Number(daySplit?.[1]) || 0) * 86_400
}

/** `pid ppid rss time etimes comm args`, one process per line. */
export function parsePsRows(out: string): PsRow[] {
  const rows: PsRow[] = []
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s*(.*)$/)
    if (!m?.[1]) continue
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2] ?? 0),
      rss: Number(m[3] ?? 0) * 1024,
      cpuSec: parseCpuTime(m[4] ?? ''),
      elapsedSec: Number(m[5] ?? 0),
      comm: (m[6] ?? '').slice(0, TELEMETRY_LIMITS.labelBytes),
      args: m[7] ?? '',
    })
  }
  return rows
}

/** What a process is, from how it was launched. `other` is the safe answer. */
export function classifyProc(row: PsRow, rootPid: number, rootChild: boolean): TelemetryProcKind {
  if (row.pid === rootPid) return 'host'
  const text = `${row.comm} ${row.args}`.toLowerCase()
  if (/mcp|modelcontextprotocol/.test(text)) return 'mcp'
  if (/\bpi\b|pi-coding-agent|pi-subagents/.test(text)) return 'pi'
  // A shell the Host opened is its terminal pane. A shell a pi opened is that
  // lane's tool call — the lane's business, and `other` here.
  if (rootChild && SHELLS.test(row.comm.toLowerCase())) return 'shell'
  return 'other'
}

/** `/proc/meminfo` fields we trust. An absent field reads 0 rather than a guess. */
export function parseMemInfo(text: string): {
  cache: number
  swapTotal: number
  swapUsed: number
} {
  const kb = (key: string): number =>
    Number(text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1] ?? 0) * 1024
  return {
    cache: kb('Cached') + kb('Buffers') + kb('SReclaimable'),
    swapTotal: kb('SwapTotal'),
    swapUsed: Math.max(0, kb('SwapTotal') - kb('SwapFree')),
  }
}

/** macOS `sysctl -n vm.swapusage`: `total = 2048.00M  used = 312.25M  free = 1735.75M`. */
export function parseSwapUsage(text: string): { swapTotal: number; swapUsed: number } {
  const megas = (key: string): number =>
    Number(text.match(new RegExp(`${key}\\s*=\\s*([\\d.]+)M`, 'i'))?.[1] ?? 0) * 1024 * 1024
  return { swapTotal: megas('total'), swapUsed: megas('used') }
}

/** Executable basename, cleaned to a bare word. Never a path or argv. */
export function procLabel(row: PsRow): string {
  const name = basename(row.comm || row.args.split(' ')[0] || 'proc')
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._+-]/g, '')
    .slice(0, TELEMETRY_LIMITS.labelBytes)
}

function statfsBytes(path: string): Promise<{ total: number; free: number }> {
  return new Promise((resolve) => {
    statfs(path, (error, stats) =>
      resolve(
        error || !stats
          ? { total: 0, free: 0 }
          : { total: stats.blocks * stats.bsize, free: stats.bavail * stats.bsize },
      ),
    )
  })
}

async function memoryExtras(
  platform: NodeJS.Platform,
): Promise<{ cache: number; swapTotal: number; swapUsed: number }> {
  const none = { cache: 0, swapTotal: 0, swapUsed: 0 }
  try {
    if (platform === 'linux') return parseMemInfo(await readFile('/proc/meminfo', 'utf8'))
    if (platform === 'darwin') {
      const { stdout } = await run('sysctl', ['-n', 'vm.swapusage'], { timeout: READ_DEADLINE_MS })
      return { ...none, ...parseSwapUsage(stdout) }
    }
  } catch {
    /* Optional: `used` still comes from totalmem and freemem. */
  }
  return none
}

/** One `ps` pass, or an empty census when the binary is missing or too slow. */
async function psRows(): Promise<PsRow[]> {
  try {
    const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,rss=,time=,etimes=,comm=,args='], {
      timeout: READ_DEADLINE_MS,
      maxBuffer: PS_MAX_BYTES,
    })
    return parsePsRows(stdout)
  } catch {
    return []
  }
}

/**
 * The Host's subtree: the process itself, everything under it, and nothing
 * else. Kind totals cover the whole subtree even when `procs` is capped, so
 * "Phosphor is using 4.8G" stays true while the list stays bounded.
 */
export function census(
  rows: PsRow[],
  rootPid: number,
  machineUptimeSec: number,
): { procs: TelemetryProc[]; kinds: TelemetryKind[] } {
  const byParent = new Map<number, PsRow[]>()
  for (const row of rows) {
    const siblings = byParent.get(row.ppid)
    if (siblings) siblings.push(row)
    else byParent.set(row.ppid, [row])
  }
  const root = rows.find((r) => r.pid === rootPid)
  const found = new Map<number, PsRow & { kind: TelemetryProcKind }>()
  const pending: { row: PsRow; rootChild: boolean }[] = root
    ? [{ row: root, rootChild: false }]
    : []
  while (pending.length > 0) {
    const next = pending.pop()
    if (!next || found.has(next.row.pid)) continue
    const kind = classifyProc(next.row, rootPid, next.rootChild)
    found.set(next.row.pid, { ...next.row, kind })
    for (const child of byParent.get(next.row.pid) ?? []) {
      pending.push({ row: child, rootChild: next.row.pid === rootPid })
    }
  }
  const kinds = new Map<TelemetryProcKind, TelemetryKind>()
  for (const row of found.values()) {
    const kind = kinds.get(row.kind) ?? { kind: row.kind, procs: 0, cpuSec: 0, rss: 0 }
    kind.procs++
    kind.cpuSec += row.cpuSec
    kind.rss += row.rss
    kinds.set(row.kind, kind)
  }
  const procs = [...found.values()]
    .sort((a, b) => b.rss - a.rss)
    .slice(0, TELEMETRY_LIMITS.procs)
    .map((row) => ({
      pid: row.pid,
      ppid: row.ppid,
      kind: row.kind,
      label: procLabel(row),
      cpuSec: row.cpuSec,
      rss: row.rss,
      uptimeSec: Math.max(0, Math.min(row.elapsedSec, machineUptimeSec)),
    }))
  return { procs, kinds: [...kinds.values()] }
}

/** The Host's own subtree and the machine around it. Never rejects. */
export async function sampleTelemetry(sample: TelemetrySample): Promise<MachineTelemetry> {
  const platform = sample.platform ?? process.platform
  const cores = cpus()
  const machineUp = Math.round(uptime())
  const perCore = cores.map((core) => counters(core.times))
  const total = perCore.reduce(
    (sum, core) => ({ idle: sum.idle + core.idle, busy: sum.busy + core.busy }),
    { idle: 0, busy: 0 },
  )
  const free = freemem()
  const whole = totalmem()
  const extras = await memoryExtras(platform)
  const { procs, kinds } = census(await (sample.rows ?? psRows)(), process.pid, machineUp)
  const [one = 0, five = 0, fifteen = 0] = loadavg()
  return {
    at: Date.now(),
    uptimeSec: machineUp,
    load: [one, five, fifteen],
    cpu: { cores: cores.length, total, perCore },
    mem: {
      total: whole,
      free,
      used: Math.max(0, whole - free - extras.cache),
      cache: extras.cache,
      swapTotal: extras.swapTotal,
      swapUsed: extras.swapUsed,
    },
    disk: await statfsBytes(sample.home),
    kinds,
    procs,
  }
}

/**
 * Kernel CPU counters, as idle-plus-busy totals. The optional fields are
 * genuinely optional: some platforms omit a slice Node's types declare as
 * present, and a missing field must read as zero rather than poison the whole
 * counter with NaN.
 */
interface CoreTimes {
  idle: number
  user?: number
  nice?: number
  sys?: number
  irq?: number
  softirq?: number
}

function counters(times: CoreTimes): { idle: number; busy: number } {
  return {
    idle: times.idle,
    busy:
      (times.user ?? 0) +
      (times.nice ?? 0) +
      (times.sys ?? 0) +
      (times.irq ?? 0) +
      (times.softirq ?? 0),
  }
}
