import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { LaneOp } from '@phosphor/shared/host-protocol'
import { createCommandsFixture, type CommandsFixture } from './__fixtures__/commands.fixture'

let f: CommandsFixture
beforeEach(async () => {
  f = await createCommandsFixture()
})
afterEach(() => {
  f.cleanup()
  vi.restoreAllMocks()
})

const marks = (fields: object) => ({ type: 'lane.marks', ...fields }) as LaneOp
/** An unfenced frame, as a client that does not control the lane sends it. */
const unfenced = (op: LaneOp, laneId = f.lane.laneId) => ({
  ...f.frame(op, 1, laneId),
  fence: undefined,
})

it('applies marks from any controlling-capable client without taking control', async () => {
  f.store.bumpAttention(f.lane.laneId)
  const before = f.store.getLane(f.lane.laneId)
  const request = unfenced(marks({ pinned: true, marker: '🦊' }))
  await f.service.submit(f.two, request)
  expect(f.last(request.requestId)).toEqual({ requestId: request.requestId, status: 'done' })
  const after = f.store.getLane(f.lane.laneId)
  expect(after).toMatchObject({ pinned: true, marker: '🦊' })
  expect(after?.control).toEqual(before?.control)
  expect(after?.updatedAt).toBe(before?.updatedAt)
  expect([after?.attention, after?.read]).toEqual([before?.attention, before?.read])
  expect(f.events.at(-1)).toEqual({
    laneId: f.lane.laneId,
    event: { kind: 'summary', summary: expect.objectContaining({ pinned: true, marker: '🦊' }) },
  })
  expect(f.order).not.toContain('control')
})

it('keeps the other mark, forgets a marker with null and omits an unpinned lane', async () => {
  await f.service.submit(f.one, unfenced(marks({ pinned: true, marker: '' })))
  expect(f.store.getLane(f.lane.laneId)).toMatchObject({ pinned: true, marker: '' })
  await f.service.submit(f.one, unfenced(marks({ marker: '🚀' })))
  expect(f.store.getLane(f.lane.laneId)).toMatchObject({ pinned: true, marker: '🚀' })
  await f.service.submit(f.one, unfenced(marks({ pinned: false })))
  const unpinned = f.store.getLane(f.lane.laneId)
  expect(unpinned).toMatchObject({ marker: '🚀' })
  expect(unpinned).not.toHaveProperty('pinned')
  await f.service.submit(f.one, unfenced(marks({ marker: null })))
  const cleared = f.store.getLane(f.lane.laneId)
  expect(cleared).not.toHaveProperty('pinned')
  expect(cleared).not.toHaveProperty('marker')
})

it('works on a stopped lane', async () => {
  f.sessions.delete(f.lane.laneId)
  const request = unfenced(marks({ pinned: true }))
  await f.service.submit(f.one, request)
  expect(f.last(request.requestId)).toMatchObject({ status: 'done' })
  expect(f.store.getLane(f.lane.laneId)).toMatchObject({ pinned: true })
})

it('needs sessions.control and a listed lane', async () => {
  const viewer = { ...f.two, caps: ['sessions.read' as const] }
  const forbidden = unfenced(marks({ pinned: true }))
  await f.service.submit(viewer, forbidden)
  expect(f.last(forbidden.requestId)).toMatchObject({ status: 'rejected', code: 'forbidden' })
  const unknown = unfenced(marks({ pinned: true }), randomUUID())
  await f.service.submit(f.one, unknown)
  expect(f.last(unknown.requestId)).toMatchObject({ status: 'rejected', code: 'unknown-lane' })
  f.store.markRemoved(f.lane.laneId)
  const removed = unfenced(marks({ pinned: true }))
  await f.service.submit(f.one, removed)
  expect(f.last(removed.requestId)).toMatchObject({ status: 'rejected', code: 'unknown-lane' })
  expect(f.events).toEqual([])
})
