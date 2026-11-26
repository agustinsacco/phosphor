import { describe, expect, it } from 'vitest'
import {
  TELEMETRY_LIMITS,
  counterDeltaPct,
  parseMachineTelemetry,
  procDeltaPct,
} from './host-protocol-telemetry'

const counters = (idle: number, busy: number) => ({ idle, busy })

function wire(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    at: 1_700_000_000_000,
    uptimeSec: 4_000_000,
    load: [1.5, 1.2, 1],
    cpu: { cores: 2, total: counters(100, 40), perCore: [counters(50, 20), counters(50, 20)] },
    mem: { total: 1000, free: 200, used: 600, cache: 200, swapTotal: 0, swapUsed: 0 },
    disk: { total: 5000, free: 1100 },
    kinds: [{ kind: 'pi', procs: 2, cpuSec: 12, rss: 800 }],
    procs: [{ pid: 10, ppid: 1, kind: 'pi', label: 'pi', cpuSec: 12, rss: 800, uptimeSec: 90 }],
    ...over,
  }
}

describe('machine telemetry wire', () => {
  it('accepts a full sample and projects only reviewed fields', () => {
    const parsed = parseMachineTelemetry(wire({ evil: '/home/bee2/.ssh' }))
    expect(parsed).not.toBeNull()
    expect(parsed?.cpu.perCore).toEqual([counters(50, 20), counters(50, 20)])
    expect(parsed?.procs[0]?.label).toBe('pi')
    expect(Object.keys(parsed ?? {})).not.toContain('evil')
    expect(JSON.stringify(parsed)).not.toContain('bee2')
  })

  it('refuses a sample that is not shaped like one', () => {
    for (const bad of [
      null,
      [],
      wire({ load: [1, 2] }),
      wire({ load: [1, 2, -1] }),
      wire({ uptimeSec: -5 }),
      wire({ cpu: { cores: 2, total: counters(1, 1), perCore: [counters(1, 1)] } }),
      wire({ cpu: { cores: 0, total: counters(1, 1), perCore: [] } }),
      wire({ cpu: { cores: 65, total: counters(1, 1), perCore: Array(65).fill(counters(1, 1)) } }),
      wire({ mem: { total: -1, free: 1 } }),
      wire({ kinds: [{ kind: 'kernel', procs: 1, cpuSec: 0, rss: 0 }] }),
      wire({
        procs: [{ pid: 0, ppid: 0, kind: 'pi', label: 'pi', cpuSec: 0, rss: 0, uptimeSec: 0 }],
      }),
      wire({
        procs: [
          { pid: 1, ppid: 0, kind: 'pi', label: 'x'.repeat(500), cpuSec: 0, rss: 0, uptimeSec: 0 },
        ],
      }),
    ])
      expect(parseMachineTelemetry(bad)).toBeNull()
  })

  it('refuses a process list past its cap', () => {
    const procs = Array.from({ length: TELEMETRY_LIMITS.procs + 1 }, (_, i) => ({
      pid: i + 1,
      ppid: 0,
      kind: 'other',
      label: 'x',
      cpuSec: 0,
      rss: 0,
      uptimeSec: 0,
    }))
    expect(parseMachineTelemetry(wire({ procs }))).toBeNull()
  })

  it('defaults the memory extras a Host may not report', () => {
    const parsed = parseMachineTelemetry(wire({ mem: { total: 1000, free: 200 } }))
    expect(parsed?.mem).toEqual({
      total: 1000,
      free: 200,
      used: 0,
      cache: 0,
      swapTotal: 0,
      swapUsed: 0,
    })
  })

  it('turns counter pairs into percents, and refuses impossible ones', () => {
    expect(counterDeltaPct(counters(100, 0), counters(100, 30))).toBe(100)
    expect(counterDeltaPct(counters(100, 0), counters(130, 30))).toBe(50)
    expect(counterDeltaPct(counters(100, 40), counters(100, 40))).toBeNull()
    expect(counterDeltaPct(counters(100, 40), counters(90, 40))).toBeNull()
  })

  it('scales a process to the cores it used, and drops a counter that went back', () => {
    expect(procDeltaPct(1, 2, 2, 4)).toBeCloseTo(50, 6)
    expect(procDeltaPct(1, 9, 2, 4)).toBe(400)
    expect(procDeltaPct(5, 4, 2, 4)).toBeNull()
    expect(procDeltaPct(1, 2, 0, 4)).toBeNull()
  })
})
