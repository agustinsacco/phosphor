import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type LaneOp } from '@phosphor/shared/host-protocol'
import { createLaneCommands, type LaneCommandClient } from './commands'
import {
  createCommandsFixture,
  deferred,
  type CommandsFixture,
} from './__fixtures__/commands.fixture'

let f: CommandsFixture
beforeEach(async () => {
  vi.useFakeTimers()
  f = await createCommandsFixture()
})
afterEach(() => {
  f.cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('fences file mutations, requires both caps, records before I/O and deduplicates', async () => {
  const execute = vi.fn(async (_laneId: string, _op: unknown) => {
    expect(f.store.getReceipt(request.requestId, writer.id)?.status).toBe('pending')
    return { ok: true as const }
  })
  f.ports.writes = { capabilityFor: () => 'workspaces.write', execute }
  f.service = createLaneCommands(f.ports)
  const writer: LaneCommandClient = { ...f.one, caps: ['sessions.control', 'workspaces.write'] }
  const request = f.frame({ type: 'files.create', path: 'a', kind: 'file' })
  await f.service.submit(f.one, request)
  expect(f.last(request.requestId)).toMatchObject({ code: 'forbidden' })
  expect(execute).not.toHaveBeenCalled()
  await f.service.submit({ ...writer, caps: ['workspaces.write'] }, request)
  expect(f.last(request.requestId)).toMatchObject({ code: 'forbidden' })
  expect(execute).not.toHaveBeenCalled()
  await f.service.submit(writer, request)
  expect(f.last(request.requestId)).toMatchObject({ status: 'done', fence: 2 })
  await f.service.submit(writer, request)
  expect(execute).toHaveBeenCalledTimes(1)
  await f.service.submit(
    { ...f.two, caps: writer.caps },
    f.frame({ type: 'files.delete', path: 'a' }, 2),
  )
  expect(f.sent.at(-1)?.receipt).toMatchObject({ status: 'rejected', code: 'not-controller' })
  await f.service.submit(writer, f.frame({ type: 'files.delete', path: 'a' }, 1))
  expect(f.sent.at(-1)?.receipt).toMatchObject({ status: 'rejected', code: 'stale-fence' })
  expect(execute).toHaveBeenCalledTimes(1)
})

it.each(['renewal', 'control', 'close'])(
  'refuses queued file I/O after %s permission loss',
  async (loss) => {
    const execute = vi.fn(async () => ({ ok: true as const }))
    f.ports.writes = { capabilityFor: () => 'workspaces.write', execute }
    f.service = createLaneCommands(f.ports)
    let caps: LaneCommandClient['caps'] = ['sessions.control', 'workspaces.write']
    const writer = { ...f.one, caps, currentCaps: () => caps }
    const response = deferred<void>()
    f.ports.stopLane = () => response.promise
    const held = f.service.submit(writer, f.frame({ type: 'lane.stop' }))
    const request = f.frame({ type: 'files.create', path: 'a', kind: 'file' }, 2)
    const queued = f.service.submit(writer, request)
    caps =
      loss === 'renewal' ? ['sessions.control'] : loss === 'control' ? ['workspaces.write'] : []
    response.release()
    await held
    await queued
    expect(execute).not.toHaveBeenCalled()
    expect(f.last(request.requestId)).toMatchObject({ status: 'rejected', code: 'forbidden' })
  },
)

describe('repository management and lane delete admission', () => {
  it('requires both capabilities and the current controller for delete', async () => {
    const deletion = vi.fn(async () => ({ ok: true as const, data: { branchKept: false } }))
    f.ports.deleteLane = deletion
    f.service = createLaneCommands(f.ports)
    const op: LaneOp = {
      type: 'lane.delete',
      laneId: f.lane.laneId,
      removeWorktree: false,
      removeBranch: false,
    }
    const missing = f.frame(op)
    await f.service.submit(f.one, missing)
    expect(f.last(missing.requestId)).toMatchObject({ status: 'rejected', code: 'forbidden' })
    const unowned = f.frame(op)
    await f.service.submit({ ...f.one, caps: ['sessions.control', 'workspaces.write'] }, unowned)
    expect(f.last(unowned.requestId)).toMatchObject({ status: 'rejected', code: 'not-controller' })
    f.store.takeControl(f.lane.laneId, { clientId: f.one.id, label: f.one.label })
    const viewer = f.frame(op, 2)
    await f.service.submit({ ...f.two, caps: ['sessions.control', 'workspaces.write'] }, viewer)
    expect(f.last(viewer.requestId)).toMatchObject({ status: 'rejected', code: 'not-controller' })
    expect(deletion).not.toHaveBeenCalled()
    const controller = f.frame(op, 2)
    await f.service.submit({ ...f.one, caps: ['sessions.control', 'workspaces.write'] }, controller)
    expect(f.last(controller.requestId)).toMatchObject({ status: 'done' })
    expect(deletion).toHaveBeenCalledTimes(1)
  })
  it('rechecks queued management operations after capability loss', async () => {
    const deletion = vi.fn(async () => ({ ok: true as const, data: { branchKept: false } }))
    f.ports.deleteLane = deletion
    f.service = createLaneCommands(f.ports)
    f.store.takeControl(f.lane.laneId, { clientId: f.one.id, label: f.one.label })
    let caps: LaneCommandClient['caps'] = ['sessions.control', 'workspaces.write']
    const client = { ...f.one, caps, currentCaps: () => caps }
    const hold = deferred<void>()
    f.ports.stopLane = vi.fn(() => hold.promise)
    const held = f.frame({ type: 'lane.stop' }, 2)
    const first = f.service.submit(client, held)
    const request = f.frame(
      { type: 'lane.delete', laneId: f.lane.laneId, removeWorktree: false, removeBranch: false },
      2,
    )
    const second = f.service.submit(client, request)
    caps = []
    hold.release()
    await first
    await second
    expect(f.last(request.requestId)).toMatchObject({ status: 'rejected', code: 'forbidden' })
    expect(deletion).not.toHaveBeenCalled()
  })
})
