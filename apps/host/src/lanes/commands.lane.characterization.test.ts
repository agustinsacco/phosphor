import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOST_LIMITS, type LaneOp } from '@phosphor/shared/host-protocol'
import type { HostCapability } from '@phosphor/shared/remote-host'
import type { HostAttachments } from '../features/attachments'
import type { HostTerminals } from '../terminals/service'
import {
  createLaneCommands,
  type LaneCommandClient,
  type LaneCommandFrame,
  type LaneCommandPorts,
} from './commands'
import {
  createCommandsFixture,
  deferred,
  type CommandsFixture,
} from './__fixtures__/commands.fixture'

// Characterizes lane-scoped admission and execution through createLaneCommands
// before HA-11 moves them into admission, feature, RPC and lane handlers.

const EVERY: readonly HostCapability[] = [
  'sessions.read',
  'sessions.control',
  'workspaces.read',
  'workspaces.write',
  'artifacts.read',
  'skills.read',
  'terminal',
  'routines',
]

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

const all = (client: LaneCommandClient): LaneCommandClient => ({ ...client, caps: EVERY })
const recorded = (request: LaneCommandFrame, client = f.one) =>
  f.store.getReceipt(request.requestId, client.id)
const empty = () => ({ fence: 1, controller: null })
const dialog = (id = 'dialog'): LaneOp => ({
  type: 'extension_ui_response',
  response: { type: 'extension_ui_response', id, confirmed: true },
})
const remove = (laneId: string): LaneOp => ({
  type: 'lane.delete',
  laneId,
  removeWorktree: false,
  removeBranch: false,
})
const unfenced = (op: LaneOp, laneId = f.lane.laneId): LaneCommandFrame => ({
  type: 'command',
  requestId: randomUUID(),
  laneId,
  op,
})

describe('lane refusals answer before an empty lane is acquired', () => {
  it.each([
    [
      'an unknown lane, even without a fence',
      () => unfenced({ type: 'abort' }, randomUUID()),
      'unknown-lane',
    ],
    [
      'a stopped lane for pi, before refusal and fence',
      () => unfenced({ type: 'prompt', message: 'x' }),
      'lane-stopped',
    ],
    ['a stopped lane for a dialog answer', () => f.frame(dialog()), 'lane-stopped'],
  ] as const)('refuses %s', async (_name, request, code) => {
    f.sessions.clear()
    f.service = createLaneCommands({ ...f.ports, refusal: () => 'refused' })
    const frame = request()
    await f.service.submit(all(f.one), frame)
    expect(recorded(frame)).toEqual({ requestId: frame.requestId, status: 'rejected', code })
    expect(f.store.getLane(f.lane.laneId)?.control).toEqual(empty())
    expect(f.events).toEqual([])
  })

  it.each([
    ['a refusable pi op, before the fence', () => unfenced({ type: 'compact' }), 'unsupported'],
    ['a closed dialog id, before the fence', () => unfenced(dialog('closed')), 'bad-request'],
    ['a delete naming another lane', () => f.frame(remove(randomUUID())), 'not-controller'],
    ['a fenced op without a fence', () => unfenced({ type: 'lane.stop' }), 'bad-request'],
  ] as const)('refuses %s', async (_name, request, code) => {
    f.ports.deleteLane = vi.fn()
    f.service = createLaneCommands({
      ...f.ports,
      refusal: (command) => (command.type === 'compact' ? 'no' : null),
    })
    const frame = request()
    await f.service.submit(all(f.one), frame)
    expect(recorded(frame)).toEqual({ requestId: frame.requestId, status: 'rejected', code })
    expect(f.store.getLane(f.lane.laneId)?.control).toEqual(empty())
    expect(f.events).toEqual([])
    expect(f.command).not.toHaveBeenCalled()
  })

  it('refuses release of an empty lane with its control, and a removed lane as unknown', async () => {
    const release = unfenced({ type: 'control.release' })
    await f.service.submit(f.one, release)
    expect(recorded(release)).toEqual({
      requestId: release.requestId,
      status: 'rejected',
      code: 'not-controller',
      control: empty(),
    })
    f.store.markRemoved(f.lane.laneId)
    const removed = f.frame({ type: 'abort' })
    await f.service.submit(f.one, removed)
    expect(recorded(removed)).toMatchObject({ code: 'unknown-lane' })
    expect(f.events).toEqual([])
  })

  it('answers stale and viewer fences with the current control, without publishing', async () => {
    await f.service.submit(f.one, f.frame({ type: 'control.take' }))
    const events = f.events.length
    const stale = f.frame({ type: 'abort' }, 1)
    await f.service.submit(f.one, stale)
    const control = f.store.getLane(f.lane.laneId)?.control
    expect(recorded(stale)).toEqual({
      requestId: stale.requestId,
      status: 'rejected',
      code: 'stale-fence',
      control,
    })
    const viewer = f.frame({ type: 'abort' }, 2)
    await f.service.submit(f.two, viewer)
    expect(recorded(viewer, f.two)).toMatchObject({ code: 'not-controller', control: { fence: 2 } })
    expect(f.events).toHaveLength(events)
    expect(f.command).not.toHaveBeenCalled()
  })
})

describe('control publication around admission', () => {
  it('publishes and aborts uploads only when admission moves the fence', async () => {
    const abort = vi.fn()
    f.ports.attachments = { abort, execute: vi.fn() } as unknown as HostAttachments
    const first = f.service.submit(f.one, f.frame())
    expect(f.order).toEqual(['control', 'run'])
    expect(abort).toHaveBeenCalledTimes(1)
    const second = f.service.submit(f.one, f.frame({ type: 'abort' }, 2))
    expect(f.order).toEqual(['control', 'run', 'run'])
    expect(abort).toHaveBeenCalledTimes(1)
    f.finish(0)
    f.finish(1)
    await Promise.all([first, second])
  })

  it('republishes owed control before an unfenced op and a dialog answer, and fails closed when it cannot', async () => {
    const publish = f.ports.publish
    f.ports.publish = vi.fn(publish).mockImplementationOnce(() => {
      throw new Error('stream failed')
    })
    await f.service.submit(f.one, f.frame({ type: 'control.take' }))
    f.store.bumpAttention(f.lane.laneId)
    await f.service.submit(f.two, unfenced({ type: 'lane.markRead', upTo: 1 }))
    expect(f.order).toEqual(['control', 'summary'])
    vi.mocked(f.ports.publish).mockImplementationOnce(() => {
      throw new Error('stream failed')
    })
    await f.service.submit(f.two, f.frame({ type: 'control.take' }))
    vi.mocked(f.ports.publish).mockImplementationOnce(() => {
      throw new Error('stream failed again')
    })
    const answer = f.frame(dialog(), 3)
    await f.service.submit(f.two, answer)
    expect(recorded(answer, f.two)).toMatchObject({ status: 'failed', error: { code: 'internal' } })
    expect(f.respond).not.toHaveBeenCalled()
    const retried = f.frame(dialog(), 3)
    await f.service.submit(f.two, retried)
    expect(f.order).toEqual(['control', 'summary', 'control', 'dialog-resolved'])
    expect(recorded(retried, f.two)).toEqual({
      requestId: retried.requestId,
      status: 'done',
      fence: 3,
    })
  })
})

describe('pi and dialog execution is detached, lane work is serialized', () => {
  it('dispatches the next op while a prompt or a dialog answer is unanswered', async () => {
    const answered = deferred<void>()
    f.respond.mockImplementationOnce(() => answered.promise)
    const prompt = f.service.submit(f.one, f.frame())
    const answer = f.service.submit(f.one, f.frame(dialog(), 2))
    const abort = f.service.submit(f.one, f.frame({ type: 'abort' }, 2))
    expect(f.order).toEqual(['control', 'run', 'run'])
    expect(f.respond).toHaveBeenCalledTimes(1)
    f.finish(1)
    await abort
    answered.release()
    await answer
    f.finish(0)
    await prompt
    expect(f.order).toEqual(['control', 'run', 'run', 'dialog-resolved'])
  })

  it.each([
    ['lane.stop', () => ({ type: 'lane.stop' }) as const],
    ['terminal.create', () => ({ type: 'terminal.create', cols: 80, rows: 24 }) as const],
    [
      'attachments.begin',
      () => ({ type: 'attachments.begin', name: 'a', size: 1, mime: '' }) as const,
    ],
    ['files.create', () => ({ type: 'files.create', path: 'a', kind: 'file' }) as const],
    ['lane.delete', () => remove(f.lane.laneId)],
  ] as const)('holds the lane queue until %s completes', async (_name, op) => {
    const held = deferred<void>()
    const wait = async <T>(value: T) => {
      await held.promise
      return value
    }
    f.ports.stopLane = () => held.promise
    f.ports.terminals = { execute: () => wait(null) } as unknown as HostTerminals
    f.ports.attachments = {
      abort: vi.fn(),
      execute: () => wait({ ok: true }),
    } as unknown as HostAttachments
    f.ports.writes = {
      capabilityFor: () => 'workspaces.write',
      execute: () => wait({ ok: true as const }),
    }
    const deleteLane: NonNullable<LaneCommandPorts['deleteLane']> = () =>
      wait({ ok: true as const, data: { branchKept: true } })
    f.ports.deleteLane = deleteLane
    f.store.takeControl(f.lane.laneId, { clientId: f.one.id, label: f.one.label })
    const first = f.frame(op(), 2)
    const running = f.service.submit(all(f.one), first)
    const next = f.service.submit(all(f.one), f.frame({ type: 'abort' }, 2))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.command).not.toHaveBeenCalled()
    held.release()
    await running
    await vi.advanceTimersByTimeAsync(0)
    expect(f.command).toHaveBeenCalledTimes(1)
    f.finish(0)
    await next
    expect(recorded(first)?.status).toBe('done')
  })
})

describe('lane deletion', () => {
  it('checks the admitted fence, the controller and live capabilities, and maps its results', async () => {
    let live: readonly HostCapability[] = EVERY
    const client: LaneCommandClient = { ...all(f.one), currentCaps: () => live }
    const answers: (boolean | undefined)[] = []
    const held = deferred<{ ok: true; data: { branchKept: boolean } }>()
    const deleteLane = vi
      .fn<NonNullable<LaneCommandPorts['deleteLane']>>()
      .mockImplementationOnce(async (_op, allowed) => {
        answers.push(allowed())
        f.store.takeControl(f.lane.laneId, { clientId: f.one.id, label: f.one.label })
        answers.push(allowed())
        return { ok: true, data: { branchKept: true } }
      })
      .mockImplementationOnce(async (_op, allowed) => {
        live = ['sessions.control']
        answers.push(allowed())
        live = EVERY
        return { ok: false, code: 'not-controller' }
      })
      .mockImplementationOnce(() => held.promise)
    f.ports.deleteLane = deleteLane
    f.store.takeControl(f.lane.laneId, { clientId: f.one.id, label: f.one.label })
    const done = f.frame(remove(f.lane.laneId), 2)
    await f.service.submit(client, done)
    expect(recorded(done)).toEqual({
      requestId: done.requestId,
      status: 'done',
      data: { branchKept: true },
    })
    const refused = f.frame(remove(f.lane.laneId), 3)
    await f.service.submit(client, refused)
    expect(recorded(refused)).toMatchObject({ status: 'rejected', code: 'not-controller' })
    const slow = f.frame(remove(f.lane.laneId), 3)
    const running = f.service.submit(client, slow)
    await vi.advanceTimersByTimeAsync(HOST_LIMITS.commandAnswerMs)
    await running
    expect(recorded(slow)).toEqual({ requestId: slow.requestId, status: 'unknown' })
    expect(answers).toEqual([true, false, false])
    held.release({ ok: true, data: { branchKept: false } })
    await vi.advanceTimersByTimeAsync(0)
    expect(recorded(slow)?.status).toBe('unknown')
  })
})
