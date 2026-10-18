import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOST_LIMITS, type LaneOp, type Receipt } from '@phosphor/shared/host-protocol'
import type { HostCapability } from '@phosphor/shared/remote-host'
import { TerminalForbidden } from '../../terminals/service'
import {
  executeMachineTerminal,
  executeRepository,
  executeRoutine,
  type MachinePorts,
} from './machine'
import { handled, NOT_MATCHED } from './routing'
import { queueFor } from './queue'
import { createCommandState, type Job, type LaneCommandFrame, type LaneCommandPorts } from './state'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

function setup() {
  const state = createCommandState()
  const queue = queueFor(state, '')
  const ports = {
    store: { finishRequest: vi.fn<(requestId: string, receipt: Receipt) => void>() },
    deliver: vi.fn<LaneCommandPorts['deliver']>(),
    log: vi.fn<LaneCommandPorts['log']>(),
    now: () => 0,
    repositories: {
      execute: vi.fn<NonNullable<LaneCommandPorts['repositories']>['execute']>(async () => ({
        ok: true,
      })),
    },
    routines: {
      execute: vi.fn<NonNullable<LaneCommandPorts['routines']>['execute']>(async () => null),
    },
    providerLogins: {
      execute: vi.fn<NonNullable<LaneCommandPorts['providerLogins']>['execute']>(async () => ({
        terminalId: 'login',
      })),
    },
    terminals: {
      machineOp: vi.fn<NonNullable<MachinePorts['terminals']>['machineOp']>(() => null),
    },
  } satisfies MachinePorts
  const recorded = () => ports.store.finishRequest.mock.calls.map(([, receipt]) => receipt)
  return { state, queue, ports, recorded }
}
const clientId = randomUUID()
function job(op: LaneOp, extra: Partial<LaneCommandFrame> = {}): Job {
  return {
    client: { id: clientId, label: 'One', caps: ['sessions.control'] },
    frame: { type: 'command', requestId: randomUUID(), op, ...extra },
    started: 0,
    resolve: vi.fn(),
  }
}
const add: LaneOp = { type: 'host.repositories.add', path: 'repo' }
const pause: LaneOp = { type: 'routine.pauseAll' }
const login: LaneOp = { type: 'provider.login', provider: 'xai' }
const kill: LaneOp = { type: 'terminal.kill', terminalId: randomUUID() }
const yes = () => true
async function settle(routed: ReturnType<typeof executeRepository>) {
  if (!routed.handled || !routed.execution) throw new Error('expected an execution')
  expect(routed.execution.detached).toBe(false)
  await routed.execution.completion
}

describe('parser selection', () => {
  it('matches only its own family and leaves every other op unanswered', () => {
    const { state, queue, ports, recorded } = setup()
    const caps: readonly HostCapability[] = ['routines']
    const others: LaneOp[] = [pause, login, kill, { type: 'prompt', message: 'x' }]
    for (const op of others)
      expect(executeRepository(state, ports, job(op), queue, yes)).toEqual(NOT_MATCHED)
    for (const op of [add, login, kill, { type: 'lane.stop' } as const])
      expect(executeRoutine(state, ports, job(op), queue, caps)).toEqual(NOT_MATCHED)
    for (const routed of [
      executeMachineTerminal(state, ports, job(add), queue, yes),
      executeMachineTerminal(state, ports, job(pause), queue, yes),
      executeMachineTerminal(state, ports, job(kill, { laneId: randomUUID() }), queue, yes),
      executeMachineTerminal(state, ports, job({ type: 'abort' }), queue, yes),
    ])
      expect(routed).toEqual(NOT_MATCHED)
    expect(recorded()).toEqual([])
    expect(handled()).toEqual({ handled: true, execution: undefined })
  })
})

describe('executeRepository', () => {
  it('answers a missing port or any lane scope synchronously as bad-request', () => {
    const { state, queue, ports, recorded } = setup()
    for (const extra of [{ laneId: randomUUID() }, { fence: 1 }])
      expect(executeRepository(state, ports, job(add, extra), queue, yes)).toEqual(handled())
    const { repositories: _repositories, ...portless } = ports
    expect(executeRepository(state, portless, job(add), queue, yes)).toEqual(handled())
    expect(recorded().map((receipt) => receipt.status === 'rejected' && receipt.code)).toEqual([
      'bad-request',
      'bad-request',
      'bad-request',
    ])
    expect(ports.repositories.execute).not.toHaveBeenCalled()
  })

  it('maps data, refusal codes and deadlines, passing the authority callback through', async () => {
    const { state, queue, ports, recorded } = setup()
    const allowed = vi.fn(() => true)
    ports.repositories.execute
      .mockResolvedValueOnce({ ok: true, data: { added: 1 } })
      .mockResolvedValueOnce({ ok: false, code: 'conflict' })
      .mockImplementationOnce(() => new Promise(() => {}))
    const first = job(add)
    await settle(executeRepository(state, ports, first, queue, allowed))
    expect(ports.repositories.execute).toHaveBeenCalledWith(add, allowed)
    await settle(executeRepository(state, ports, job(add), queue, allowed))
    const slow = executeRepository(state, ports, job(add), queue, allowed)
    await vi.advanceTimersByTimeAsync(HOST_LIMITS.commandAnswerMs)
    await settle(slow)
    expect(recorded()).toEqual([
      { requestId: first.frame.requestId, status: 'done', data: { added: 1 } },
      expect.objectContaining({ status: 'rejected', code: 'conflict' }),
      expect.objectContaining({ status: 'unknown' }),
    ])
    expect(ports.log.mock.calls.at(-1)?.[2]).toMatchObject({ status: 'unknown', reason: undefined })
    expect(queue.outstanding).toBe(1)
  })
})

describe('executeRoutine', () => {
  it('refuses a missing port before scope, then scope, and passes the execution-time caps', async () => {
    const { state, queue, ports, recorded } = setup()
    const caps: readonly HostCapability[] = ['routines', 'skills.read']
    const { routines: _routines, ...portless } = ports
    expect(
      executeRoutine(state, portless, job(pause, { laneId: randomUUID(), fence: 1 }), queue, caps),
    ).toEqual(handled())
    for (const extra of [{ laneId: randomUUID() }, { fence: 1 }])
      expect(executeRoutine(state, ports, job(pause, extra), queue, caps)).toEqual(handled())
    expect(recorded().map((receipt) => receipt.status === 'rejected' && receipt.code)).toEqual([
      'unsupported',
      'bad-request',
      'bad-request',
    ])
    ports.routines.execute.mockResolvedValueOnce({ paused: 2 })
    const run = job(pause)
    await settle(executeRoutine(state, ports, run, queue, caps))
    expect(ports.routines.execute).toHaveBeenCalledWith(pause, run.frame.requestId, caps)
    expect(recorded().at(-1)).toEqual({
      requestId: run.frame.requestId,
      status: 'done',
      data: { paused: 2 },
    })
    ports.routines.execute.mockRejectedValueOnce(new Error('private'))
    await settle(executeRoutine(state, ports, job(pause), queue, caps))
    expect(recorded().at(-1)).toMatchObject({ status: 'unknown' })
  })
})

describe('executeMachineTerminal', () => {
  it('refuses lane or fence fields on logins and machine terminals', () => {
    const { state, queue, ports, recorded } = setup()
    for (const routed of [
      executeMachineTerminal(state, ports, job(login, { fence: 1 }), queue, yes),
      executeMachineTerminal(state, ports, job(login, { laneId: randomUUID() }), queue, yes),
      executeMachineTerminal(state, ports, job(kill, { fence: 1 }), queue, yes),
    ])
      expect(routed).toEqual(handled())
    expect(recorded().every((receipt) => receipt.status === 'rejected')).toBe(true)
    expect(recorded()).toHaveLength(3)
  })

  it('maps logins and machine ops to done data, and refusals or missing ports to unknown', async () => {
    const { state, queue, ports, recorded } = setup()
    const allowed = vi.fn(() => true)
    const started = job(login)
    await settle(executeMachineTerminal(state, ports, started, queue, allowed))
    expect(ports.providerLogins.execute).toHaveBeenCalledWith(login, clientId, allowed)
    const killed = job(kill)
    await settle(executeMachineTerminal(state, ports, killed, queue, allowed))
    expect(ports.terminals.machineOp).toHaveBeenCalledWith(clientId, kill)
    ports.terminals.machineOp.mockImplementationOnce(() => {
      throw new TerminalForbidden('forbidden')
    })
    await settle(executeMachineTerminal(state, ports, job(kill), queue, allowed))
    const { providerLogins: _logins, terminals: _terminals, ...portless } = ports
    await settle(executeMachineTerminal(state, portless, job(login), queue, allowed))
    await settle(executeMachineTerminal(state, portless, job(kill), queue, allowed))
    allowed.mockReturnValue(false)
    await settle(executeMachineTerminal(state, ports, job(login), queue, allowed))
    expect(recorded()).toEqual([
      { requestId: started.frame.requestId, status: 'done', data: { terminalId: 'login' } },
      { requestId: killed.frame.requestId, status: 'done', data: null },
      ...Array.from({ length: 4 }, () => expect.objectContaining({ status: 'unknown' })),
    ])
    expect(ports.providerLogins.execute).toHaveBeenCalledTimes(1)
    expect(ports.terminals.machineOp).toHaveBeenCalledTimes(2)
  })
})
