import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOST_LIMITS, type LaneOp, type Receipt } from '@phosphor/shared/host-protocol'
import { TerminalForbidden } from '../../terminals/service'
import type { LaneAdmission } from './admission'
import {
  executeAttachment,
  executeLaneFeature,
  executeLaneTerminal,
  executeWrite,
  type FeaturePorts,
} from './features'
import { handled, NOT_MATCHED, type Routed } from './routing'
import { queueFor } from './queue'
import { createCommandState, type Job, type LaneCommandPorts } from './state'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const laneId = randomUUID()
const clientId = randomUUID()
function setup() {
  const state = createCommandState()
  const queue = queueFor(state, laneId)
  const ports = {
    store: { finishRequest: vi.fn<(requestId: string, receipt: Receipt) => void>() },
    deliver: vi.fn<LaneCommandPorts['deliver']>(),
    log: vi.fn<LaneCommandPorts['log']>(),
    now: () => 0,
    terminals: {
      execute: vi.fn<NonNullable<FeaturePorts['terminals']>['execute']>(async () => null),
    },
    attachments: {
      execute: vi.fn<NonNullable<FeaturePorts['attachments']>['execute']>(async () => ({
        ok: true,
      })),
    },
    writes: {
      capabilityFor: () => 'workspaces.write' as const,
      execute: vi.fn<NonNullable<LaneCommandPorts['writes']>['execute']>(async () => ({
        ok: true,
      })),
    },
  } satisfies FeaturePorts
  const receipts = () => ports.store.finishRequest.mock.calls.map(([, receipt]) => receipt)
  return { state, queue, ports, receipts }
}
function job(op: LaneOp): Job {
  return {
    client: { id: clientId, label: 'One', caps: ['sessions.control'] },
    frame: { type: 'command', requestId: randomUUID(), laneId, fence: 2, op },
    started: 0,
    resolve: vi.fn(),
  }
}
const lane: LaneAdmission['lane'] = {
  laneId,
  repositoryId: '0123456789abcdef',
  cwd: '/repo',
  title: null,
  branch: null,
  worktree: false,
  model: null,
  activity: 'idle',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  attention: 0,
  read: 0,
  control: { fence: 2, controller: { clientId, label: 'One', connected: true } },
  sessionFile: null,
  removedAt: null,
}
const admitted: LaneAdmission = {
  laneId,
  lane,
  sessionId: 'pi',
  piCommand: null,
  fence: 2,
}
const create: LaneOp = { type: 'terminal.create', cols: 80, rows: 24 }
const begin: LaneOp = { type: 'attachments.begin', name: 'a.txt', size: 1, mime: '' }
const write: LaneOp = { type: 'files.create', path: 'a', kind: 'file' }
const yes = () => true
async function settle(routed: Routed) {
  if (!routed.handled || !routed.execution) throw new Error('expected an execution')
  expect(routed.execution.detached).toBe(false)
  await routed.execution.completion
}

describe('executeLaneTerminal', () => {
  it('matches terminal ops only, and refuses a missing port as unsupported', () => {
    const { state, queue, ports, receipts } = setup()
    expect(executeLaneTerminal(state, ports, job(begin), queue, admitted, yes)).toEqual(NOT_MATCHED)
    const { terminals: _terminals, ...portless } = ports
    expect(executeLaneTerminal(state, portless, job(create), queue, admitted, yes)).toEqual(
      handled(),
    )
    expect(receipts()).toEqual([expect.objectContaining({ code: 'unsupported' })])
  })

  it('maps data with the fence, refusals to forbidden and failures to unknown', async () => {
    const { state, queue, ports, receipts } = setup()
    const allowed = vi.fn(yes)
    ports.terminals.execute
      .mockResolvedValueOnce({ terminalId: 't' })
      .mockRejectedValueOnce(new TerminalForbidden('forbidden'))
      .mockRejectedValueOnce(new Error('private'))
    const done = job(create)
    await settle(executeLaneTerminal(state, ports, done, queue, admitted, allowed))
    expect(ports.terminals.execute).toHaveBeenCalledWith(laneId, create, allowed)
    await settle(executeLaneTerminal(state, ports, job(create), queue, admitted, allowed))
    await settle(executeLaneTerminal(state, ports, job(create), queue, admitted, allowed))
    expect(receipts()).toEqual([
      { requestId: done.frame.requestId, status: 'done', data: { terminalId: 't' }, fence: 2 },
      expect.objectContaining({ status: 'rejected', code: 'forbidden' }),
      expect.objectContaining({ status: 'unknown' }),
    ])
  })
})

describe('executeAttachment', () => {
  it('refuses a missing port or an unfenced admission as unsupported', () => {
    const { state, queue, ports, receipts } = setup()
    expect(executeAttachment(state, ports, job(write), queue, admitted)).toEqual(NOT_MATCHED)
    const { attachments: _attachments, ...portless } = ports
    expect(executeAttachment(state, portless, job(begin), queue, admitted)).toEqual(handled())
    expect(
      executeAttachment(state, ports, job(begin), queue, { ...admitted, fence: undefined }),
    ).toEqual(handled())
    expect(receipts().map((receipt) => receipt.status === 'rejected' && receipt.code)).toEqual([
      'unsupported',
      'unsupported',
    ])
    expect(ports.attachments.execute).not.toHaveBeenCalled()
  })

  it('owns the upload at the admitted fence and maps data, refusals and deadlines', async () => {
    const { state, queue, ports, receipts } = setup()
    ports.attachments.execute
      .mockResolvedValueOnce({ ok: true, data: { uploadId: 'u' } })
      .mockResolvedValueOnce({ ok: false, code: 'bad-request' })
      .mockImplementationOnce(() => new Promise(() => {}))
    const done = job(begin)
    await settle(executeAttachment(state, ports, done, queue, admitted))
    expect(ports.attachments.execute).toHaveBeenCalledWith({ laneId, clientId, fence: 2 }, begin)
    await settle(executeAttachment(state, ports, job(begin), queue, admitted))
    const slow = executeAttachment(state, ports, job(begin), queue, admitted)
    await vi.advanceTimersByTimeAsync(HOST_LIMITS.commandAnswerMs)
    await settle(slow)
    expect(receipts()).toEqual([
      { requestId: done.frame.requestId, status: 'done', data: { uploadId: 'u' }, fence: 2 },
      expect.objectContaining({ status: 'rejected', code: 'bad-request' }),
      expect.objectContaining({ status: 'unknown' }),
    ])
    expect(ports.log.mock.calls.at(-1)?.[2]).toMatchObject({ reason: 'deadline' })
  })
})

describe('executeWrite', () => {
  it('matches files ops only, and refuses an unparsable op or a missing port as unsupported', () => {
    const { state, queue, ports, receipts } = setup()
    expect(executeWrite(state, ports, job(create), queue, admitted)).toEqual(NOT_MATCHED)
    const invalid: LaneOp = { type: 'files.create', path: '', kind: 'file' }
    expect(executeWrite(state, ports, job(invalid), queue, admitted)).toEqual(handled())
    const { writes: _writes, ...portless } = ports
    expect(executeWrite(state, portless, job(write), queue, admitted)).toEqual(handled())
    expect(receipts().map((receipt) => receipt.status === 'rejected' && receipt.code)).toEqual([
      'unsupported',
      'unsupported',
    ])
  })

  it('maps data with the fence and refusal codes', async () => {
    const { state, queue, ports, receipts } = setup()
    ports.writes.execute
      .mockResolvedValueOnce({ ok: true, data: { revision: 'r' } })
      .mockResolvedValueOnce({ ok: false, code: 'conflict' })
    const done = job(write)
    await settle(executeWrite(state, ports, done, queue, admitted))
    expect(ports.writes.execute).toHaveBeenCalledWith(laneId, write)
    await settle(executeWrite(state, ports, job(write), queue, admitted))
    expect(receipts()).toEqual([
      { requestId: done.frame.requestId, status: 'done', data: { revision: 'r' }, fence: 2 },
      expect.objectContaining({ status: 'rejected', code: 'conflict' }),
    ])
  })
})

describe('executeLaneFeature', () => {
  it('routes terminal, attachment and files ops in order and leaves the rest unmatched', async () => {
    const { state, queue, ports } = setup()
    for (const op of [create, begin, write])
      await settle(executeLaneFeature(state, ports, job(op), queue, admitted, yes))
    expect(ports.terminals.execute).toHaveBeenCalledTimes(1)
    expect(ports.attachments.execute).toHaveBeenCalledTimes(1)
    expect(ports.writes.execute).toHaveBeenCalledTimes(1)
    expect(executeLaneFeature(state, ports, job({ type: 'abort' }), queue, admitted, yes)).toEqual(
      NOT_MATCHED,
    )
  })
})
