import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOST_LIMITS, type LaneOp, type LanePiOp } from '@phosphor/shared/host-protocol'
import { commandRefusal } from '../session/runtime'
import * as folders from './worktree'
import { createLaneCommands, type LaneCommandFrame } from './commands'
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

describe('lane command guards and operations', () => {
  it('republishes durable control before the next op after a failed admission publication', async () => {
    const publish = f.ports.publish
    const deletion = vi.spyOn(Map.prototype, 'delete')
    f.ports.publish = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('stream failed')
      })
      .mockImplementation(publish)
    const first = f.frame()
    try {
      await f.service.submit(f.one, first)
      expect(f.last(first.requestId)).toMatchObject({
        status: 'failed',
        error: {
          code: 'internal',
          message: "the lane's control change could not be published",
        },
      })
      expect(f.command).not.toHaveBeenCalled()
      expect(f.store.getLane(f.lane.laneId)?.control.fence).toBe(2)
      expect(deletion.mock.calls.filter(([key]) => key === f.lane.laneId)).toHaveLength(0)
    } finally {
      deletion.mockRestore()
    }
    const next = f.service.submit(f.one, f.frame({ type: 'abort' }, 2))
    expect(f.order).toEqual(['control', 'run'])
    expect(f.events[0]?.event).toMatchObject({ kind: 'control', control: { fence: 2 } })
    f.finish(0)
    await next
  })

  it('clears unpublished control for a pruned lane and deletes its queue after outstanding work settles', async () => {
    const deletion = vi.spyOn(Map.prototype, 'delete')
    const running = f.service.submit(f.one, f.frame())
    f.ports.publish = () => {
      throw new Error('stream failed')
    }
    try {
      await f.service.submit(f.two, f.frame({ type: 'control.take' }))
      f.store.markRemoved(f.lane.laneId)
      f.store.pruneRemovedLanes(Date.now() + 31 * 24 * 60 * 60 * 1000)
      expect(f.store.getLane(f.lane.laneId)).toBeNull()
      const missing = f.frame({ type: 'abort' }, 3)
      await f.service.submit(f.two, missing)
      expect(f.last(missing.requestId)).toMatchObject({ status: 'rejected', code: 'unknown-lane' })
      expect(f.store.getReceipt(missing.requestId, f.two.id)).toEqual(f.last(missing.requestId))
      expect(f.command).toHaveBeenCalledTimes(1)
      expect(deletion.mock.calls.filter(([key]) => key === f.lane.laneId)).toHaveLength(0)
      f.finish(0)
      await running
      expect(deletion.mock.calls.filter(([key]) => key === f.lane.laneId)).toHaveLength(1)
    } finally {
      deletion.mockRestore()
    }
  })

  it('fails closed when control republication keeps failing', async () => {
    f.ports.publish = () => {
      throw new Error('stream failed')
    }
    await f.service.submit(f.one, f.frame())
    const next = f.frame({ type: 'abort' }, 2)
    await f.service.submit(f.one, next)
    expect(f.last(next.requestId)).toMatchObject({
      status: 'failed',
      error: {
        code: 'internal',
        message: "the lane's control change could not be published",
      },
    })
    expect(f.command).not.toHaveBeenCalled()
  })

  it.each(['control.take', 'control.release'] as const)(
    'keeps %s done after failed publication and republishes fresh control before later work',
    async (type) => {
      if (type === 'control.release')
        f.store.takeControl(f.lane.laneId, { clientId: f.one.id, label: f.one.label })
      const publish = f.ports.publish
      f.ports.publish = vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('stream failed')
        })
        .mockImplementation(publish)
      const request = f.frame({ type }, type === 'control.release' ? 2 : 1)
      await f.service.submit(f.one, request)
      const fence = type === 'control.release' ? 3 : 2
      expect(f.last(request.requestId)).toMatchObject({ status: 'done', fence })
      const next = f.service.submit(f.one, f.frame({ type: 'abort' }, fence))
      expect(f.order).toEqual(
        type === 'control.release' ? ['control', 'control', 'run'] : ['control', 'run'],
      )
      expect(f.events[0]?.event).toMatchObject({ kind: 'control', control: { fence } })
      f.finish(0)
      await next
    },
  )

  it.each(['dialog-resolved', 'summary'] as const)(
    'does not change done on failed %s publication',
    async (kind) => {
      f.store.takeControl(f.lane.laneId, { clientId: f.one.id, label: f.one.label })
      f.ports.publish = () => {
        throw new Error('private stream error')
      }
      const request = f.frame(
        kind === 'summary'
          ? { type: 'lane.markRead', upTo: 0 }
          : {
              type: 'extension_ui_response',
              response: { type: 'extension_ui_response', id: 'dialog', confirmed: true },
            },
        2,
      )
      await f.service.submit(f.one, request)
      expect(f.last(request.requestId)?.status).toBe('done')
      expect(f.logs).toContainEqual({
        message: 'lane.publish_failed',
        data: { laneId: f.lane.laneId, kind },
      })
      expect(JSON.stringify(f.logs)).not.toContain('private stream error')
    },
  )

  it('requires control capability before recording', async () => {
    const request = f.frame()
    const submitted = f.service.submit({ ...f.one, caps: ['sessions.read'] }, request)
    expect(f.command).not.toHaveBeenCalled()
    await submitted
    expect(f.last(request.requestId)).toMatchObject({ code: 'forbidden' })
    expect(f.store.getReceipt(request.requestId, f.one.id)).toBeNull()
    expect(f.events).toEqual([])
    expect(f.command).not.toHaveBeenCalled()
  })

  it('records invalid creation, missing lanes, stopped pi and missing fences', async () => {
    for (const [request, code] of [
      [
        {
          type: 'command',
          requestId: randomUUID(),
          op: { type: 'lane.create', repositoryId: '0000000000000000', worktree: null },
        },
        'bad-request',
      ],
      [f.frame({ type: 'abort' }, 1, randomUUID()), 'unknown-lane'],
      [{ type: 'command', requestId: randomUUID(), op: { type: 'lane.resume' } }, 'unknown-lane'],
      [
        { type: 'command', requestId: randomUUID(), laneId: f.lane.laneId, op: { type: 'abort' } },
        'bad-request',
      ],
    ] satisfies [LaneCommandFrame, string][]) {
      await f.service.submit(f.one, request)
      expect(f.store.getReceipt(request.requestId, f.one.id)).toMatchObject({
        status: 'rejected',
        code,
      })
    }
    f.sessions.clear()
    const stopped = f.frame()
    await f.service.submit(f.one, stopped)
    expect(f.last(stopped.requestId)).toMatchObject({ code: 'lane-stopped' })
    expect(f.store.getLane(f.lane.laneId)?.control.fence).toBe(1)
  })

  it('rejects a refusable pi operation before admission, even on an empty controller', async () => {
    f.service = createLaneCommands({ ...f.ports, refusal: () => 'private reason' })
    const request = f.frame()
    const submitted = f.service.submit(f.one, request)
    expect(f.command).not.toHaveBeenCalled()
    await submitted
    expect(f.store.getReceipt(request.requestId, f.one.id)).toMatchObject({ code: 'unsupported' })
    expect(f.store.getLane(f.lane.laneId)?.control).toEqual({ fence: 1, controller: null })
    expect(f.command).not.toHaveBeenCalled()
    expect(f.events).toEqual([])
    expect(JSON.stringify(f.logs)).not.toContain('private reason')
  })

  it('pins every lane pi op as non-refusable on the Host; a change now answers rejected unsupported', () => {
    const ops = [
      { type: 'prompt', message: 'x' },
      { type: 'steer', message: 'x' },
      { type: 'follow_up', message: 'x' },
      { type: 'abort' },
      { type: 'abort_retry' },
      { type: 'set_model', provider: 'p', modelId: 'm' },
      { type: 'set_thinking_level', level: 'off' },
      { type: 'compact' },
      { type: 'set_session_name', name: 'x' },
    ] satisfies LanePiOp[]
    for (const op of ops) expect(commandRefusal(op)).toBeNull()
  })

  it('admits dialog answers only for the controller, refuses closed ids and publishes resolution after success', async () => {
    f.store.takeControl(f.lane.laneId, { clientId: f.one.id, label: f.one.label })
    const answer: LaneOp = {
      type: 'extension_ui_response',
      response: { type: 'extension_ui_response', id: 'dialog', confirmed: true },
    }
    const viewer = f.frame(answer, 2)
    await f.service.submit(f.two, viewer)
    expect(f.last(viewer.requestId)).toMatchObject({ code: 'not-controller' })
    expect(f.respond).not.toHaveBeenCalled()
    const resolved = deferred<void>()
    // HostRuntime responds synchronously; a throwing response is tested separately.
    f.respond.mockImplementation(() => {
      expect(f.events).toEqual([])
      resolved.release()
    })
    await f.service.submit(f.one, f.frame(answer, 2))
    await resolved.promise
    expect(f.respond).toHaveBeenCalledWith('pi-live', answer.response)
    expect(f.events.map((e) => e.event)).toEqual([{ kind: 'dialog-resolved', dialogId: 'dialog' }])
    const closed = f.frame(
      { ...answer, response: { type: 'extension_ui_response', id: 'closed', cancelled: true } },
      2,
    )
    await f.service.submit(f.one, closed)
    expect(f.last(closed.requestId)).toMatchObject({ code: 'bad-request' })
    expect(f.respond).toHaveBeenCalledTimes(1)
  })

  it('maps thrown transport commands to unknown and still runs the next queued command', async () => {
    const request = f.frame()
    const a = f.service.submit(f.one, request)
    const b = f.service.submit(f.one, f.frame({ type: 'abort' }, 2))
    f.pending[0]?.reject(new Error('private error'))
    await a
    expect(f.last(request.requestId)?.status).toBe('unknown')
    f.service.status(f.one.id, request.requestId)
    expect(f.last(request.requestId)?.status).toBe('unknown')
    expect(f.command).toHaveBeenCalledTimes(2)
    f.finish(1)
    await b
    expect(f.logs).toContainEqual({
      message: 'lane.command',
      data: expect.objectContaining({ status: 'unknown', reason: 'transport' }),
    })
    expect(JSON.stringify(f.logs)).not.toContain('private error')
  })

  it('does not resolve a dialog after a thrown response', async () => {
    f.respond.mockImplementation(() => {
      throw new Error('private response')
    })
    const request = f.frame({
      type: 'extension_ui_response',
      response: { type: 'extension_ui_response', id: 'dialog', confirmed: true },
    })
    await f.service.submit(f.one, request)
    expect(f.last(request.requestId)?.status).toBe('unknown')
    expect(f.events.map((e) => e.event.kind)).toEqual(['control'])
  })

  it('takes and releases control, markRead is unfenced and keeps counters bounded', async () => {
    const a = f.frame({ type: 'control.take' })
    const b = f.frame({ type: 'control.take' })
    await Promise.all([f.service.submit(f.one, a), f.service.submit(f.two, b)])
    expect(f.last(a.requestId)).toMatchObject({ fence: 2 })
    expect(f.last(b.requestId)).toMatchObject({ fence: 3 })
    const staleRelease = f.frame({ type: 'control.release' }, 2)
    await f.service.submit(f.one, staleRelease)
    expect(f.last(staleRelease.requestId)).toMatchObject({ code: 'stale-fence' })
    const viewer = f.frame({ type: 'control.release' }, 3)
    await f.service.submit(f.one, viewer)
    expect(f.last(viewer.requestId)).toMatchObject({ code: 'not-controller' })
    await f.service.submit(f.two, f.frame({ type: 'control.release' }, 3))
    expect(f.store.getLane(f.lane.laneId)?.control).toEqual({ fence: 4, controller: null })
    const emptyRelease = f.frame({ type: 'control.release' }, 4)
    await f.service.submit(f.one, emptyRelease)
    expect(f.last(emptyRelease.requestId)).toMatchObject({ code: 'not-controller' })
    expect(f.store.getLane(f.lane.laneId)?.control.fence).toBe(4)
    f.store.bumpAttention(f.lane.laneId)
    await f.service.submit(f.one, f.frame({ type: 'lane.markRead', upTo: 10 }, 1))
    expect(f.events.at(-1)?.event).toMatchObject({
      kind: 'summary',
      summary: { activity: 'working', read: 1, attention: 1 },
    })
    expect(f.store.getLane(f.lane.laneId)?.control.fence).toBe(4)
    const summaryEvent = f.events.at(-1)?.event
    if (summaryEvent?.kind !== 'summary') throw new Error('missing summary')
    expect(summaryEvent.summary).not.toHaveProperty('sessionFile')
    expect(summaryEvent.summary).not.toHaveProperty('removedAt')
  })

  it('persists unfenced markRead on a stopped lane without runtime or folder I/O', async () => {
    f.sessions.clear()
    const folder = vi.spyOn(folders, 'prepareLaneFolder')
    f.store.bumpAttention(f.lane.laneId)
    const request = f.frame({ type: 'lane.markRead', upTo: 1 })
    await f.service.submit(f.one, request)
    expect(f.last(request.requestId)).toEqual({ requestId: request.requestId, status: 'done' })
    expect(f.store.getReceipt(request.requestId, f.one.id)).toEqual(f.last(request.requestId))
    expect(f.store.getLane(f.lane.laneId)?.read).toBe(1)
    expect(f.command).not.toHaveBeenCalled()
    expect(f.ports.sessions.start).not.toHaveBeenCalled()
    expect(f.ports.sessions.stop).not.toHaveBeenCalled()
    expect(f.ports.resumeLane).not.toHaveBeenCalled()
    expect(f.ports.stopLane).not.toHaveBeenCalled()
    expect(folder).not.toHaveBeenCalled()
    f.service.status(f.one.id, request.requestId)
    expect(f.receipts(request.requestId)).toEqual([
      f.last(request.requestId),
      f.last(request.requestId),
    ])
  })

  it('marks read even when the projection has no summary', async () => {
    f.ports.summaryFor = () => null
    f.store.bumpAttention(f.lane.laneId)
    const request = f.frame({ type: 'lane.markRead', upTo: 1 })
    await f.service.submit(f.two, request)
    expect(f.store.getLane(f.lane.laneId)?.read).toBe(1)
    expect(f.last(request.requestId)?.status).toBe('done')
    expect(f.events).toEqual([])
  })

  it('resumes and stops through lane ports with idempotent no-ops', async () => {
    f.store.takeControl(f.lane.laneId, { clientId: f.one.id, label: f.one.label })
    await f.service.submit(f.one, f.frame({ type: 'lane.resume' }, 2))
    expect(f.ports.resumeLane).not.toHaveBeenCalled()
    await f.service.submit(f.one, f.frame({ type: 'lane.stop' }, 2))
    await f.service.submit(f.one, f.frame({ type: 'lane.stop' }, 2))
    expect(f.ports.stopLane).toHaveBeenCalledTimes(1)
    await f.service.submit(f.one, f.frame({ type: 'lane.resume' }, 2))
    expect(f.ports.resumeLane).toHaveBeenCalledWith(
      expect.objectContaining({ sessionFile: f.lane.sessionFile }),
    )
  })

  it.each(['lane.resume', 'lane.stop'] as const)(
    'bounds %s waits and keeps late receipts unknown',
    async (type) => {
      if (type === 'lane.resume') f.sessions.clear()
      const response = deferred<void>()
      f.ports.resumeLane = () => response.promise
      f.ports.stopLane = () => response.promise
      const request = f.frame({ type })
      const running = f.service.submit(f.one, request)
      await vi.advanceTimersByTimeAsync(HOST_LIMITS.commandAnswerMs)
      await running
      expect(f.last(request.requestId)?.status).toBe('unknown')
      response.release()
      await vi.advanceTimersByTimeAsync(0)
      expect(f.store.getReceipt(request.requestId, f.one.id)?.status).toBe('unknown')
    },
  )

  it.each(['lane.resume', 'lane.stop'] as const)(
    'uses fixed %s errors and token-only error codes',
    async (type) => {
      if (type === 'lane.resume') f.sessions.clear()
      const fail = async () => {
        throw { code: 'bad code with spaces', message: 'private failure' }
      }
      f.ports.resumeLane = fail
      f.ports.stopLane = fail
      const request = f.frame({ type })
      await f.service.submit(f.one, request)
      expect(f.last(request.requestId)).toMatchObject({
        status: 'failed',
        error: {
          code: 'internal',
          message: type === 'lane.resume' ? 'the lane could not start' : 'the lane could not stop',
        },
      })
      expect(JSON.stringify(f.logs)).not.toMatch(/bad code with spaces|private failure/)
    },
  )
})
