import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionPush } from '@phosphor/shared/models'
import type { RpcCommand, RpcSessionState } from '@phosphor/shared/rpc'
import { fakeMachine, type FakeMachine } from '../../__fixtures__/machine'
import type { HostRuntime, Delivery } from '../../session/runtime'
import type { RuntimeLaneState, RuntimeLaneOptions } from './state'
import { start, attach } from './lifecycle'
import { firstPrompt, applyGeneratedTitle, recordManualName } from './naming'
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

function laneModel(provider: string, id = 'model') {
  return {
    provider,
    id,
    name: id,
    api: 'test',
    reasoning: false,
    input: ['text'],
    contextWindow: 200000,
    maxTokens: 4096,
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  }
}

async function attached() {
  const nameLane = vi.fn<NonNullable<RuntimeLaneOptions['nameLane']>>()
  const s = setup([], nameLane)
  const session = await start(s.context, {})
  const lane = s.saved()
  await attach(s.context, lane.laneId, session.sessionId)
  const binding = s.context.bindings.get(session.sessionId)!
  const selected: RpcSessionState = { ...state, model: laneModel('test') }
  s.runtime.command.mockImplementation(async (_id, cmd) => ({
    type: 'response',
    command: cmd.type,
    success: true,
    data: selected,
  }))
  return { ...s, sessionId: session.sessionId, laneId: lane.laneId, binding, selected, nameLane }
}
describe('first-prompt naming helpers', () => {
  it.each(['blank', 'existing', 'removed', 'fallback'] as const)(
    'preserves the %s fallback policy',
    async (title) => {
      const s = await attached()
      s.binding.namingConsidered = true
      if (title === 'existing') store.updateLane(s.laneId, { title: 'Existing' })
      if (title === 'removed') store.markRemoved(s.laneId)
      firstPrompt(
        s.context,
        s.sessionId,
        s.binding,
        s.laneId,
        title === 'blank' ? '  ' : '  First line\nSecond',
      )
      expect(store.getLane(s.laneId)?.title).toBe(
        title === 'existing' ? 'Existing' : title === 'fallback' ? 'First line' : null,
      )
      expect(s.nameLane).not.toHaveBeenCalled()
    },
  )
  it.each(['eligibility', 'model', 'named', 'metadata-failure'] as const)(
    'reports %s once without private content',
    async (failure) => {
      const s = await attached()
      if (failure === 'eligibility') s.binding.namingEligible = false
      if (failure === 'named') s.selected.sessionName = 'Private name'
      if (failure === 'model') s.selected.model = undefined
      if (failure === 'metadata-failure')
        s.runtime.command.mockRejectedValueOnce(new Error('private'))
      firstPrompt(s.context, s.sessionId, s.binding, s.laneId, 'Private prompt')
      await vi.waitFor(() => expect(s.log).toHaveBeenCalledOnce())
      expect(s.log).toHaveBeenCalledWith('host', 'lane.naming', {
        laneId: s.laneId,
        ms: expect.any(Number),
        outcome:
          failure === 'model'
            ? 'skipped-no-model'
            : failure === 'metadata-failure'
              ? 'set-failed'
              : 'skipped-not-eligible',
      })
      firstPrompt(s.context, s.sessionId, s.binding, s.laneId, 'Second private prompt')
      expect(s.log).toHaveBeenCalledOnce()
      expect(s.nameLane).not.toHaveBeenCalled()
      expect(JSON.stringify(s.log.mock.calls)).not.toContain('Private')
    },
  )
  it('passes title candidates and uses an incarnation/revision guard with an outcome-once callback', async () => {
    const s = await attached()
    const command = s.runtime.command.getMockImplementation()!
    s.runtime.command.mockImplementation(async (...args) =>
      args[1].type === 'get_available_models'
        ? {
            type: 'response',
            command: 'get_available_models',
            success: true,
            data: { models: [laneModel('test', 'small')] },
          }
        : command(...args),
    )
    firstPrompt(s.context, s.sessionId, s.binding, s.laneId, 'Private prompt')
    await vi.waitFor(() => expect(s.nameLane).toHaveBeenCalledOnce())
    const job = s.nameLane.mock.calls[0]![0]
    expect(job.models).toEqual([{ provider: 'test', id: 'small', cost: { input: 1, output: 1 } }])
    expect(job.cwd).toBe(machine.repository)
    expect(job.current()).toBe(true)
    s.binding.renameRevision = 1
    expect(job.current()).toBe(false)
    job.outcome?.('stale')
    job.outcome?.('print-failed')
    expect(s.log).toHaveBeenCalledOnce()
    s.binding.renameRevision = undefined
    expect(job.current()).toBe(true)
    s.context.bindings.set(s.sessionId, { pushes: [], bytes: 0, overflow: false })
    expect(job.current()).toBe(false)
  })
  it('handles unavailable model lists and logging failures without rejecting a prompt', async () => {
    const s = await attached()
    const command = s.runtime.command.getMockImplementation()!
    s.runtime.command.mockImplementation(async (...args) =>
      args[1].type === 'get_available_models'
        ? { type: 'response', command: 'get_available_models', success: false, error: 'private' }
        : command(...args),
    )
    s.log.mockImplementation(() => {
      throw new Error('log failed')
    })
    firstPrompt(s.context, s.sessionId, s.binding, s.laneId, 'Prompt')
    await vi.waitFor(() => expect(s.nameLane).toHaveBeenCalledOnce())
    const job = s.nameLane.mock.calls[0]![0]
    expect(job.models).toEqual([])
    expect(() => {
      job.outcome?.('print-failed')
      job.outcome?.('stale')
    }).not.toThrow()
    expect(s.log).toHaveBeenCalledOnce()
  })
  it.each(['stale', 'late-stale', 'named', 'missing', 'set-failed', 'applied'] as const)(
    'applies generated titles with %s state',
    async (status) => {
      const s = await attached()
      let reads = 0
      const current = () => status !== 'stale' && (status !== 'late-stale' || ++reads === 1)
      if (status === 'named') s.selected.sessionName = 'Native title'
      if (status === 'missing')
        s.runtime.command.mockResolvedValueOnce({
          type: 'response',
          command: 'get_state',
          success: false,
          error: 'no',
        })
      if (status === 'set-failed') {
        const command = s.runtime.command.getMockImplementation()!
        s.runtime.command.mockImplementation(async (...args) =>
          args[1].type === 'set_session_name'
            ? { type: 'response', command: 'set_session_name', success: false, error: 'no' }
            : command(...args),
        )
      }
      const refresh = vi.spyOn(s.binding.attachment!, 'stateChanged')
      expect(
        await applyGeneratedTitle(
          s.context,
          s.sessionId,
          s.binding,
          s.laneId,
          current,
          'Generated',
        ),
      ).toBe(
        status === 'applied'
          ? 'applied'
          : status === 'missing' || status === 'set-failed'
            ? 'set-failed'
            : 'stale',
      )
      expect(store.getLane(s.laneId)?.title).toBe(status === 'applied' ? 'Generated' : null)
      expect(refresh).toHaveBeenCalledTimes(status === 'applied' ? 1 : 0)
    },
  )
  it('records manual names only for existing, nonremoved bound lanes', async () => {
    const s = await attached()
    recordManualName(s.context, s.binding, 'Manual')
    expect(store.getLane(s.laneId)?.title).toBe('Manual')
    store.markRemoved(s.laneId)
    recordManualName(s.context, s.binding, 'Removed')
    expect(store.getLane(s.laneId)?.title).toBe('Manual')
    recordManualName(s.context, { pushes: [], bytes: 0, overflow: false }, 'Unbound')
  })
})
