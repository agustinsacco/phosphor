import { describe, expect, it } from 'vitest'
import { parseMachineTelemetry } from '@phosphor/shared/host-protocol-telemetry'
import {
  census,
  coreCounters,
  classifyProc,
  parseCpuTime,
  parseMemInfo,
  parsePsRows,
  parseSwapUsage,
  procLabel,
  sampleTelemetry,
  type PsRow,
} from './telemetry'

const row = (over: Partial<PsRow> = {}): PsRow => ({
  pid: 10,
  ppid: 1,
  rss: 1024,
  cpuSec: 5,
  elapsedSec: 60,
  argv0: 'pi',
  target: '',
  ...over,
})

describe('the ps census', () => {
  it('reads a ps line into the fields the census needs', () => {
    const [head, ...rest] = parsePsRows(
      '  42   1  2048 00:01.02 90 /usr/local/bin/pi --mode rpc --session /home/bee2/s.jsonl\n' +
        'garbage line\n' +
        '43 42 512 0:02.00 80 node /opt/mcp/server-fs/index.js\n',
    )
    expect(head?.pid).toBe(42)
    expect(head?.ppid).toBe(1)
    // ps reports RSS in kilobytes; the wire is bytes.
    expect(head?.rss).toBe(2048 * 1024)
    expect(head?.cpuSec).toBeCloseTo(1.02, 6)
    expect(head?.elapsedSec).toBe(90)
    expect(head?.argv0).toBe('/usr/local/bin/pi')
    // Options are skipped, so this is `rpc` rather than the script. Harmless: only a
    // runner's first argument is read as a program name, and `pi` is not one.
    expect(head?.target).toBe('rpc')
    expect(rest[0]?.target).toBe('/opt/mcp/server-fs/index.js')
    expect(parsePsRows('no numbers here')).toEqual([])
  })

  it('reads each ps time shape, including a run longer than a day', () => {
    expect(parseCpuTime('00:01.02')).toBeCloseTo(1.02, 6)
    expect(parseCpuTime('1:02:03')).toBe(3723)
    expect(parseCpuTime('1-02:03:04')).toBe(93784)
    expect(parseCpuTime('')).toBe(0)
  })

  it('reads a label as a bare name, never a path or argv', () => {
    expect(procLabel(row({ argv0: '/usr/local/bin/pi' }))).toBe('pi')
    expect(procLabel(row({ argv0: '/usr/bin/python3.11' }))).toBe('python3.11')
    expect(procLabel(row({ argv0: '/opt/Google Chrome Helper' }))).toBe('googlechromehelper')
    expect(procLabel(row({ argv0: '' }))).toBe('proc')
    expect(procLabel(row({ argv0: 'x'.repeat(300) })).length).toBeLessThanOrEqual(48)
  })

  it('names a process by argv[0], and by its script only when a runner launched it', () => {
    expect(classifyProc(row({ pid: 1 }), 1, false)).toBe('host')
    expect(classifyProc(row({ argv0: '/usr/local/bin/pi' }), 1, true)).toBe('pi')
    expect(classifyProc(row({ argv0: 'node', target: '/usr/local/bin/pi' }), 1, true)).toBe('pi')
    expect(classifyProc(row({ argv0: 'node', target: '/opt/pi-subagents/run.js' }), 1, true)).toBe(
      'pi',
    )
    expect(classifyProc(row({ argv0: 'node', target: '/opt/mcp/fs.js' }), 1, true)).toBe('mcp')
    // A shell under the Host is its terminal pane; a shell a lane opened is that
    // lane's tool call, and `other` here.
    expect(classifyProc(row({ argv0: '/usr/bin/bash' }), 1, true)).toBe('shell')
    expect(classifyProc(row({ argv0: 'bash' }), 1, false)).toBe('other')
    // The rest of a command line never decides what a process is.
    expect(classifyProc(row({ argv0: 'grep', target: 'mcp' }), 1, false)).toBe('other')
    expect(classifyProc(row({ argv0: 'cat', target: 'pi.jsonl' }), 1, false)).toBe('other')
    expect(classifyProc(row({ argv0: '/usr/bin/pnpm' }), 1, false)).toBe('other')
  })

  it('walks the Host subtree alone, not the whole process table', () => {
    const taken = census(
      [
        row({ pid: 1, ppid: 0, argv0: 'systemd' }),
        row({ pid: 2, ppid: 0, argv0: 'kthreadd' }),
        row({ pid: 100, ppid: 1, argv0: '/usr/bin/pi' }),
        row({ pid: 101, ppid: 100, argv0: 'node', target: '/opt/mcp/fs.js' }),
        row({ pid: 999, ppid: 2, argv0: 'sshd' }),
      ],
      1,
      1000,
    )
    expect(taken.procs.map((p) => p.pid).sort((a, b) => a - b)).toEqual([1, 100, 101])
    expect(taken.kinds.find((k) => k.kind === 'host')?.procs).toBe(1)
    expect(taken.kinds.find((k) => k.kind === 'pi')?.procs).toBe(1)
    expect(taken.kinds.find((k) => k.kind === 'mcp')?.procs).toBe(1)
    // A Host whose pid is not in the table yields an empty census, not a crash.
    expect(census([row({ pid: 7 })], 1, 100).procs).toEqual([])
  })

  it('totals every process it walked even when it returns the cap', () => {
    const many = Array.from({ length: 120 }, (_, index) =>
      row({ pid: 10 + index, ppid: 1, rss: (120 - index) * 1024 }),
    )
    const taken = census([row({ pid: 1, ppid: 0, rss: 10 }), ...many], 1, 1000)
    expect(taken.procs.length).toBe(96)
    expect(taken.kinds.reduce((sum, kind) => sum + kind.procs, 0)).toBe(121)
    // The tree is reported biggest-holder first.
    expect(taken.procs[0]?.rss).toBe(120 * 1024)
  })

  it('clips a child older than the machine, which a restored process can be', () => {
    const taken = census(
      [row({ pid: 1, ppid: 0 }), row({ pid: 2, ppid: 1, elapsedSec: 9999 })],
      1,
      10,
    )
    expect(taken.procs.map((p) => p.uptimeSec)).toEqual([10, 10])
  })
})

describe('memory that Node does not report', () => {
  it('takes the reclaimable pages and swap out of /proc/meminfo', () => {
    expect(
      parseMemInfo(['MemTotal: 16384 kB', 'Buffers: 100 kB', 'Cached: 200 kB'].join('\n')),
    ).toEqual({ cache: 300 * 1024, swapTotal: 0, swapUsed: 0 })
    expect(
      parseMemInfo(
        ['SwapTotal: 2048 kB', 'SwapFree: 512 kB', 'SReclaimable: 64 kB', 'MemTotal: 8 kB'].join(
          '\n',
        ),
      ),
    ).toEqual({ cache: 64 * 1024, swapTotal: 2048 * 1024, swapUsed: 1536 * 1024 })
    expect(parseMemInfo('')).toEqual({ cache: 0, swapTotal: 0, swapUsed: 0 })
  })

  it('reads macOS swap', () => {
    expect(parseSwapUsage('total = 2048.00M  used = 312.50M  free = 1735.50M')).toEqual({
      swapTotal: 2048 * 1024 * 1024,
      swapUsed: 312.5 * 1024 * 1024,
    })
    expect(parseSwapUsage('total = 0.00M  used = 0.00M  free = 0.00M')).toEqual({
      swapTotal: 0,
      swapUsed: 0,
    })
  })
})

describe('cpu counters', () => {
  it('counts an optional cpu slice a platform leaves out as zero, not as NaN', () => {
    // Node's types declare these present; Linux has not reported `softirq` since 2.6.36.
    expect(coreCounters({ idle: 100 })).toEqual({ idle: 100, busy: 0 })
    expect(coreCounters({ idle: 100, user: 5, sys: 2.5 })).toEqual({ idle: 100, busy: 7.5 })
    expect(coreCounters({ idle: 0, nice: 1, irq: 1, softirq: 1 }).busy).toBe(3)
  })
})

describe('sampleTelemetry', () => {
  it('answers with the whole machine and parses as the contract says it must', async () => {
    const sample = await sampleTelemetry({
      home: process.cwd(),
      now: () => 1_700_000_000_000,
      rows: async () => [row({ pid: process.pid, ppid: 1, argv0: 'node' })],
    })
    expect(sample.cpu.perCore.length).toBeGreaterThan(0)
    expect(sample.census?.kinds.find((k) => k.kind === 'host')?.procs).toBe(1)
    expect(sample.at).toBe(1_700_000_000_000)
    expect(parseMachineTelemetry(sample)).not.toBeNull()
  })

  it('answers with a null census when ps fails, and still reports the machine', async () => {
    const sample = await sampleTelemetry({
      home: process.cwd(),
      now: () => 1_700_000_001_000,
      rows: async () => null,
    })
    expect(sample.census).toBeNull()
    expect(sample.cpu.perCore.length).toBeGreaterThan(0)
    expect(parseMachineTelemetry(sample)).not.toBeNull()
  })
})
