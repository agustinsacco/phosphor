import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import {
  TELEMETRY_POLL_MS,
  setTelemetryAllowed,
  telemetryUnreadable,
  telemetryView,
  useTelemetry,
  watchTelemetry,
} from './telemetry'
import { useRemoteLanesStore } from './remoteLanes'
import { MOCK_HOST_ID, mockRemoteHosts } from '@/dev/mockRemoteLanes'
import type { MachineTelemetry } from '@phosphor/shared/host-protocol-telemetry'

const hostId = MOCK_HOST_ID
/** Typed so the mock's implementation keeps its promise return. */
type TelemetryInvoke = (hostId: string) => Promise<MachineTelemetry | null>
let invoke: Mock<TelemetryInvoke>

/** The mock Host, with the grant this read rides on. */
const readableHost = () => {
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  host.capabilities.push('skills.read')
  return host
}

/** A wire-shaped sample; `busy` and `cpuSec` step with `round` so rates move. */
const sample = (round = 0, over: Partial<MachineTelemetry> = {}): MachineTelemetry => ({
  at: 1_700_000_000_000 + round * TELEMETRY_POLL_MS,
  uptimeSec: 1_000 + round * TELEMETRY_POLL_MS,
  load: [1, 1, 1],
  cpu: {
    perCore: [
      { idle: 100 + round * 50, busy: 50 + round * 50 },
      { idle: 100 + round * 50, busy: 50 + round * 50 },
    ],
  },
  mem: { total: 1000, free: 200, used: 600, cache: 200, swapTotal: 100, swapUsed: 20 },
  disk: { total: 5_000, free: 1_000 },
  census: {
    kinds: [{ kind: 'pi', procs: 2, cpuSec: 10 + round, rss: 500 }],
    procs: [],
  },
  ...over,
})

/** Let the loop's read settle and its pause expire. */
const tick = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
}

const view = () => telemetryView(useTelemetry.getState(), hostId)

beforeEach(() => {
  vi.useFakeTimers()
  let round = 0
  invoke = vi.fn<TelemetryInvoke>(async () => sample(round++))
  vi.stubGlobal('window', { phosphor: { invoke } })
  useRemoteLanesStore.setState({ hosts: { [hostId]: readableHost() } })
  useTelemetry.setState({ byHost: {} })
  setTelemetryAllowed(true)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('watching a Host', () => {
  it('reads on open and every interval after, and stops with the last viewer', async () => {
    const stop = watchTelemetry(hostId)
    await tick()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(view().current).not.toBeNull()
    // The first sample has no predecessor, so it has no rate to show.
    expect(view().cpu).toBeNull()
    expect(view().receivedAt).not.toBeNull()

    await tick(TELEMETRY_POLL_MS)
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(view().cpu).not.toBeNull()

    stop()
    await tick(TELEMETRY_POLL_MS * 5)
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('serves two viewers from one poll, and stops only when both have gone', async () => {
    const first = watchTelemetry(hostId)
    const second = watchTelemetry(hostId)
    await tick(TELEMETRY_POLL_MS)
    expect(invoke).toHaveBeenCalledTimes(2)
    first()
    await tick(TELEMETRY_POLL_MS)
    expect(invoke).toHaveBeenCalledTimes(3)
    second()
    await tick(TELEMETRY_POLL_MS * 3)
    expect(invoke).toHaveBeenCalledTimes(3)
  })

  it('never has two reads in flight, however slow the Host is', async () => {
    const waiting: (() => void)[] = []
    invoke.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        waiting.push(resolve)
      })
      return sample(1)
    })
    const stop = watchTelemetry(hostId)
    await tick(TELEMETRY_POLL_MS * 10)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(waiting.length).toBe(1)
    waiting.shift()?.()
    await tick(TELEMETRY_POLL_MS)
    expect(invoke).toHaveBeenCalledTimes(2)
    stop()
  })

  it('keeps the last sample through a failed read, and starts a new series after it', async () => {
    const stop = watchTelemetry(hostId)
    await tick(TELEMETRY_POLL_MS)
    const cpuBefore = view().cpu
    const pointsBefore = view().points.length
    expect(cpuBefore).not.toBeNull()
    invoke.mockResolvedValueOnce(null)
    await tick(TELEMETRY_POLL_MS)
    // Nothing on screen changes: the sample there is still the last known truth,
    // and its `receivedAt` is what tells the popover it is going stale.
    expect(view().cpu).toBe(cpuBefore)
    expect(view().points.length).toBe(pointsBefore)
    // The read that follows a miss would compare against a sample two intervals
    // old; that is a rate over a period nobody watched, so it shows nothing.
    await tick(TELEMETRY_POLL_MS)
    expect(view().cpu).toBeNull()
    expect(view().points.length).toBe(pointsBefore + 1)
    await tick(TELEMETRY_POLL_MS)
    expect(view().cpu).not.toBeNull()
    stop()
  })

  it('starts a clean series on a new connection rather than a rate across it', async () => {
    const stop = watchTelemetry(hostId)
    await tick(TELEMETRY_POLL_MS * 3)
    expect(view().points.length).toBe(4)
    const host = readableHost()
    useRemoteLanesStore.setState({
      hosts: { [hostId]: { ...host, connectionToken: 'next-connection' } },
    })
    await tick(TELEMETRY_POLL_MS * 2)
    // Reading never stopped, but the series did: a new connection's counters have
    // no honest relationship to the old connection's, so it starts over.
    expect(invoke.mock.calls.length).toBeGreaterThan(4)
    expect(view().points.length).toBeLessThan(4)
    expect(view().current).not.toBeNull()
    stop()
  })

  it('stops reading while the tab is hidden and keeps the sample it has', async () => {
    const stop = watchTelemetry(hostId)
    await tick(TELEMETRY_POLL_MS)
    const held = view().current
    const before = invoke.mock.calls.length
    setTelemetryAllowed(false)
    await tick(TELEMETRY_POLL_MS * 5)
    expect(invoke.mock.calls.length).toBe(before)
    expect(view().current).toBe(held)
    setTelemetryAllowed(true)
    await tick()
    expect(invoke.mock.calls.length).toBe(before + 1)
    stop()
  })

  it('says so when this connection cannot read the machine, without asking it', async () => {
    const host = mockRemoteHosts[MOCK_HOST_ID]!
    useRemoteLanesStore.setState({
      hosts: {
        [hostId]: { ...host, capabilities: host.capabilities.filter((c) => c !== 'skills.read') },
      },
    })
    const stop = watchTelemetry(hostId)
    await tick(TELEMETRY_POLL_MS * 3)
    expect(invoke).not.toHaveBeenCalled()
    expect(telemetryUnreadable(useTelemetry.getState(), hostId)).toBe(true)
    stop()
  })

  it('begins reading when the grant arrives while the popover is open', async () => {
    const host = readableHost()
    useRemoteLanesStore.setState({
      hosts: {
        [hostId]: { ...host, capabilities: host.capabilities.filter((c) => c !== 'skills.read') },
      },
    })
    const stop = watchTelemetry(hostId)
    await tick()
    expect(invoke).not.toHaveBeenCalled()
    useRemoteLanesStore.setState({ hosts: { [hostId]: host } })
    await tick()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(telemetryUnreadable(useTelemetry.getState(), hostId)).toBe(false)
    stop()
  })

  it('keeps one stable empty view for a Host it has never seen', () => {
    const state = useTelemetry.getState()
    expect(telemetryView(state, 'nope')).toBe(telemetryView(state, 'nope'))
    expect(telemetryView(state, 'nope')).toBe(telemetryView(state, null))
    expect(telemetryView(state, 'nope').current).toBeNull()
  })
})
