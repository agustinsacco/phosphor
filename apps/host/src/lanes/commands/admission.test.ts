import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LaneOp } from '@phosphor/shared/host-protocol'
import { createCommandsFixture, type CommandsFixture } from '../__fixtures__/commands.fixture'
import { admitFence, admitLane, laneRefusal, republishControl } from './admission'
import { handled, NOT_MATCHED } from './routing'
import { queueFor } from './queue'
import { createCommandState, type Job, type LaneCommandClient } from './state'

let f: CommandsFixture
const abort = vi.fn()
beforeEach(async () => {
  vi.useFakeTimers()
  f = await createCommandsFixture()
  abort.mockReset()
  f.ports.attachments = { abort } as unknown as NonNullable<typeof f.ports.attachments>
})
afterEach(() => {
  f.cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** A null fence omits it; an explicit undefined would take the default. */
function job(op: LaneOp, fence: number | null = 1, client: LaneCommandClient = f.one): Job {
  return {
    client,
    frame: {
      type: 'command',
      requestId: randomUUID(),
      laneId: f.lane.laneId,
      ...(fence === null ? {} : { fence }),
      op,
    },
    started: 0,
    resolve: vi.fn(),
  }
}
const setup = () => {
  const state = createCommandState()
  return { state, queue: queueFor(state, f.lane.laneId) }
}
const dialog = (id: string): LaneOp => ({
  type: 'extension_ui_response',
  response: { type: 'extension_ui_response', id, confirmed: true },
})
const remove = (laneId: string): LaneOp => ({
  type: 'lane.delete',
  laneId,
  removeWorktree: false,
  removeBranch: false,
})

describe('republishControl', () => {
  it('passes through when nothing is owed or the job has no lane', () => {
    const { state, queue } = setup()
    expect(republishControl(state, f.ports, job({ type: 'abort' }), queue)).toEqual(NOT_MATCHED)
    queue.controlUnpublished = true
    const machine: Job = {
      ...job({ type: 'routine.pauseAll' }),
      frame: { type: 'command', requestId: randomUUID(), op: { type: 'routine.pauseAll' } },
    }
    expect(republishControl(state, f.ports, machine, queue)).toEqual(NOT_MATCHED)
    expect(f.events).toEqual([])
    expect(queue.controlUnpublished).toBe(true)
  })

  it('republishes stored control, or answers unknown-lane and stops owing it once the lane is gone', () => {
    const { state, queue } = setup()
    queue.controlUnpublished = true
    expect(republishControl(state, f.ports, job({ type: 'abort' }), queue)).toEqual(NOT_MATCHED)
    expect(f.events.map(({ event }) => event)).toEqual([
      { kind: 'control', control: { fence: 1, controller: null } },
    ])
    expect(queue.controlUnpublished).toBe(false)
    queue.controlUnpublished = true
    const missing: Job = { ...job({ type: 'abort' }) }
    missing.frame = { ...missing.frame, laneId: randomUUID() }
    expect(republishControl(state, f.ports, missing, queue)).toEqual(handled())
    expect(f.last(missing.frame.requestId)).toMatchObject({ code: 'unknown-lane' })
    expect(queue.controlUnpublished).toBe(false)
  })

  it('answers failed internal when the republication fails again', () => {
    const { state, queue } = setup()
    queue.controlUnpublished = true
    f.ports.publish = () => {
      throw new Error('stream failed')
    }
    const current = job({ type: 'abort' })
    expect(republishControl(state, f.ports, current, queue)).toEqual(handled())
    expect(f.last(current.frame.requestId)).toMatchObject({
      status: 'failed',
      error: { code: 'internal', message: "the lane's control change could not be published" },
    })
    expect(queue.controlUnpublished).toBe(true)
  })
})

describe('laneRefusal', () => {
  it('orders stopped, refused, closed dialog, empty release and foreign delete refusals', () => {
    const lane = f.lane
    const refuse = (op: LaneOp, session: string | null, refusal: string | null = null) =>
      laneRefusal(
        { openDialogs: () => ['open'], refusal: () => refusal },
        job(op),
        lane,
        session,
        op.type === 'compact' ? { type: 'compact', id: 'x' } : null,
      )
    expect(refuse({ type: 'compact' }, null, 'no')).toMatchObject({ code: 'lane-stopped' })
    expect(refuse(dialog('open'), null)).toMatchObject({ code: 'lane-stopped' })
    expect(refuse({ type: 'compact' }, 'pi', 'no')).toMatchObject({ code: 'unsupported' })
    expect(refuse({ type: 'compact' }, 'pi')).toBeNull()
    expect(refuse(dialog('closed'), 'pi')).toMatchObject({ code: 'bad-request' })
    expect(refuse(dialog('open'), 'pi')).toBeNull()
    expect(refuse({ type: 'control.release' }, 'pi')).toEqual({
      requestId: expect.any(String),
      status: 'rejected',
      code: 'not-controller',
      control: lane.control,
    })
    expect(refuse(remove(randomUUID()), 'pi')).toMatchObject({ code: 'not-controller' })
    expect(refuse(remove(lane.laneId), 'pi')).toMatchObject({ code: 'not-controller' })
    const owned = {
      ...lane,
      control: { fence: 2, controller: { clientId: f.one.id, label: 'One', connected: true } },
    }
    expect(laneRefusal(f.ports, job(remove(lane.laneId)), owned, null, null)).toBeNull()
    expect(laneRefusal(f.ports, job({ type: 'control.release' }), owned, null, null)).toBeNull()
  })
})

describe('admitFence', () => {
  it('skips unfenced ops and refuses a missing fence', () => {
    const { state, queue } = setup()
    expect(admitFence(state, f.ports, job({ type: 'control.take' }, null), queue, f.lane)).toEqual({
      admitted: true,
      fence: undefined,
    })
    const missing = job({ type: 'abort' }, null)
    expect(admitFence(state, f.ports, missing, queue, f.lane)).toEqual({ admitted: false })
    expect(f.last(missing.frame.requestId)).toMatchObject({ code: 'bad-request' })
    expect(f.store.getLane(f.lane.laneId)?.control.fence).toBe(1)
  })

  it('acquires an empty lane, aborting uploads and publishing, and reuses a held fence silently', () => {
    const { state, queue } = setup()
    expect(admitFence(state, f.ports, job({ type: 'abort' }), queue, f.lane)).toEqual({
      admitted: true,
      fence: 2,
    })
    expect(abort).toHaveBeenCalledWith(f.lane.laneId)
    expect(f.order).toEqual(['control'])
    const lane = f.store.getLane(f.lane.laneId)
    if (!lane) throw new Error('missing lane')
    expect(admitFence(state, f.ports, job({ type: 'abort' }, 2), queue, lane)).toEqual({
      admitted: true,
      fence: 2,
    })
    expect(abort).toHaveBeenCalledTimes(1)
    expect(f.order).toEqual(['control'])
  })

  it('answers stale and viewer fences with control, and a failed publication as failed', () => {
    const { state, queue } = setup()
    f.store.takeControl(f.lane.laneId, { clientId: f.one.id, label: f.one.label })
    const lane = f.store.getLane(f.lane.laneId)
    if (!lane) throw new Error('missing lane')
    const stale = job({ type: 'abort' }, 1)
    expect(admitFence(state, f.ports, stale, queue, lane)).toEqual({ admitted: false })
    expect(f.last(stale.frame.requestId)).toMatchObject({
      code: 'stale-fence',
      control: { fence: 2 },
    })
    const viewer = job({ type: 'abort' }, 2, f.two)
    expect(admitFence(state, f.ports, viewer, queue, lane)).toEqual({ admitted: false })
    expect(f.last(viewer.frame.requestId)).toMatchObject({ code: 'not-controller' })
    f.store.releaseControl(f.lane.laneId, f.one.id)
    const empty = f.store.getLane(f.lane.laneId)
    if (!empty) throw new Error('missing lane')
    f.ports.publish = () => {
      throw new Error('stream failed')
    }
    const failing = job({ type: 'abort' }, 3)
    expect(admitFence(state, f.ports, failing, queue, empty)).toEqual({ admitted: false })
    expect(f.last(failing.frame.requestId)).toMatchObject({ status: 'failed' })
    expect(queue.controlUnpublished).toBe(true)
    expect(f.store.getLane(f.lane.laneId)?.control.fence).toBe(4)
  })
})

describe('admitLane', () => {
  it('refuses unknown and removed lanes, then refusals, then fences', () => {
    const { state, queue } = setup()
    const unknown = job({ type: 'abort' })
    unknown.frame = { ...unknown.frame, laneId: randomUUID() }
    expect(admitLane(state, f.ports, unknown, queue)).toBeNull()
    expect(f.last(unknown.frame.requestId)).toMatchObject({ code: 'unknown-lane' })
    const closed = job(dialog('closed'))
    expect(admitLane(state, f.ports, closed, queue)).toBeNull()
    expect(f.last(closed.frame.requestId)).toMatchObject({ code: 'bad-request' })
    f.store.markRemoved(f.lane.laneId)
    const removed = job({ type: 'abort' })
    expect(admitLane(state, f.ports, removed, queue)).toBeNull()
    expect(f.last(removed.frame.requestId)).toMatchObject({ code: 'unknown-lane' })
    expect(f.store.getLane(f.lane.laneId)?.control.fence).toBe(1)
  })

  it('returns the lane, its session, the pi command and the admitted fence', () => {
    const { state, queue } = setup()
    const prompt = job({ type: 'prompt', message: 'x' })
    expect(admitLane(state, f.ports, prompt, queue)).toEqual({
      laneId: f.lane.laneId,
      lane: expect.objectContaining({ laneId: f.lane.laneId }),
      sessionId: 'pi-live',
      piCommand: { type: 'prompt', message: 'x', id: prompt.frame.requestId },
      fence: 2,
    })
    f.sessions.clear()
    expect(admitLane(state, f.ports, job({ type: 'lane.markRead', upTo: 0 }), queue)).toMatchObject(
      {
        sessionId: null,
        piCommand: null,
        fence: undefined,
      },
    )
  })
})
