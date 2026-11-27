import type { MachineTelemetry, TelemetryProc } from '@shared/host-protocol-telemetry'

type Channel = 'hosts:telemetry'

/**
 * Harness machine telemetry. The Host answers counters and keeps no state of its
 * own, so the mock does the same: every call advances the counters along a wave,
 * which is what gives the popover's percentages, graph and core bars something
 * to draw. Nothing here is a percentage.
 */
export const TELEMETRY_MOCK: ReadonlySet<string> = new Set<Channel>(['hosts:telemetry'])

const CORES = 8
const GIB = 1024 ** 3
const MiB = 1024 ** 2

let calls = 0

/** Test helper: a fresh machine, so a test's first sample is really its first. */
export function resetMockTelemetry(): void {
  calls = 0
}

export function mockTelemetryInvoke(_channel: string, args: unknown): MachineTelemetry {
  // Two machines in the harness differ by seed, so the switcher shows two hosts.
  const seed = [...String(args ?? '')].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 5
  const tick = calls++
  const perCore = Array.from({ length: CORES }, (_, core) => ({
    idle: 40_000 * (tick + 1) - busyFor(core, tick, seed),
    busy: busyFor(core, tick, seed),
  }))
  const used = Math.round((11 + 4 * wave(tick / 9 + seed)) * GIB)
  const cache = Math.round(3 * GIB)
  const total = 32 * GIB
  const kinds = (
    [
      ['pi', 4, 260, 640],
      ['mcp', 2, 40, 210],
      ['host', 1, 90, 180],
      ['shell', 2, 12, 24],
      ['other', 1, 4, 18],
    ] as const
  ).map(([kind, procs, base, rss]) => ({
    kind,
    procs,
    cpuSec: base + Math.round((tick * procs) / 2 + wave(tick / 5) * 4),
    rss: Math.round(rss * MiB * (1 + 0.15 * wave(tick / 7 + base))),
  }))
  return {
    at: Date.now(),
    uptimeSec: 3 * 86_400 + tick * 2,
    load: [1.1 + 2.2 * wave(tick / 8), 0.9 + wave(tick / 40), 0.7],
    cpu: { perCore },
    mem: {
      total,
      used,
      cache,
      free: Math.max(0, total - used - cache),
      swapTotal: 8 * GIB,
      swapUsed: Math.round((0.4 + 1.6 * wave(tick / 13)) * GIB),
    },
    // Shrinks a little each call, the way a working machine's volume does.
    disk: { total: 1000 * GIB, free: (420 - tick / 60) * GIB },
    census: { kinds, procs: procRows(tick, kinds) },
  }
}

/** The biggest rows of the census: what a person would go and look at. */
function procRows(
  tick: number,
  kinds: { kind: string; procs: number; cpuSec: number; rss: number }[],
): TelemetryProc[] {
  const rows = [
    { pid: 4100, ppid: 1, kind: 'host', label: 'phosphor-host', rss: 180 },
    { pid: 4210, ppid: 4100, kind: 'pi', label: 'pi', rss: 320 },
    { pid: 4211, ppid: 4210, kind: 'pi', label: 'pi', rss: 240 },
    { pid: 4320, ppid: 4210, kind: 'pi', label: 'pi', rss: 96 },
    { pid: 4400, ppid: 4100, kind: 'mcp', label: 'node', rss: 150 },
    { pid: 4401, ppid: 4100, kind: 'mcp', label: 'uv', rss: 60 },
    { pid: 4500, ppid: 1, kind: 'shell', label: 'bash', rss: 12 },
  ] as const
  return rows.map((row, index) => {
    const kind = kinds.find((entry) => entry.kind === row.kind)
    return {
      ...row,
      kind: row.kind as TelemetryProc['kind'],
      rss: Math.round(
        ((kind?.rss ?? 100 * MiB) / Math.max(1, kind?.procs ?? 1)) * (1 + index * 0.05),
      ),
      cpuSec: Math.round(
        ((kind?.cpuSec ?? 10) / Math.max(1, kind?.procs ?? 1)) * (1 + index * 0.02),
      ),
      uptimeSec: 600 + tick * 2 + index * 37,
    }
  })
}

/** A core's busy jiffies so far: one core runs hot, the rest idle. */
function busyFor(core: number, tick: number, seed: number): number {
  const share =
    core === (seed + Math.floor(tick / 6)) % CORES ? 0.75 : 0.12 + 0.2 * wave(tick / 3 + core)
  return Math.round(1_000 * (tick + 1) * Math.max(0.02, Math.min(0.95, share)))
}

/** -1…1, smoothly. Deterministic: the harness must not need a random seed. */
function wave(x: number): number {
  return Math.sin(x)
}
