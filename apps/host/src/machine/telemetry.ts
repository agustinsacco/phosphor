/**
 * One machine-wide telemetry sample, read from the kernel on demand.
 *
 * Nothing here runs on a timer: the client polls `machine.telemetry` while its
 * popover is open, so closing the popover stops the work. Every answer is
 * counters rather than rates (see `@phosphor/shared/host-protocol-telemetry`),
 * which is what lets the Host hold no sampler state to go stale.
 *
 * The process census is the Host's own subtree, taken with one `ps` pass. Its
 * full argv is read only to tell a lane's pi from a shell from an MCP server,
 * and is then thrown away — just argv[0]'s basename reaches a client. A `ps`
 * that fails or overflows answers a null census, never an empty one: "nothing
 * of ours is running" is a claim about the machine, and this code may only make
 * it when the machine said so.
 */
import { execFile } from 'node:child_process'
import { readFile, statfs } from 'node:fs/promises'
import { cpus, freemem, loadavg, totalmem, uptime } from 'node:os'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import {
  TELEMETRY_LIMITS,
  type MachineTelemetry,
  type TelemetryCensus,
  type TelemetryCounters,
  type TelemetryKind,
  type TelemetryProcKind,
} from '@phosphor/shared/host-protocol-telemetry'

const run = promisify(execFile)
/** Every read here is milliseconds of work; past this it is missing, not slow. */
const READ_DEADLINE_MS = 1_500
/** `ps` prints the whole system. Sized for a busy box's argv, not our 96 rows. */
const PS_MAX_BYTES = 8 * 1024 * 1024
/** Volume size and free space barely move; a 2 s poll must not be a syscall every time. */
const DISK_TTL_MS = 60_000
const SHELLS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh', 'tmux', 'screen'])
/** pi runs as `pi`, `pi-coding-agent` or `pi-subagents`, directly or under a runner. */
const PI_NAMES = new Set(['pi', 'pi-coding-agent', 'pi-subagents'])
/** Only for these does the argument name the program; otherwise it names a file. */
const RUNNERS = new Set(['node', 'nodejs', 'deno', 'bun', 'npx', 'uv', 'uvx', 'python', 'python3'])

export interface TelemetrySample {
  /** The volume to measure: the Host's home folder sits on its state volume. */
  home: string
  platform?: NodeJS.Platform
  /** Test seams. Defaults to one real `ps` pass and the real clock. */
  rows?: () => Promise<PsRow[] | null>
  now?: () => number
}

/** One line of `ps`, with the fields the census needs and nothing else. */
export interface PsRow {
  pid: number
  ppid: number
  rss: number
  cpuSec: number
  elapsedSec: number
  /** argv[0]: how it was launched. */
  argv0: string
  /** The first non-option argument: the script or module it is running. */
  target: string
}

/** `00:01.02`, `1:02:03` or `1-02:03:04` as seconds. */
export function parseCpuTime(value: string): number {
  const daySplit = value.match(/^(\d+)-(.+)$/)
  const parts = (daySplit?.[2] ?? value).split(':').map(Number)
  if (parts.some((n) => !Number.isFinite(n))) return 0
  const seconds = parts.reduce((total, part) => total * 60 + part, 0)
  return seconds + (Number(daySplit?.[1]) || 0) * 86_400
}

/**
 * `pid ppid rss time etimes args`. `comm` is deliberately not read: Linux lets
 * it hold spaces (`Web Content`), which would shift every column after it and
 * silently drop that row and its whole subtree, and argv[0] says the same thing
 * truthfully. `args` is last and takes the rest of the line.
 */
export function parsePsRows(out: string): PsRow[] {
  const rows: PsRow[] = []
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/)
    if (!m?.[1]) continue
    const argv = (m[6] ?? '').split(' ').filter((part) => part !== '')
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2] ?? 0),
      rss: Number(m[3] ?? 0) * 1024,
      cpuSec: parseCpuTime(m[4] ?? ''),
      elapsedSec: Number(m[5] ?? 0),
      argv0: argv[0] ?? '',
      target: argv.slice(1).find((part) => !part.startsWith('-')) ?? '',
    })
  }
  return rows
}

/**
 * What a process is, from how it was launched. argv[0] decides, plus the named
 * script when argv[0] is a runner. The rest of the command line never decides:
 * matching it would call a lane's `grep -r mcp src/` an MCP server, and that
 * count is shown to every client that can see this machine.
 */
export function classifyProc(row: PsRow, rootPid: number, rootChild: boolean): TelemetryProcKind {
  if (row.pid === rootPid) return 'host'
  const launched = clean(row.argv0)
  // A runner's first argument names the program; anyone else's names a file.
  const script = RUNNERS.has(launched) ? (row.target || '').toLowerCase() : ''
  if (isMcp(launched) || isMcp(script)) return 'mcp'
  if (PI_NAMES.has(launched) || runsPi(script)) return 'pi'
  // A shell the Host opened is its terminal pane. A shell a pi opened is that
  // lane's tool call — the lane's business, and `other` here.
  if (rootChild && SHELLS.has(launched)) return 'shell'
  return 'other'
}

const clean = (value: string): string => basename(value || '').toLowerCase()
const isMcp = (name: string): boolean =>
  name.includes('mcp') || name.includes('modelcontextprotocol')
/** `/opt/pi-subagents/run.js` is pi-subagents even though it runs `run.js`. */
const runsPi = (script: string): boolean =>
  script.split('/').some((part) => PI_NAMES.has(part.replace(/\.js$/, '')))

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
  const name = clean(row.argv0) || 'proc'
  return name.replace(/[^a-z0-9._+-]/g, '').slice(0, TELEMETRY_LIMITS.labelBytes)
}

let volume: { at: number; value: MachineTelemetry['disk'] } | null = null

/**
 * The state volume's size and free space. The one cached number here, because
 * the answer barely moves and a hung home mount must not take the reply — nor a
 * threadpool slot — down with it every two seconds. Null means it could not be
 * read, which the wire keeps distinct from a full or empty disk.
 */
async function readDisk(home: string, at: number): Promise<MachineTelemetry['disk']> {
  if (volume && at - volume.at < DISK_TTL_MS) return volume.value
  let value: MachineTelemetry['disk'] = null
  try {
    const stats = await Promise.race([statfs(home), timeout(READ_DEADLINE_MS)])
    if (stats && stats.blocks > 0)
      value = { total: stats.blocks * stats.bsize, free: stats.bavail * stats.bsize }
  } catch {
    /* Null below: unreadable is not zero. */
  }
  volume = { at, value }
  return value
}

function timeout(ms: number): Promise<null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    timer.unref?.()
  })
}

/**
 * The memory Node does not report: reclaimable cache and swap. Linux gives both
 * in one `/proc/meminfo` read; macOS reports only swap, and its `vm_stat` cost
 * three processes per sample for a number that still disagrees with Activity
 * Monitor, so `cache` stays 0 there and `used` therefore includes file cache.
 */
async function memoryExtras(platform: NodeJS.Platform): Promise<{
  cache: number
  swapTotal: number
  swapUsed: number
}> {
  const none = { cache: 0, swapTotal: 0, swapUsed: 0 }
  try {
    if (platform === 'linux') return parseMemInfo(await readFile('/proc/meminfo', 'utf8'))
    if (platform === 'darwin')
      return {
        cache: 0,
        ...parseSwapUsage(
          (await run('sysctl', ['-n', 'vm.swapusage'], { timeout: READ_DEADLINE_MS })).stdout,
        ),
      }
  } catch {
    /* Optional: `used` still comes from totalmem and freemem. */
  }
  return none
}

/** One `ps` pass, or null when `ps` is missing, slow or bigger than we can hold. */
async function psRows(): Promise<PsRow[] | null> {
  try {
    const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,rss=,time=,etimes=,args='], {
      timeout: READ_DEADLINE_MS,
      maxBuffer: PS_MAX_BYTES,
    })
    return parsePsRows(stdout)
  } catch {
    return null
  }
}

/**
 * The Host's subtree: the process itself, everything under it, and nothing
 * else. Kind totals cover the whole subtree even when `procs` is capped, so
 * "Phosphor is using 4.8G" stays true while the list stays bounded.
 */
export function census(rows: PsRow[], rootPid: number, machineUptimeSec: number): TelemetryCensus {
  const byParent = new Map<number, PsRow[]>()
  for (const row of rows) {
    const siblings = byParent.get(row.ppid)
    if (siblings) siblings.push(row)
    else byParent.set(row.ppid, [row])
  }
  const found = new Map<number, PsRow & { kind: TelemetryProcKind }>()
  const root = rows.find((row) => row.pid === rootPid)
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
  const at = (sample.now ?? Date.now)()
  const perCore = cpus()
    .slice(0, TELEMETRY_LIMITS.cores)
    .map((core) => coreCounters(core.times))
  const machineUp = Math.round(uptime())
  const free = freemem()
  const whole = totalmem()
  const extras = await memoryExtras(platform)
  const rows = await (sample.rows ?? psRows)()
  const [one = 0, five = 0, fifteen = 0] = loadavg()
  return {
    at,
    uptimeSec: machineUp,
    load: [one, five, fifteen],
    cpu: { perCore },
    mem: {
      total: whole,
      free,
      used: Math.max(0, whole - free - extras.cache),
      cache: extras.cache,
      swapTotal: extras.swapTotal,
      swapUsed: extras.swapUsed,
    },
    disk: await readDisk(sample.home, at),
    census: rows === null ? null : census(rows, process.pid, machineUp),
  }
}

/**
 * Kernel CPU counters, as idle-plus-busy totals. The optional fields are
 * genuinely optional: Linux omits `softirq` that Node's types declare present,
 * and a missing slice must read as zero rather than poison the counter with
 * NaN, which the wire would then refuse.
 */
interface CoreTimes {
  idle: number
  user?: number
  nice?: number
  sys?: number
  irq?: number
  softirq?: number
}

export function coreCounters(times: CoreTimes): TelemetryCounters {
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
