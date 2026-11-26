import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { MachineTelemetry } from '@phosphor/shared/host-protocol-telemetry'
import { TELEMETRY_POLL_MS, telemetryOf, useTelemetryStore, watchTelemetry } from './telemetry'

const HOST = 'host-one'

/** `busy` is each core's busy counter, so consecutive samples make a rate. */
function sample(at: number, busy: number, procCpuSec = busy, rss = 1_000): MachineTelemetry {
  const core = (value: number) => ({ idle: 100, busy: value })
  return {
    at,
    uptimeSec: 1000,
    load: [0.5, 0.5, 0.5],
    cpu: {
      cores: 2,
      total: { idle: 200, busy: busy * 2 },
      perCore: [core(busy), core(busy)],
    },
    mem: { total: 8000, free: 2000, used: 5000, cache: 1000, swapTotal: 0, swapUsed: 0 },
    disk: { total: 100_000, free: 40_000 },
    kinds: [{ kind: 'pi', procs: 1, cpuSec: procCpuSec, rss }],
    procs: [{ pid: 10, ppid: 1, kind: 'pi', label: 'pi', cpuSec: procCpuSec, rss, uptimeSec: 10 }],
  }
}

/** Let a poll already in flight land, without firing another one. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 8; tick++) await Promise.resolve()
}

const state = () => useTelemetryStore.getState()
const host = () => telemetryOf(state(), HOST)

let invoke: Mock<(channel: string, hostId: string) => Promise<unknown>>
let clock = 1_000_000

beforeEach(() => {
  clock = 1_000_000
  useTelemetryStore.setState({ hosts: {} })
  invoke = vi.fn<(channel: string, hostId: string) => Promise<unknown>>(async () =>
    sample(clock++, 10),
  )
  vi.stubGlobal('window', { phosphor: { invoke } })
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('telemetry polling', () => {
  it('polls a Host only while a viewer is open', async () => {
    const close = watchTelemetry(HOST)
    await vi.advanceTimersByTimeAsync(TELEMETRY_POLL_MS)
    expect(invoke).toHaveBeenCalledTimes(2)
    close()
    await vi.advanceTimersByTimeAsync(TELEMETRY_POLL_MS * 5)
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('shares one interval between two viewers of the same Host', async () => {
    const first = watchTelemetry(HOST)
    const second = watchTelemetry(HOST)
    await vi.advanceTimersByTimeAsync(TELEMETRY_POLL_MS)
    expect(invoke).toHaveBeenCalledTimes(2)
    first()
    await vi.advanceTimersByTimeAsync(TELEMETRY_POLL_MS)
    expect(invoke).toHaveBeenCalledTimes(3)
    second()
    await vi.advanceTimersByTimeAsync(TELEMETRY_POLL_MS * 3)
    expect(invoke).toHaveBeenCalledTimes(3)
  })

  it('never overlaps a request still in flight', async () => {
    let release: (value: MachineTelemetry) => void = () => undefined
    invoke.mockImplementation(() => new Promise<MachineTelemetry>((resolve) => (release = resolve)))
    const close = watchTelemetry(HOST)
    await vi.advanceTimersByTimeAsync(TELEMETRY_POLL_MS * 4)
    expect(invoke).toHaveBeenCalledTimes(1)
    release(sample(clock++, 20))
    await settle()
    await vi.advanceTimersByTimeAsync(TELEMETRY_POLL_MS)
    expect(invoke).toHaveBeenCalledTimes(2)
    // Let the second request land too, or its in-flight guard outlives the test.
    release(sample(clock++, 25))
    await settle()
    close()
  })

  it('drops a reply to a poll nobody is waiting for any more', async () => {
    let release: (value: MachineTelemetry) => void = () => undefined
    invoke.mockImplementation(() => new Promise<MachineTelemetry>((resolve) => (release = resolve)))
    watchTelemetry(HOST)()
    expect(host().loading).toBe(false)
    release(sample(clock++, 20))
    await settle()
    expect(host().sample).toBeNull()
  })

  it('asks a wedged request no longer than the stall window', async () => {
    invoke.mockImplementation(() => new Promise<MachineTelemetry>(() => undefined))
    const close = watchTelemetry(HOST)
    await vi.advanceTimersByTimeAsync(TELEMETRY_POLL_MS * 14)
    expect(invoke).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(TELEMETRY_POLL_MS)
    expect(invoke).toHaveBeenCalledTimes(2)
    close()
  })

  it('asks nothing while paused', async () => {
    const close = watchTelemetry(HOST)
    await vi.advanceTimersByTimeAsync(TELEMETRY_POLL_MS)
    const calls = invoke.mock.calls.length
    state().setPaused(HOST, true)
    await vi.advanceTimersByTimeAsync(TELEMETRY_POLL_MS * 5)
    expect(invoke).toHaveBeenCalledTimes(calls)
    state().setPaused(HOST, false)
    await vi.advanceTimersByTimeAsync(TELEMETRY_POLL_MS)
    expect(invoke).toHaveBeenCalledTimes(calls + 1)
    close()
  })
})

describe('telemetry projection', () => {
  it('has no rate for the first sample and a real one after it', async () => {
    invoke
      .mockResolvedValueOnce(sample(1_000, 0, 0))
      .mockResolvedValueOnce(sample(3_000, 15, 1))
      .mockResolvedValueOnce(sample(5_000, 45, 1))
    const close = watchTelemetry(HOST)
    await settle()
    expect(host().sample?.at).toBe(1_000)
    expect(host().points.map((p) => p.cpu)).toEqual([null])

    await vi.advanceTimersByTimeAsync(TELEMETRY_POLL_MS)
    expect(host().points.map((p) => p.cpu)).toEqual([null, 100])
    expect(host().procPct).toEqual({ 10: 50 })
    expect(host().corePct).toEqual([100, 100])
    expect(host().points[1]).toMatchObject({ memUsed: 5000, phosphor: 1000, procs: 1 })

    await vi.advanceTimersByTimeAsync(TELEMETRY_POLL_MS)
    expect(host().points.map((p) => p.cpu)).toEqual([null, 100, 100])
    close()
  })

  it('makes no rate across a gap too wide to describe the present', async () => {
    invoke
      .mockResolvedValueOnce(sample(1_000, 0, 0))
      .mockResolvedValueOnce(sample(1_000 + 600_000, 30, 5))
    const close = watchTelemetry(HOST)
    await settle()
    await vi.advanceTimersByTimeAsync(TELEMETRY_POLL_MS)
    expect(host().points.map((p) => p.cpu)).toEqual([null, null])
    expect(host().procPct).toEqual({})
    expect(host().corePct).toEqual([])
    close()
  })

  it('keeps the ring bounded and drops the oldest points', async () => {
    let at = 1_000
    invoke.mockImplementation(async () => sample(++at, 10))
    const close = watchTelemetry(HOST)
    for (let tick = 0; tick < 1_802; tick++) await vi.advanceTimersByTimeAsync(TELEMETRY_POLL_MS)
    expect(host().points).toHaveLength(1_800)
    expect(host().points.at(-1)?.at).toBe(at)
    close()
  })

  it('says so when the Host is too old, without inventing numbers', async () => {
    invoke.mockResolvedValueOnce(null)
    const close = watchTelemetry(HOST)
    await settle()
    expect(host()).toMatchObject({ sample: null, unsupported: true, loading: false })
    expect(host().error).toContain('does not report')
    close()
  })

  it('keeps the last good sample through a failure and recovers on the next tick', async () => {
    invoke.mockResolvedValueOnce(sample(1_000, 10)).mockRejectedValueOnce(new Error('gone'))
    const close = watchTelemetry(HOST)
    await settle()
    expect(host().error).toBeNull()

    await vi.advanceTimersByTimeAsync(TELEMETRY_POLL_MS)
    expect(host().sample?.at).toBe(1_000)
    expect(host().error).toBe('Telemetry unavailable.')

    invoke.mockResolvedValueOnce(sample(3_000, 40))
    await vi.advanceTimersByTimeAsync(TELEMETRY_POLL_MS)
    expect(host().error).toBeNull()
    expect(host().points.at(-1)?.at).toBe(3_000)
    close()
  })

  it('gives every Host without data the same frozen empty value', () => {
    expect(telemetryOf(state(), 'nobody')).toBe(telemetryOf(state(), 'nobody-else'))
    expect(telemetryOf(state(), 'nobody').points).toHaveLength(0)
  })
})
