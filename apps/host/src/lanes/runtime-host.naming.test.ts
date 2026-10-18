import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionPush } from '@phosphor/shared/models'
import type { RpcCommand, RpcSessionState } from '@phosphor/shared/rpc'
import { fakeMachine, type FakeMachine } from '../__fixtures__/machine'
import type { HostRuntime, Delivery } from '../session/runtime'
import { createRuntimeLanes } from './runtime-host'
import { createLiveLanes } from './live'
import { openStore, type HostStore } from './store'

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
function setup(
  pushes: SessionPush[] = [],
  nameLane?: Parameters<typeof createRuntimeLanes>[0]['nameLane'],
) {
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
  const binding = createRuntimeLanes({ runtime, store, live, log, nameLane })
  const saved = () => store.ensureLane({ repositoryId, cwd: machine.repository, sessionFile: null })
  return { runtime, binding, saved, log, push: (push: SessionPush) => deliver(push) }
}
describe('runtime lane binding', () => {
  it.each(['none', 'rename', 'native-rename', 'stop', 'removed'] as const)(
    'names once through its own runtime and skips after %s',
    async (change) => {
      const nameLane = vi.fn<NonNullable<Parameters<typeof createRuntimeLanes>[0]['nameLane']>>()
      const s = setup([], nameLane)
      const session = await s.binding.sessions.start({ repository: machine.repository })
      const lane = s.saved()
      await s.binding.sessions.attach(lane.laneId, session.sessionId)
      s.runtime.command.mockImplementation(async (_id, cmd) => ({
        type: 'response',
        command: cmd.type,
        success: true,
        data:
          cmd.type === 'get_available_models'
            ? { models: [] }
            : {
                ...state,
                model: {
                  provider: 'test',
                  id: 'lane-model',
                  name: 'Test',
                  api: 'test',
                  reasoning: false,
                  input: ['text'],
                  contextWindow: 200000,
                  maxTokens: 4096,
                  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
                },
              },
      }))
      await s.binding.command(session.sessionId, {
        type: 'prompt',
        message: '  Fix the first bug\nMore detail',
      })
      await vi.waitFor(() => expect(nameLane).toHaveBeenCalledTimes(1))
      expect(live.summaryFor(lane.laneId)?.title).toBe('Fix the first bug')
      expect(store.getLane(lane.laneId)?.title).toBe('Fix the first bug')
      const job = nameLane.mock.calls[0]?.[0]
      if (!job) throw new Error('missing job')
      expect(job.model).toMatchObject({ provider: 'test', id: 'lane-model' })
      await s.binding.command(session.sessionId, { type: 'prompt', message: 'second' })
      await new Promise((resolve) => setImmediate(resolve))
      expect(nameLane).toHaveBeenCalledTimes(1)
      if (change === 'rename')
        await s.binding.command(session.sessionId, { type: 'set_session_name', name: 'Manual' })
      if (change === 'stop') await s.binding.deleteStop(lane.laneId)
      if (change === 'removed') store.markRemoved(lane.laneId)
      if (change === 'native-rename')
        s.runtime.command.mockImplementation(async (_id, cmd) => ({
          type: 'response',
          command: cmd.type,
          success: true,
          data: { ...state, sessionName: 'Native rename' },
        }))
      s.runtime.command.mockClear()
      const applied = await job.apply('Generated title')
      job.outcome?.(applied ?? 'applied')
      job.outcome?.('print-failed')
      expect(s.log.mock.calls.filter((c) => c[1] === 'lane.naming')).toEqual([
        [
          'host',
          'lane.naming',
          {
            laneId: lane.laneId,
            outcome: change === 'none' ? 'applied' : 'stale',
            ms: expect.any(Number),
          },
        ],
      ])
      expect(
        s.runtime.command.mock.calls.filter((c) => c[1].type === 'set_session_name'),
      ).toHaveLength(change === 'none' ? 1 : 0)
      if (change === 'none') expect(store.getLane(lane.laneId)?.title).toBe('Generated title')
      if (change === 'rename') expect(store.getLane(lane.laneId)?.title).toBe('Manual')
    },
  )
  it.each(['skipped-not-eligible', 'skipped-no-model'] as const)(
    'logs one private-data-free naming diagnostic for %s',
    async (expected) => {
      const nameLane = vi.fn<NonNullable<Parameters<typeof createRuntimeLanes>[0]['nameLane']>>()
      const s = setup([], nameLane)
      if (expected === 'skipped-not-eligible')
        s.runtime.command.mockImplementation(async (_id, cmd) => ({
          type: 'response',
          command: cmd.type,
          success: true,
          data: cmd.type === 'get_messages' ? { messages: [] } : { ...state, messageCount: 2 },
        }))
      const session = await s.binding.sessions.start({ repository: machine.repository })
      const lane = s.saved()
      await s.binding.sessions.attach(lane.laneId, session.sessionId)
      await s.binding.command(session.sessionId, { type: 'prompt', message: 'private prompt' })
      await vi.waitFor(() =>
        expect(s.log).toHaveBeenCalledWith('host', 'lane.naming', {
          laneId: lane.laneId,
          outcome: expected,
          ms: expect.any(Number),
        }),
      )
      await s.binding.command(session.sessionId, {
        type: 'prompt',
        message: 'another private prompt',
      })
      expect(s.log.mock.calls.filter((c) => c[1] === 'lane.naming')).toHaveLength(1)
      expect(nameLane).not.toHaveBeenCalled()
    },
  )

  it('keeps naming disabled when not configured', async () => {
    const s = setup()
    const session = await s.binding.sessions.start({ repository: machine.repository })
    const lane = s.saved()
    await s.binding.sessions.attach(lane.laneId, session.sessionId)
    await s.binding.command(session.sessionId, { type: 'prompt', message: 'Fallback only' })
    expect(live.summaryFor(lane.laneId)?.title).toBe('Fallback only')
    expect(s.runtime.command.mock.calls.some((c) => c[1].type === 'get_available_models')).toBe(
      false,
    )
  })
})
