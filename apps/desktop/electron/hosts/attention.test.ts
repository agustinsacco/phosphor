import { afterEach, expect, it, vi } from 'vitest'
import type { AttentionEvent } from '@shared/host-protocol'
import type { LaneReceipt } from '@shared/lane-receipt'
import { createHostAttention, readHostReceipt } from './attention'
const event: AttentionEvent = {
  id: 'one',
  laneId: 'lane',
  kind: 'finished',
  title: 'Lane',
  at: '2026-01-01T00:00:00.000Z',
  attention: 1,
}
const facts: LaneReceipt = {
  title: 'Lane',
  repository: 'private',
  branch: 'private',
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
afterEach(() => vi.useRealTimers())
function setup(receipt?: (host: string, lane: string) => Promise<unknown>) {
  const publish = vi.fn(),
    notify = vi.fn(),
    open = vi.fn()
  return {
    publish,
    notify,
    open,
    attention: createHostAttention({
      receipt,
      publish,
      notify,
      open,
      label: () => 'bee1',
      focused: () => false,
    }),
  }
}
it('reads a receipt and keeps private reply and paths off the lock screen, preserving click', async () => {
  const t = setup(async () => facts)
  t.attention.receive('host', event)
  await vi.waitFor(() => expect(t.publish).toHaveBeenCalledTimes(1))
  expect(t.publish.mock.calls[0]?.[0].receipt).toEqual(facts)
  expect(t.notify).toHaveBeenCalledWith(
    'bee1 · Lane',
    'Done in 4s · 1 file changed · tests pass',
    expect.any(Function),
  )
  t.notify.mock.calls[0]?.[2]()
  expect(t.open).toHaveBeenCalledWith('host', 'lane')
})
it('old Host refusal or invalid result falls back without changing the event', async () => {
  for (const read of [
    async () => {
      throw new Error('unsupported')
    },
    async () => ({ private: 'invalid' }),
  ]) {
    const t = setup(read)
    t.attention.receive('host', event)
    await vi.waitFor(() => expect(t.publish).toHaveBeenCalledTimes(1))
    expect(t.publish.mock.calls[0]?.[0].receipt).toBeUndefined()
    expect(t.notify.mock.calls[0]?.[1]).toBe('Done')
  }
})
it('times out in 2s, shares one read per lane, drops late data and account changes', async () => {
  vi.useFakeTimers()
  let resolve: (value: unknown) => void = () => {}
  const receipt = vi.fn(
    () =>
      new Promise<unknown>((r) => {
        resolve = r
      }),
  )
  const t = setup(receipt)
  t.attention.receive('host', event)
  t.attention.receive('host', { ...event, id: 'two' })
  expect(receipt).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1999)
  expect(t.publish).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(t.publish).toHaveBeenCalledTimes(2)
  resolve(facts)
  await vi.advanceTimersByTimeAsync(0)
  expect(t.publish).toHaveBeenCalledTimes(2)
  const t2 = setup(async () => facts)
  t2.attention.receive('host', event)
  t2.attention.clear()
  await vi.advanceTimersByTimeAsync(2000)
  expect(t2.publish).not.toHaveBeenCalled()
})

it('routes the optional read with read authorization and drops detached or replaced connection data', async () => {
  let attached = true
  const view = { state: 'ready', capabilities: ['sessions.read'], lanes: [{ laneId: 'lane' }] }
  const connection = {
    snapshot: () => view,
    call: vi.fn(async () => ({ ok: true as const, data: facts })),
  }
  const current = () => (attached ? connection : undefined)
  expect(await readHostReceipt(current, 'host', 'lane')).toEqual(facts)
  expect(connection.call).toHaveBeenCalledWith('lane.receipt', { laneId: 'lane' })
  view.capabilities = []
  connection.call.mockClear()
  expect(await readHostReceipt(current, 'host', 'lane')).toBeUndefined()
  expect(connection.call).not.toHaveBeenCalled()
  view.capabilities = ['sessions.read']
  connection.call.mockImplementation(async () => {
    attached = false
    return { ok: true, data: facts }
  })
  expect(await readHostReceipt(current, 'host', 'lane')).toBeUndefined()
  attached = true
  connection.call.mockImplementation(async () => {
    view.lanes = []
    return { ok: true, data: facts }
  })
  expect(await readHostReceipt(current, 'host', 'lane')).toBeUndefined()
})

it('bounds concurrent receipt reads across lanes', () => {
  vi.useFakeTimers()
  const receipt = vi.fn(() => new Promise<unknown>(() => {}))
  const t = setup(receipt)
  for (let i = 0; i <= 1600; i++)
    t.attention.receive('host', { ...event, id: `event-${i}`, laneId: `lane-${i}` })
  expect(receipt).toHaveBeenCalledTimes(1600)
  expect(t.publish).toHaveBeenCalledTimes(1)
  expect(t.publish.mock.calls[0]?.[0].receipt).toBeUndefined()
  t.attention.clear()
})

it.each(['needs-input', 'routine-paused'] as const)(
  'does not fetch prior-run receipts for %s',
  (kind) => {
    const receipt = vi.fn(async () => facts)
    const t = setup(receipt)
    t.attention.receive('host', { ...event, kind })
    expect(receipt).not.toHaveBeenCalled()
    expect(t.publish.mock.calls[0]?.[0].receipt).toBeUndefined()
  },
)
it('requires the outcome to match the attention kind', async () => {
  for (const kind of ['failed', 'finished', 'routine-finished'] as const) {
    const outcome = kind === 'failed' ? 'done' : 'error'
    const t = setup(async () => ({ ...facts, outcome }))
    t.attention.receive('host', { ...event, kind })
    await vi.waitFor(() => expect(t.publish).toHaveBeenCalledTimes(1))
    expect(t.publish.mock.calls[0]?.[0].receipt).toBeUndefined()
  }
  const t = setup(async () => ({ ...facts, outcome: 'error' }))
  t.attention.receive('host', { ...event, kind: 'failed' })
  await vi.waitFor(() => expect(t.publish).toHaveBeenCalledTimes(1))
  expect(t.publish.mock.calls[0]?.[0].receipt?.outcome).toBe('error')
})
it('ties receipts to the event within 30 seconds and refuses an unknown settle time', async () => {
  for (const offset of [0, 30_000, -30_000, 30_001, -30_001, null]) {
    const t = setup(async () => ({
      ...facts,
      settledAt: offset === null ? null : Date.parse(event.at) + offset,
    }))
    t.attention.receive('host', event)
    await vi.waitFor(() => expect(t.publish).toHaveBeenCalledTimes(1))
    expect(t.publish.mock.calls[0]?.[0].receipt !== undefined).toBe(
      offset !== null && Math.abs(offset) <= 30_000,
    )
  }
})
