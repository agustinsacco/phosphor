import { expect, it, vi } from 'vitest'
import type { AttentionEvent } from '@phosphor/shared/host-protocol'
import type { LaneReceipt } from '@phosphor/shared/lane-receipt'
import { makeAttention, readHostReceipt, receiptForEvent } from './attention'

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

it.each([
  ['finished', 'finished'],
  ['failed', 'failed'],
  ['needs-input', 'needs-input'],
  ['routine-finished', 'routine'],
  ['routine-paused', 'routine'],
] as const)('maps %s to %s without changing routing or timestamp', (kind, expected) => {
  expect(makeAttention('host', { ...event, kind, title: null })).toEqual({
    hostId: 'host',
    laneId: 'lane',
    kind: expected,
    title: 'Untitled lane',
    at: event.at,
  })
})

it.each([0, 30_000, -30_000, 30_001, -30_001, null])(
  'matches receipt timestamps with inclusive 30s tolerance: %s',
  (offset) => {
    const value = {
      ...receipt,
      settledAt: offset === null ? null : Date.parse(event.at) + offset,
    }
    expect(receiptForEvent(event, value)).toEqual(
      offset !== null && Math.abs(offset) <= 30_000 ? value : null,
    )
  },
)

it.each(['finished', 'failed', 'routine-finished', 'needs-input', 'routine-paused'] as const)(
  'only accepts matching completed outcomes for %s',
  (kind) => {
    for (const outcome of ['done', 'error'] as const) {
      const value = { ...receipt, outcome }
      const matches =
        kind === 'failed' ? outcome === 'error' : kind.endsWith('finished') && outcome === 'done'
      expect(receiptForEvent({ ...event, kind }, value)).toEqual(matches ? value : null)
    }
  },
)

it('rejects malformed receipts and invalid event timestamps', () => {
  for (const value of [undefined, {}, { ...receipt, files: -1 }, { ...receipt, excerpt: 42 }])
    expect(receiptForEvent(event, value)).toBeNull()
  expect(receiptForEvent({ ...event, at: 'invalid' }, receipt)).toBeNull()
})

it('routes the optional read with read authorization and drops detached or replaced connection data', async () => {
  let attached = true
  const view = { state: 'ready', capabilities: ['sessions.read'], lanes: [{ laneId: 'lane' }] }
  const connection = {
    snapshot: () => view,
    call: vi.fn(async () => ({ ok: true as const, data: receipt })),
  }
  const current = () => (attached ? connection : undefined)
  expect(await readHostReceipt(current, 'host', 'lane')).toEqual(receipt)
  expect(connection.call).toHaveBeenCalledWith('lane.receipt', { laneId: 'lane' })
  view.capabilities = []
  connection.call.mockClear()
  expect(await readHostReceipt(current, 'host', 'lane')).toBeUndefined()
  expect(connection.call).not.toHaveBeenCalled()
  view.capabilities = ['sessions.read']
  connection.call.mockImplementation(async () => {
    attached = false
    return { ok: true, data: receipt }
  })
  expect(await readHostReceipt(current, 'host', 'lane')).toBeUndefined()
  attached = true
  connection.call.mockImplementation(async () => {
    view.lanes = []
    return { ok: true, data: receipt }
  })
  expect(await readHostReceipt(current, 'host', 'lane')).toBeUndefined()
})
