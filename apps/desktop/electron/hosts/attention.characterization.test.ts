import { afterEach, expect, it, vi } from 'vitest'
import type { AttentionEvent } from '@shared/host-protocol'
import type { LaneReceipt } from '@shared/lane-receipt'
import { createHostAttention } from './attention'

const event: AttentionEvent = {
  id: 'event',
  laneId: 'lane',
  kind: 'finished',
  title: 'Lane',
  at: '2026-01-01T00:00:00.000Z',
  attention: 1,
}
const receipt: LaneReceipt = {
  title: 'Receipt title',
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

function setup(read?: () => Promise<unknown>, focused = false) {
  const publish = vi.fn()
  const notify = vi.fn()
  const open = vi.fn()
  const attention = createHostAttention({
    receipt: read,
    label: () => 'Host',
    focused: () => focused,
    publish,
    notify,
    open,
  })
  return { attention, publish, notify, open }
}

function deferred() {
  let resolve: (value: unknown) => void = () => {}
  const promise = new Promise<unknown>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

it('deduplicates host event IDs until the oldest of 1600 entries is evicted', () => {
  const t = setup()
  t.attention.receive('host', event)
  t.attention.receive('host', event)
  for (let i = 1; i < 1600; i++) t.attention.receive('host', { ...event, id: `event-${i}` })
  t.attention.receive('host', event)
  expect(t.publish).toHaveBeenCalledTimes(1600)
  t.attention.receive('other-host', event)
  t.attention.receive('host', event)
  expect(t.publish).toHaveBeenCalledTimes(1602)
})

it('retains only the latest 256 lane arrivals and never revives an evicted await', async () => {
  vi.useFakeTimers()
  const read = deferred()
  const t = setup(() => read.promise)
  t.attention.receive('host', event)
  for (let i = 0; i < 256; i++)
    t.attention.receive('host', { ...event, id: `event-${i}`, laneId: `lane-${i}` })
  read.resolve(receipt)
  await vi.advanceTimersByTimeAsync(0)
  expect(t.publish).toHaveBeenCalledTimes(256)
  expect(t.publish.mock.calls.some(([value]) => value.laneId === 'lane')).toBe(false)
})

it('does not reuse an evicted arrival when its lane returns', async () => {
  vi.useFakeTimers()
  const read = deferred()
  const t = setup(() => read.promise)
  t.attention.receive('host', event)
  for (let i = 0; i < 256; i++)
    t.attention.receive('host', {
      ...event,
      id: `input-${i}`,
      laneId: `lane-${i}`,
      kind: 'needs-input',
    })
  t.attention.receive('host', { ...event, id: 'new-input', kind: 'needs-input' })
  read.resolve(receipt)
  await vi.advanceTimersByTimeAsync(2000)
  expect(t.publish).toHaveBeenCalledTimes(257)
  expect(t.publish.mock.calls.every(([value]) => value.kind === 'needs-input')).toBe(true)
})

it.each(['receipt', 'timeout'] as const)(
  'supersedes old publication with newer needs-input before %s',
  async (settlement) => {
    vi.useFakeTimers()
    const read = deferred()
    const t = setup(() => read.promise)
    t.attention.receive('host', event)
    t.attention.receive('host', { ...event, id: 'input', kind: 'needs-input' })
    if (settlement === 'receipt') read.resolve(receipt)
    await vi.advanceTimersByTimeAsync(2000)
    expect(t.publish.mock.calls.map(([value]) => value.kind)).toEqual(['needs-input'])
    expect(t.notify).toHaveBeenCalledTimes(1)
  },
)

it('publishes a focused lane immediately without reading or notifying the OS', () => {
  const read = vi.fn(async () => receipt)
  const t = setup(read, true)
  t.attention.receive('host', event)
  expect(read).not.toHaveBeenCalled()
  expect(t.publish).toHaveBeenCalledWith({
    hostId: 'host',
    laneId: 'lane',
    kind: 'finished',
    title: 'Lane',
    at: event.at,
  })
  expect(t.notify).not.toHaveBeenCalled()
})

it.each([null, 30_001, -30_001, 30_000, -30_000])(
  'matches receipt settle time with inclusive 30s tolerance: %s',
  async (offset) => {
    vi.useFakeTimers()
    const t = setup(async () => ({
      ...receipt,
      settledAt: offset === null ? null : Date.parse(event.at) + offset,
    }))
    t.attention.receive('host', event)
    await vi.advanceTimersByTimeAsync(0)
    expect(t.publish).toHaveBeenCalledTimes(1)
    expect(t.publish.mock.calls[0]?.[0].receipt !== undefined).toBe(
      offset !== null && Math.abs(offset) <= 30_000,
    )
  },
)

it.each(['finished', 'failed', 'routine-finished'] as const)(
  'refuses mismatched receipt outcome for %s',
  async (kind) => {
    vi.useFakeTimers()
    const t = setup(async () => ({ ...receipt, outcome: kind === 'failed' ? 'done' : 'error' }))
    t.attention.receive('host', { ...event, kind })
    await vi.advanceTimersByTimeAsync(0)
    expect(t.publish).toHaveBeenCalledTimes(1)
    expect(t.publish.mock.calls[0]?.[0].receipt).toBeUndefined()
  },
)

it('clear invalidates awaits and permits the same event again without reviving old data', async () => {
  vi.useFakeTimers()
  const oldRead = deferred()
  const newRead = deferred()
  const read = vi.fn().mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise)
  const t = setup(read)
  t.attention.receive('host', event)
  t.attention.clear()
  t.attention.receive('host', event)
  oldRead.resolve({ ...receipt, files: 99 })
  await vi.advanceTimersByTimeAsync(0)
  expect(t.publish).not.toHaveBeenCalled()
  newRead.resolve(receipt)
  await vi.advanceTimersByTimeAsync(0)
  expect(read).toHaveBeenCalledTimes(2)
  expect(t.publish).toHaveBeenCalledTimes(1)
  expect(t.publish.mock.calls[0]?.[0].receipt).toEqual(receipt)
})

it('shares reads and publishes the newest event at exactly two seconds, ignoring late data', async () => {
  vi.useFakeTimers()
  const read = deferred()
  const fetch = vi.fn(() => read.promise)
  const t = setup(fetch)
  t.attention.receive('host', event)
  t.attention.receive('host', { ...event, id: 'newer', title: 'Newer' })
  expect(fetch).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1999)
  expect(t.publish).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(t.publish).toHaveBeenCalledTimes(1)
  expect(t.publish.mock.calls[0]?.[0].title).toBe('Newer')
  expect(t.publish.mock.calls[0]?.[0].receipt).toBeUndefined()
  read.resolve(receipt)
  await vi.advanceTimersByTimeAsync(0)
  expect(t.publish).toHaveBeenCalledTimes(1)
})
