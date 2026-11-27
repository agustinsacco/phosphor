import { describe, expect, it } from 'vitest'
import { telemetryReadout } from './machine-telemetry'
import type { MachineTelemetry } from '@phosphor/shared/host-protocol-telemetry'

const GIB = 1 << 30
const MiB = 1 << 20

function sample(over: Partial<MachineTelemetry> = {}): MachineTelemetry {
  return {
    at: 1_700_000_000_000,
    uptimeSec: 4 * 86_400 + 6 * 3_600,
    load: [1.5, 1.2, 1],
    cpu: {
      perCore: [
        { idle: 1000, busy: 1000 },
        { idle: 1000, busy: 1000 },
        { idle: 1000, busy: 1000 },
        { idle: 1000, busy: 1000 },
      ],
    },
    mem: {
      total: 16 * GIB,
      free: 4 * GIB,
      used: 10 * GIB,
      cache: 2 * GIB,
      swapTotal: 2 * GIB,
      swapUsed: GIB / 2,
    },
    disk: { total: 1000 * GIB, free: 400 * GIB },
    census: {
      kinds: [
        { kind: 'pi', procs: 4, cpuSec: 40, rss: 2 * GIB },
        { kind: 'mcp', procs: 2, cpuSec: 4, rss: 300 * MiB },
        { kind: 'host', procs: 1, cpuSec: 10, rss: 200 * MiB },
      ],
      procs: [],
    },
    ...over,
  }
}

/** Counters advanced by the same idle and busy amount: half the machine busy. */
const moved = (): MachineTelemetry => {
  const first = sample()
  return {
    ...first,
    cpu: {
      perCore: first.cpu.perCore.map((core) => ({ idle: core.idle + 10, busy: core.busy + 10 })),
    },
    census: {
      kinds: first.census?.kinds.map((kind) => ({ ...kind, cpuSec: kind.cpuSec + 1 })) ?? [],
      procs: [],
    },
  }
}

describe('the machine.telemetry op readout', () => {
  it('says what the machine and Phosphor are doing', () => {
    const text = telemetryReadout(sample(), moved())
    expect(text).toContain('CPU 50% across 4 cores')
    expect(text).toContain('load 1.50 1.20 1.00')
    expect(text).toContain('up 4d 6h')
    expect(text).toContain('Memory 10.0G of 16.0G used')
    expect(text).toContain('swap 512M of 2.0G')
    expect(text).toContain('Disk 400.0G free of 1000.0G')
    // 7 processes, 2.5G of them, and the census listed biggest-count first.
    expect(text).toContain('Phosphor 7 processes, 2.5G resident')
    expect(text).toContain('4 pi, 2 mcp, 1 host')
  })

  it('measures Phosphor over the same window as the machine', () => {
    // 1 cpu-second across the 250 ms window on 4 cores is 400% of one core, and
    // the ceiling is the machine's, not 100%.
    expect(telemetryReadout(sample(), moved())).toContain('400% of one core')
  })

  it('says what it could not read instead of inventing a zero', () => {
    const text = telemetryReadout(
      sample({ cpu: { perCore: [{ idle: 1, busy: 1 }] } }),
      sample({ cpu: { perCore: [{ idle: 1, busy: 1 }] }, disk: null, census: null }),
    )
    expect(text).toContain('CPU measuring across 1 cores')
    expect(text).toContain('Disk could not be read')
    expect(text).toContain("Phosphor's processes could not be read")
  })

  it('leaves swap out when the machine has none', () => {
    const none = sample({
      mem: { total: 8 * GIB, free: 4 * GIB, used: 4 * GIB, cache: 0, swapTotal: 0, swapUsed: 0 },
    })
    expect(telemetryReadout(none, none)).not.toContain('swap')
  })
})
