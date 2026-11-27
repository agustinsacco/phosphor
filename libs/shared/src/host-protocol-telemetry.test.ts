import { describe, expect, it } from 'vitest'
import {
  TELEMETRY_LIMITS,
  counterDeltaPct,
  parseMachineTelemetry,
  procDeltaPct,
  sumCounters,
} from './host-protocol-telemetry'

const counters = (idle: number, busy: number) => ({ idle, busy })
const proc = (over: Record<string, unknown> = {}) => ({
  pid: 10,
  ppid: 1,
  kind: 'pi',
  label: 'pi',
  cpuSec: 12,
  rss: 800,
  uptimeSec: 90,
  ...over,
})
const census = (over: Record<string, unknown> = {}) => ({
  kinds: [{ kind: 'pi', procs: 2, cpuSec: 12, rss: 800 }],
  procs: [proc()],
  ...over,
})

function wire(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    at: 1_700_000_000_000,
    uptimeSec: 4_000_000,
    load: [1.5, 1.2, 1],
    cpu: { perCore: [counters(50, 20), counters(50, 20)] },
    mem: { total: 1000, free: 200, used: 600, cache: 200, swapTotal: 0, swapUsed: 0 },
    disk: { total: 5000, free: 1100 },
    census: census(),
    ...over,
  }
}

describe('machine telemetry wire', () => {
  it('accepts a full sample and projects only reviewed fields', () => {
    const parsed = parseMachineTelemetry(wire({ evil: '/home/bee2/.ssh' }))
    expect(parsed).not.toBeNull()
    expect(parsed?.cpu.perCore).toEqual([counters(50, 20), counters(50, 20)])
    expect(parsed?.census?.procs[0]?.label).toBe('pi')
    expect(Object.keys(parsed ?? {})).not.toContain('evil')
    expect(JSON.stringify(parsed)).not.toContain('bee2')
  })

  it('keeps an unreadable volume and an unreadable census distinct from zero', () => {
    const parsed = parseMachineTelemetry(wire({ disk: null, census: null }))
    expect(parsed?.disk).toBeNull()
    expect(parsed?.census).toBeNull()
    expect(parseMachineTelemetry(wire({ disk: { total: 0, free: 0 } }))).toBeNull()
    expect(parseMachineTelemetry(wire({ census: { kinds: [], procs: [] } }))).not.toBeNull()
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

  it('refuses a sample that is not shaped like one', () => {
    const crowd = Array.from({ length: TELEMETRY_LIMITS.procs + 1 }, () => proc())
    for (const bad of [
      null,
      [],
      wire({ load: [1, 2] }),
      wire({ load: [1, 2, -1] }),
      wire({ uptimeSec: -5 }),
      wire({ cpu: {} }),
      wire({ cpu: { perCore: [] } }),
      wire({ cpu: { perCore: Array(TELEMETRY_LIMITS.cores + 1).fill(counters(1, 1)) } }),
      wire({ cpu: { perCore: [{ idle: 1, busy: Number.NaN }] } }),
      wire({ mem: { total: 0, free: 0 } }),
      wire({ mem: { total: 1000, free: 200, used: 1e13 } }),
      wire({ disk: { total: 5000 } }),
      wire({ disk: { total: 5000, free: 9000 } }),
      wire({ mem: { total: 1000, free: 200, swapTotal: 10, swapUsed: 20 } }),
      wire({ census: { kinds: [{ kind: 'kernel', procs: 1, cpuSec: 0, rss: 0 }], procs: [] } }),
      wire({ census: { kinds: [], procs: crowd } }),
      wire({
        census: {
          kinds: [
            { kind: 'pi', procs: 1, cpuSec: 0, rss: 0 },
            { kind: 'pi', procs: 1, cpuSec: 0, rss: 0 },
          ],
          procs: [],
        },
      }),
      wire({ census: { kinds: [{ kind: 'pi', procs: 0, cpuSec: 0, rss: 0 }], procs: [] } }),
      wire({ census: { kinds: [], procs: [proc({ pid: 0 })] } }),
      wire({ census: { kinds: [], procs: [proc({ kind: 'worker' })] } }),
      wire({ census: { kinds: [], procs: [proc({ label: 'Google Chrome Helper' })] } }),
      wire({ census: { kinds: [], procs: [proc({ label: 'pi\u0000 --rpc' })] } }),
      wire({ census: { kinds: [], procs: [proc({ label: 'x'.repeat(500) })] } }),
      wire({ census: { kinds: [], procs: [proc({ rss: 1.5 })] } }),
    ])
      expect(parseMachineTelemetry(bad)).toBeNull()
  })

  it('sums cores so no second total can disagree with them', () => {
    const parsed = parseMachineTelemetry(wire())
    expect(sumCounters(parsed?.cpu.perCore ?? [])).toEqual({ cores: 2, idle: 100, busy: 40 })
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

  it('keeps a census with several kinds, so totals can be added up', () => {
    const parsed = parseMachineTelemetry(
      wire({
        census: {
          kinds: [
            { kind: 'pi', procs: 3, cpuSec: 10, rss: 300 },
            { kind: 'host', procs: 1, cpuSec: 1, rss: 100 },
          ],
          procs: [],
        },
      }),
    )
    expect(parsed?.census?.kinds.map((k) => [k.kind, k.procs])).toEqual([
      ['pi', 3],
      ['host', 1],
    ])
  })
})
