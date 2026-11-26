import { describe, expect, it } from 'vitest'
import { TELEMETRY_LIMITS, parseMachineTelemetry } from '@phosphor/shared/host-protocol-telemetry'
import {
  census,
  classifyProc,
  parseCpuTime,
  parseMemInfo,
  parsePsRows,
  parseSwapUsage,
  procLabel,
  sampleTelemetry,
  type PsRow,
} from './telemetry'

function row(over: Partial<PsRow> & { pid: number; ppid: number }): PsRow {
  return {
    rss: 1000,
    cpuSec: 1,
    elapsedSec: 60,
    comm: 'node',
    args: '/usr/local/bin/node something',
    ...over,
  }
}

describe('ps output', () => {
  it('parses the census line format', () => {
    const rows = parsePsRows(
      [
        '  100     1  50000 00:02.50 3600 phosphor-host /usr/bin/phosphor-host --service',
        '  101   100  90000 01:02:03 7200 node /usr/local/bin/pi --mode rpc',
        'junk line without numbers',
        '  102   101     0 1-02:03:04 90000 npx @modelcontextprotocol/server-fs',
      ].join('\n'),
    )
    expect(rows.map((r) => r.pid)).toEqual([100, 101, 102])
    expect(rows[0]).toMatchObject({ ppid: 1, rss: 50000 * 1024, cpuSec: 2.5, elapsedSec: 3600 })
    expect(rows[1]?.cpuSec).toBe(3723)
    expect(rows[2]?.comm).toBe('npx')
  })

  it('reads cpu time in each shape ps uses', () => {
    expect(parseCpuTime('00:01.02')).toBeCloseTo(1.02, 6)
    expect(parseCpuTime('01:02:03')).toBe(3723)
    expect(parseCpuTime('1-02:03:04')).toBe(93_784)
    expect(parseCpuTime('nonsense')).toBe(0)
  })

  it('labels a process by its executable, never its path', () => {
    expect(procLabel(row({ pid: 1, ppid: 0, comm: 'node' }))).toBe('node')
    expect(procLabel(row({ pid: 1, ppid: 0, comm: '', args: '/opt/bin/pi --mode rpc' }))).toBe('pi')
    expect(procLabel(row({ pid: 1, ppid: 0, comm: 'x'.repeat(200) }))).toHaveLength(
      TELEMETRY_LIMITS.labelBytes,
    )
  })
})

describe('process kinds', () => {
  const kind = (over: Partial<PsRow> & { pid: number; ppid: number }, rootChild = false) =>
    classifyProc(row(over), 100, rootChild)

  it('separates the Host, its lanes and its MCP servers', () => {
    expect(kind({ pid: 100, ppid: 1 })).toBe('host')
    expect(kind({ pid: 200, ppid: 100, args: '/usr/local/bin/pi --mode rpc' })).toBe('pi')
    expect(kind({ pid: 201, ppid: 100, args: 'npx @earendil-works/pi-coding-agent' })).toBe('pi')
    expect(kind({ pid: 202, ppid: 100, args: 'npx @modelcontextprotocol/server-fs' })).toBe('mcp')
    expect(kind({ pid: 203, ppid: 100, comm: 'bash' }, true)).toBe('shell')
    expect(kind({ pid: 204, ppid: 101, comm: 'bash' }, false)).toBe('other')
    expect(kind({ pid: 205, ppid: 100, comm: 'node', args: 'worker.js' })).toBe('other')
  })
})

describe('census', () => {
  it('keeps the Host subtree and nothing else', () => {
    const { procs, kinds } = census(
      [
        row({ pid: 100, ppid: 1 }),
        row({ pid: 101, ppid: 100, args: 'pi --mode rpc' }),
        row({ pid: 102, ppid: 101, args: 'git status' }),
        row({ pid: 999, ppid: 1, args: 'postgres' }),
      ],
      100,
      500,
    )
    expect(procs.map((p) => p.pid).sort()).toEqual([100, 101, 102])
    expect(procs.find((p) => p.pid === 100)?.kind).toBe('host')
    expect(procs.find((p) => p.pid === 100)?.label).toBe('node')
    expect(kinds.find((k) => k.kind === 'pi')?.procs).toBe(1)
    expect(kinds.find((k) => k.kind === 'other')?.procs).toBe(1)
  })

  it('clamps a child older than the machine', () => {
    const { procs } = census(
      [row({ pid: 100, ppid: 1, elapsedSec: 900 }), row({ pid: 101, ppid: 100, elapsedSec: 4000 })],
      100,
      900,
    )
    expect(procs.find((p) => p.pid === 101)?.uptimeSec).toBe(900)
  })

  it('totals every process it saw while capping the list it sends', () => {
    const crowd = [row({ pid: 100, ppid: 1, rss: 10 })]
    const children = TELEMETRY_LIMITS.procs + 4
    for (let pid = 1; pid <= children; pid++) {
      crowd.push(row({ pid: 500 + pid, ppid: 100, rss: pid * 100 }))
    }
    const { procs, kinds } = census(crowd, 100, 500)
    expect(procs).toHaveLength(TELEMETRY_LIMITS.procs)
    expect(procs[0]?.pid).toBe(500 + children)
    expect(kinds.find((k) => k.kind === 'other')?.procs).toBe(children)
    expect(kinds.reduce((sum, kind) => sum + kind.procs, 0)).toBe(children + 1)
  })

  it('is empty when the root is not in the list', () => {
    expect(census([row({ pid: 7, ppid: 1 })], 100, 500)).toEqual({ procs: [], kinds: [] })
  })
})

describe('memory files', () => {
  it('reads the fields it trusts from /proc/meminfo', () => {
    expect(
      parseMemInfo(
        [
          'MemTotal: 32000000 kB',
          'MemFree: 1000 kB',
          'Buffers: 2000 kB',
          'Cached: 3000 kB',
          'SReclaimable: 500 kB',
          'SwapTotal: 8000 kB',
          'SwapFree: 6000 kB',
        ].join('\n'),
      ),
    ).toEqual({ cache: 5_500 * 1024, swapTotal: 8_000 * 1024, swapUsed: 2_000 * 1024 })
  })

  it('reads macOS swap usage', () => {
    expect(parseSwapUsage('total = 2048.00M  used = 312.25M  free = 1735.75M')).toEqual({
      swapTotal: 2048 * 1024 * 1024,
      swapUsed: 312.25 * 1024 * 1024,
    })
    expect(parseSwapUsage('')).toEqual({ swapTotal: 0, swapUsed: 0 })
  })
})

describe('sampleTelemetry', () => {
  it('answers with a sample a client will accept, and no argv', async () => {
    const sample = await sampleTelemetry({
      home: process.cwd(),
      rows: async () => [
        row({ pid: process.pid, ppid: 1 }),
        row({ pid: process.pid + 1, ppid: process.pid, args: 'pi --mode rpc', comm: 'pi' }),
      ],
    })
    expect(parseMachineTelemetry(sample)).not.toBeNull()
    expect(sample.load).toHaveLength(3)
    expect(sample.cpu.perCore).toHaveLength(sample.cpu.cores)
    expect(sample.cpu.perCore.every((c) => c.idle > 0)).toBe(true)
    expect(sample.mem.used).toBeLessThan(sample.mem.total)
    expect(sample.disk.total).toBeGreaterThan(0)
    expect(sample.kinds.find((k) => k.kind === 'pi')?.procs).toBe(1)
    expect(JSON.stringify(sample)).not.toContain('--mode')
    expect(JSON.stringify(sample)).not.toContain(process.cwd())
  })
})
