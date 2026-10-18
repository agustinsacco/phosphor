import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionPush } from '@phosphor/shared/models'
import type { RpcCommand, RpcSessionState } from '@phosphor/shared/rpc'
import { fakeMachine, type FakeMachine } from '../../__fixtures__/machine'
import type { HostRuntime, Delivery } from '../../session/runtime'
import type { RuntimeLaneState, RuntimeLaneOptions } from './state'
import { start, attach } from './lifecycle'
import { command } from './command'
import { createLiveLanes } from '../live'
import { openStore, type HostStore } from '../store'

const state: RpcSessionState = {
  sessionId: 'pi-id',
  thinkingLevel: 'off',
  isStreaming: false,
  isCompacting: false,
  steeringMode: 'all',
  followUpMode: 'all',
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
}
let machine: FakeMachine
let store: HostStore
let live: ReturnType<typeof createLiveLanes>
let repositoryId: string
beforeEach(async () => {
  machine = fakeMachine({ rpc: true })
  vi.stubEnv('PATH', process.env.PATH)
  vi.stubEnv('PI_CODING_AGENT_DIR', machine.agentDir)
  vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', undefined)
  store = await openStore(join(machine.dir, 'state'), process.getuid?.())
  const repository = store.syncRepositories([machine.repository])[0]
  if (!repository) throw new Error('fixture')
  repositoryId = repository.id
})
afterEach(async () => {
  live?.close()
  store.close()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  machine.cleanup()
})
function setup(pushes: SessionPush[] = [], nameLane?: RuntimeLaneOptions['nameLane']) {
  let deliver: Delivery = () => {}
  const command = vi.fn(
    async (_id: string, cmd: RpcCommand): ReturnType<HostRuntime['command']> => ({
      type: 'response',
      command: cmd.type,
      success: true,
      data: cmd.type === 'get_messages' ? { messages: [] } : state,
    }),
  )
  const runtime = {
    start: vi.fn(async (_request: unknown, sink?: Delivery) => {
      deliver = sink ?? (() => {})
      for (const push of pushes) deliver(push)
      return { sessionId: randomUUID(), workspacePath: machine.repository }
    }),
    stop: vi.fn(async (_sessionId: string) => {}),
    command,
    extensionUiResponse: vi.fn(),
  }
  live = createLiveLanes({ epoch: '0123456789abcdef', store, runtime, now: Date.now, log: vi.fn() })
  const log = vi.fn()
  const context: RuntimeLaneState = {
    options: { runtime, store, live, log, nameLane },
    bindings: new Map(),
  }
  const saved = () => store.ensureLane({ repositoryId, cwd: machine.repository, sessionFile: null })
  return { runtime, context, saved, log, push: (push: SessionPush) => deliver(push) }
}

async function attached() {
  const s = setup()
  const session = await start(s.context, {})
  const lane = s.saved()
  await attach(s.context, lane.laneId, session.sessionId)
  return {
    ...s,
    sessionId: session.sessionId,
    laneId: lane.laneId,
    binding: s.context.bindings.get(session.sessionId)!,
  }
}
describe('runtime command orchestration', () => {
  it.each(['guard', 'dispatch', 'refresh'] as const)(
    'releases the model lock after a %s exception',
    async (failure) => {
      const s = await attached()
      const original = s.runtime.command.getMockImplementation()!
      let states = 0
      s.runtime.command.mockImplementation(async (...args) => {
        expect(s.binding.switching).toBe(true)
        if (
          (args[1].type === 'get_state' && ++states === (failure === 'guard' ? 1 : 2)) ||
          (failure === 'dispatch' && args[1].type === 'set_model')
        )
          throw new Error(failure)
        return original(...args)
      })
      await expect(
        command(s.context, s.sessionId, { type: 'set_model', provider: 'new', modelId: 'model' }),
      ).rejects.toThrow(failure)
      expect(s.binding.switching).toBe(false)
      s.runtime.command.mockImplementation(original)
      expect(
        await command(s.context, s.sessionId, { type: 'prompt', message: 'next' }),
      ).toMatchObject({ success: true })
    },
  )
  it('keeps the model lock across attachment refresh and rejects every concurrent command', async () => {
    const s = await attached()
    let release: () => void = () => {}
    let reached: () => void = () => {}
    const paused = new Promise<void>((resolve) => {
      reached = resolve
    })
    vi.spyOn(s.binding.attachment!, 'stateChanged').mockImplementationOnce(async () => {
      reached()
      await new Promise<void>((resolve) => {
        release = resolve
      })
    })
    const changing = command(s.context, s.sessionId, {
      type: 'set_model',
      provider: 'new',
      modelId: 'model',
    })
    await paused
    for (const cmd of [
      { type: 'prompt', message: 'blocked' },
      { type: 'set_session_name', name: 'blocked' },
      { type: 'get_state' },
      { type: 'set_model', provider: 'new', modelId: 'other' },
    ] satisfies RpcCommand[]) {
      expect(await command(s.context, s.sessionId, cmd)).toEqual({
        type: 'response',
        command: cmd.type,
        success: false,
        error: 'Wait for the model change to finish.',
      })
    }
    expect(s.binding.renameRevision).toBeUndefined()
    release()
    expect(await changing).toMatchObject({ success: true })
    expect(s.binding.switching).toBe(false)
  })
  it('invalidates generated naming before even a failed manual rename dispatch', async () => {
    const s = await attached()
    s.binding.namingEligible = true
    s.runtime.command.mockImplementation(async (_id, cmd) => {
      expect(s.binding.renameRevision).toBe(1)
      expect(s.binding.namingEligible).toBe(false)
      return { type: 'response', command: cmd.type, success: false, error: 'no' }
    })
    expect(
      await command(s.context, s.sessionId, { type: 'set_session_name', name: 'Manual' }),
    ).toMatchObject({ success: false })
    expect(store.getLane(s.laneId)?.title).toBeNull()
  })
  it('learns state before model dispatch, persists after confirmation, then refreshes', async () => {
    const s = await attached()
    const order: string[] = []
    const original = s.runtime.command.getMockImplementation()!
    s.runtime.command.mockImplementation(async (...args) => {
      order.push(args[1].type)
      return original(...args)
    })
    vi.spyOn(s.binding.attachment!, 'stateChanged').mockImplementationOnce(async () => {
      order.push('refresh')
    })
    await command(s.context, s.sessionId, { type: 'set_model', provider: 'new', modelId: 'model' })
    expect(order).toEqual(['get_state', 'set_model', 'get_state', 'refresh'])
    expect(s.binding.switching).toBe(false)
  })
  it('routes unknown sessions directly and does not refresh failed mutations', async () => {
    const s = setup()
    const response = {
      type: 'response',
      command: 'set_thinking_level',
      success: false,
      error: 'no',
    } as const
    s.runtime.command.mockResolvedValueOnce(response)
    expect(await command(s.context, 'unknown', { type: 'set_thinking_level', level: 'high' })).toBe(
      response,
    )
    expect(s.runtime.command).toHaveBeenCalledExactlyOnceWith('unknown', {
      type: 'set_thinking_level',
      level: 'high',
    })
  })
})
