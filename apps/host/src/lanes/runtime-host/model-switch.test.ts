import { writeFile } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionPush } from '@phosphor/shared/models'
import type { RpcCommand, RpcSessionState } from '@phosphor/shared/rpc'
import { fakeMachine, type FakeMachine } from '../../__fixtures__/machine'
import type { HostRuntime, Delivery } from '../../session/runtime'
import type { RuntimeLaneState, RuntimeLaneOptions } from './state'
import { start, attach } from './lifecycle'
import {
  guardModelChange,
  verifySelectedModel,
  replaceProviderProcess,
  restoreUnsavedName,
  finishModelSelection,
} from './model-switch'
import { createLiveLanes } from '../live'
import { openStore, type HostStore } from '../store'

vi.mock('node:fs/promises', { spy: true })

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
  const s = setup()
  const session = await start(s.context, {})
  const lane = s.saved()
  await attach(s.context, lane.laneId, session.sessionId)
  const binding = s.context.bindings.get(session.sessionId)
  if (!binding) throw new Error('missing binding')
  const selected = { ...state, model: laneModel('new') }
  s.runtime.command.mockImplementation(async (_id, cmd) => ({
    type: 'response',
    command: cmd.type,
    success: true,
    data: selected,
  }))
  return { ...s, sessionId: session.sessionId, laneId: lane.laneId, binding, selected }
}
describe('model switch helpers', () => {
  it.each(['streaming', 'compacting', 'provider-length', 'model-length', 'stat'] as const)(
    'rejects the %s precheck without asking pi to switch',
    async (failure) => {
      const s = await attached()
      s.selected.isStreaming = failure === 'streaming'
      s.selected.isCompacting = failure === 'compacting'
      if (failure === 'stat') {
        s.selected.sessionFile = '/private/transcript'
        vi.mocked(fs.lstat).mockRejectedValueOnce(
          Object.assign(new Error('private'), { code: 'EIO' }),
        )
      }
      const result = await guardModelChange(s.context, s.sessionId, s.binding, {
        type: 'set_model',
        provider: failure === 'provider-length' ? 'x'.repeat(65) : 'other',
        modelId: failure === 'model-length' ? 'x'.repeat(129) : 'model',
      })
      expect(result.refusal).toMatchObject({ success: false, command: 'set_model' })
      expect(s.runtime.stop).not.toHaveBeenCalled()
    },
  )
  it('permits an unattached selection and a same-provider model without a transcript check', async () => {
    const s = await attached()
    expect(
      (
        await guardModelChange(s.context, s.sessionId, undefined, {
          type: 'set_model',
          provider: 'new',
          modelId: 'model',
        })
      ).beforeModel,
    ).toBeNull()
    const stat = vi.mocked(fs.lstat)
    stat.mockClear()
    expect(
      (
        await guardModelChange(s.context, s.sessionId, s.binding, {
          type: 'set_model',
          provider: 'new',
          modelId: 'model',
        })
      ).refusal,
    ).toBeUndefined()
    expect(stat).not.toHaveBeenCalled()
  })
  it.each(['state', 'removed', 'missing', 'binding', 'attachment'] as const)(
    'rejects an unavailable %s before replacement',
    async (failure) => {
      const s = await attached()
      if (failure === 'state')
        s.runtime.command.mockResolvedValue({
          type: 'response',
          command: 'get_state',
          success: true,
          data: state,
        })
      if (failure === 'removed') store.markRemoved(s.laneId)
      if (failure === 'missing') vi.spyOn(store, 'getLane').mockReturnValue(null)
      if (failure === 'binding')
        s.context.bindings.set(s.sessionId, { pushes: [], bytes: 0, overflow: false })
      if (failure === 'attachment') live.detach(s.laneId)
      await expect(
        verifySelectedModel(s.context, s.sessionId, s.binding, s.laneId),
      ).rejects.toThrow(
        failure === 'state' ? 'Model change could not be verified.' : 'Lane unavailable.',
      )
      expect(s.runtime.stop).not.toHaveBeenCalled()
    },
  )
  it('refreshes but does not restart when the selected transcript is unreadable', async () => {
    const s = await attached()
    const refresh = vi.spyOn(s.binding.attachment!, 'stateChanged')
    s.selected.sessionFile = '/private/transcript'
    vi.mocked(fs.lstat).mockRejectedValueOnce(
      Object.assign(new Error('private'), { code: 'EACCES' }),
    )
    expect(await replaceProviderProcess(s.context, s.sessionId, s.binding, s.laneId)).toMatchObject(
      {
        success: false,
        error: 'The lane transcript could not be verified. Check the lane before retrying.',
      },
    )
    expect(refresh).toHaveBeenCalledOnce()
    expect(s.runtime.stop).not.toHaveBeenCalled()
  })
  it.each(['removed', 'binding', 'attachment'] as const)(
    'rechecks %s after transcript stat before restarting',
    async (change) => {
      const s = await attached()
      const file = join(machine.dir, 'saved')
      await writeFile(file, '{}')
      s.selected.sessionFile = file
      const real = (await vi.importActual<typeof fs>('node:fs/promises')).lstat
      vi.mocked(fs.lstat).mockImplementationOnce((async (path: Parameters<typeof real>[0]) => {
        if (change === 'removed') store.markRemoved(s.laneId)
        if (change === 'binding') s.context.bindings.delete(s.sessionId)
        if (change === 'attachment') live.detach(s.laneId)
        return real(path)
      }) as typeof fs.lstat)
      await expect(
        replaceProviderProcess(s.context, s.sessionId, s.binding, s.laneId),
      ).rejects.toThrow('Lane unavailable.')
      expect(s.runtime.stop).not.toHaveBeenCalled()
      expect(s.runtime.start).toHaveBeenCalledTimes(1)
    },
  )
  it.each(['start', 'restore', 'attach'] as const)(
    'cleans up a replacement %s failure',
    async (failure) => {
      const s = await attached()
      s.selected.sessionName = 'Unsaved name'
      if (failure === 'start') s.runtime.start.mockRejectedValueOnce(new Error('start failed'))
      if (failure === 'restore') {
        const command = s.runtime.command.getMockImplementation()!
        s.runtime.command.mockImplementation(async (...args) =>
          args[1].type === 'set_session_name'
            ? { type: 'response', command: 'set_session_name', success: false, error: 'denied' }
            : command(...args),
        )
      }
      if (failure === 'attach')
        vi.spyOn(live, 'attach').mockImplementationOnce(() => {
          throw new Error('attach failed')
        })
      await expect(
        replaceProviderProcess(s.context, s.sessionId, s.binding, s.laneId),
      ).rejects.toThrow(
        failure === 'restore' ? 'Lane name could not be restored.' : `${failure} failed`,
      )
      expect(s.runtime.stop).toHaveBeenCalledTimes(failure === 'start' ? 1 : 2)
      expect(s.context.bindings.size).toBe(0)
    },
  )
  it('restores only a nonempty unsaved name and refreshes confirmed selections', async () => {
    const s = await attached()
    s.runtime.command.mockClear()
    await restoreUnsavedName(s.context, s.sessionId, 'Saved', true)
    await restoreUnsavedName(s.context, s.sessionId, undefined, false)
    expect(s.runtime.command).not.toHaveBeenCalled()
    await restoreUnsavedName(s.context, s.sessionId, 'Unsaved', false)
    expect(s.runtime.command).toHaveBeenCalledExactlyOnceWith(s.sessionId, {
      type: 'set_session_name',
      name: 'Unsaved',
    })
    const refresh = vi.spyOn(s.binding.attachment!, 'stateChanged')
    await finishModelSelection(s.context, s.sessionId, s.binding)
    expect(store.getLane(s.laneId)?.model).toEqual({ provider: 'new', id: 'model' })
    expect(refresh).toHaveBeenCalledOnce()
  })
})

it('keeps the final identity check, model persistence and stop in one synchronous segment', async () => {
  const s = await attached()
  const order: string[] = []
  const getLane = store.getLane.bind(store)
  let reads = 0
  vi.spyOn(store, 'getLane').mockImplementation((id) => {
    const lane = getLane(id)
    if (++reads === 2) {
      order.push('identity-check')
      queueMicrotask(() => order.push('yield'))
    }
    return lane
  })
  const updateLane = store.updateLane.bind(store)
  vi.spyOn(store, 'updateLane').mockImplementation((...args) => {
    order.push('persist')
    return updateLane(...args)
  })
  s.runtime.stop.mockImplementation(async () => {
    order.push('stop')
  })
  await replaceProviderProcess(s.context, s.sessionId, s.binding, s.laneId)
  expect(order.slice(0, 3)).toEqual(['identity-check', 'persist', 'stop'])
})
