import { afterEach, expect, it, vi } from 'vitest'
import type { AttentionEvent } from '@shared/host-protocol'
import type { LaneReceipt } from '@shared/lane-receipt'
import type { AttentionPorts, AttentionState } from './attention'
import { makeAttention } from '@phosphor/host-client/attention'
import { publishAttention, waitForReceipt } from './attention-publication'

const event: AttentionEvent = {
  id: 'event',
  laneId: 'lane',
  kind: 'finished',
  title: 'Lane',
  at: '2026-01-01T00:00:00.000Z',
  attention: 1,
}
const receipt: LaneReceipt = {
  title: 'Private receipt title',
  repository: '/private/repository',
  branch: 'private-branch',
  excerpt: 'private reply',
  settledAt: Date.parse(event.at),
  durationMs: 4000,
  files: 1,
  added: 2,
  removed: 1,
  tests: 'passed',
  artifacts: 0,
  outcome: 'done',
}

function setup(read?: AttentionPorts['receipt']) {
  const state: AttentionState = {
    seen: new Set(),
    pending: new Map(),
    laneArrivals: new Map([['host/lane', 1]]),
    arrivalCounter: 1,
    generation: 0,
  }
  const ports = {
    receipt: read,
    label: vi.fn(() => 'Host'),
    focused: vi.fn(() => false),
    publish: vi.fn(),
    notify: vi.fn(),
    open: vi.fn(),
  }
  return { state, ports }
}

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

it.each([
  ['finished', 'Done'],
  ['failed', 'Stopped'],
  ['needs-input', 'needs-input'],
  ['routine-finished', 'routine'],
  ['routine-paused', 'routine'],
] as const)('uses fixed notification text for unenriched %s', (kind, body) => {
  const { state, ports } = setup()
  const incoming = { ...event, kind }
  publishAttention(state, ports, incoming, makeAttention('host', incoming), 0)
  expect(ports.notify).toHaveBeenCalledWith('Host · Lane', body, expect.any(Function))
  ports.notify.mock.calls[0]?.[2]()
  expect(ports.open).toHaveBeenCalledWith('host', 'lane')
})

it.each(['done', 'error'] as const)(
  'publishes receipt facts but never private receipt text in the OS body for %s',
  (outcome) => {
    const { state, ports } = setup()
    const incoming: AttentionEvent = { ...event, kind: outcome === 'error' ? 'failed' : 'finished' }
    const value = { ...receipt, outcome }
    publishAttention(state, ports, incoming, makeAttention('host', incoming), 0, value)
    expect(ports.publish.mock.calls[0]?.[0].receipt).toEqual(value)
    expect(ports.notify).toHaveBeenCalledWith(
      'Host · Lane',
      `${outcome === 'error' ? 'Stopped' : 'Done'} in 4s · 1 file changed · tests pass`,
      expect.any(Function),
    )
  },
)

it('does not publish after generation changes or notify a focused lane', () => {
  const { state, ports } = setup()
  state.generation = 1
  publishAttention(state, ports, event, makeAttention('host', event), 0, receipt)
  expect(ports.publish).not.toHaveBeenCalled()
  expect(ports.notify).not.toHaveBeenCalled()
  ports.focused.mockReturnValue(true)
  publishAttention(state, ports, event, makeAttention('host', event), 1, receipt)
  expect(ports.publish).toHaveBeenCalledTimes(1)
  expect(ports.notify).not.toHaveBeenCalled()
})

it.each(['resolved', 'rejected'] as const)(
  'cleans the receipt timer and pending read after it is %s',
  async (settlement) => {
    vi.useFakeTimers()
    const read = vi.fn(() =>
      settlement === 'resolved' ? Promise.resolve(receipt) : Promise.reject(new Error('refused')),
    )
    const { state, ports } = setup(read)
    waitForReceipt(state, ports, event, makeAttention('host', event), 1)
    expect(vi.getTimerCount()).toBe(1)
    expect(state.pending.size).toBe(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(state.pending.size).toBe(0)
    expect(ports.publish).toHaveBeenCalledTimes(1)
    expect(ports.publish.mock.calls[0]?.[0].receipt).toEqual(
      settlement === 'resolved' ? receipt : undefined,
    )
  },
)

it('times out at two seconds, clears its timer, and keeps the read pending until settlement', async () => {
  vi.useFakeTimers()
  let resolve: (value: unknown) => void = () => {}
  const { state, ports } = setup(
    () =>
      new Promise<unknown>((done) => {
        resolve = done
      }),
  )
  waitForReceipt(state, ports, event, makeAttention('host', event), 1)
  await vi.advanceTimersByTimeAsync(1999)
  expect(ports.publish).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(ports.publish).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
  expect(state.pending.size).toBe(1)
  resolve(receipt)
  await vi.advanceTimersByTimeAsync(0)
  expect(state.pending.size).toBe(0)
  expect(ports.publish).toHaveBeenCalledTimes(1)
})

it.each(['arrival', 'generation'] as const)(
  'cleans timers without publishing after %s invalidation',
  async (invalidation) => {
    vi.useFakeTimers()
    const { state, ports } = setup(async () => receipt)
    waitForReceipt(state, ports, event, makeAttention('host', event), 1)
    if (invalidation === 'arrival') state.laneArrivals.set('host/lane', 2)
    else state.generation++
    await vi.advanceTimersByTimeAsync(0)
    expect(ports.publish).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  },
)
