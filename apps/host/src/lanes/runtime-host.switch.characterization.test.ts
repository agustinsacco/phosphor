import { writeFile } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionPush } from '@phosphor/shared/models'
import type { RpcCommand, RpcSessionState } from '@phosphor/shared/rpc'
import { fakeMachine, type FakeMachine } from '../__fixtures__/machine'
import type { HostRuntime, Delivery } from '../session/runtime'
import { createRuntimeLanes } from './runtime-host'
import { createLiveLanes } from './live'
import { openStore, type HostStore } from './store'

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

it('resumes a first prompt transcript written while set_model waits behind that prompt', async () => {
  const s = setup()
  const original = await s.binding.sessions.start({ repository: machine.repository })
  const lane = s.saved()
  const file = join(machine.dir, 'first-prompt.jsonl')
  let provider = 'old'
  let written = false
  let finishPrompt: () => void = () => {}
  const promptGate = new Promise<void>((resolve) => {
    finishPrompt = resolve
  })
  s.runtime.command.mockImplementation(async (_id, cmd) => {
    if (cmd.type === 'prompt') {
      await promptGate
      await writeFile(file, 'first prompt transcript\n')
      written = true
    }
    if (cmd.type === 'set_model') {
      // The read-only pre-check bypasses the runtime's command gate. The
      // admitted prompt writes its first file before queued set_model runs.
      expect(written).toBe(false)
      finishPrompt()
      await prompt
      provider = cmd.provider
    }
    return {
      type: 'response',
      command: cmd.type,
      success: true,
      data:
        cmd.type === 'get_messages'
          ? { messages: [] }
          : {
              ...state,
              model: laneModel(provider),
              sessionFile: file,
              messageCount: written ? 1 : 0,
            },
    }
  })
  await s.binding.sessions.attach(lane.laneId, original.sessionId)
  const prompt = s.binding.command(original.sessionId, {
    type: 'prompt',
    message: 'first prompt',
  })
  expect(s.runtime.command.mock.calls.some(([, cmd]) => cmd.type === 'prompt')).toBe(true)
  expect(
    await s.binding.command(original.sessionId, {
      type: 'set_model',
      provider: 'new',
      modelId: 'model',
    }),
  ).toMatchObject({ success: true })
  expect(s.runtime.start).toHaveBeenLastCalledWith(
    expect.objectContaining({ repository: machine.repository, sessionPath: file }),
    expect.any(Function),
  )
  expect(await fs.readFile(file, 'utf8')).toBe('first prompt transcript\n')
  expect(store.getLane(lane.laneId)?.sessionFile).toBe(file)
  expect(live.sessionFor(lane.laneId)).not.toBeNull()
})

it('does not resurrect a lane stopped while the post-switch transcript check waits', async () => {
  const s = setup()
  const original = await s.binding.sessions.start({ repository: machine.repository })
  const lane = s.saved()
  const file = join(machine.dir, 'stopped-during-switch.jsonl')
  await writeFile(file, '{}\n')
  let provider = 'old'
  s.runtime.command.mockImplementation(async (_id, cmd) => {
    if (cmd.type === 'set_model') provider = cmd.provider
    return {
      type: 'response',
      command: cmd.type,
      success: true,
      data:
        cmd.type === 'get_messages'
          ? { messages: [] }
          : { ...state, model: laneModel(provider), sessionFile: file, messageCount: 1 },
    }
  })
  await s.binding.sessions.attach(lane.laneId, original.sessionId)
  const real = (await vi.importActual<typeof fs>('node:fs/promises')).lstat
  let checks = 0
  let release: () => void = () => {}
  let paused: () => void = () => {}
  const reached = new Promise<void>((resolve) => {
    paused = resolve
  })
  vi.mocked(fs.lstat).mockImplementation((async (path: Parameters<typeof real>[0]) => {
    // 1: pre-check, 2: post-set_model decision (paused), then Stop's own check.
    if (++checks === 2) {
      paused()
      await new Promise<void>((resolve) => {
        release = resolve
      })
    }
    return real(path)
  }) as typeof fs.lstat)
  try {
    const switching = s.binding.command(original.sessionId, {
      type: 'set_model',
      provider: 'new',
      modelId: 'model',
    })
    await reached
    await s.binding.stopLane(lane.laneId)
    const startsBefore = s.runtime.start.mock.calls.length
    release()
    await expect(switching).rejects.toThrow('Lane unavailable.')
    expect(s.runtime.start.mock.calls.length).toBe(startsBefore)
    expect(s.runtime.stop).toHaveBeenCalledTimes(1)
    expect(live.sessionFor(lane.laneId)).toBeNull()
  } finally {
    vi.mocked(fs.lstat).mockRestore()
  }
})

it('refuses a concurrent prompt while model selection is awaiting pi', async () => {
  const s = setup(),
    session = await s.binding.sessions.start({ repository: machine.repository })
  const lane = s.saved()
  await s.binding.sessions.attach(lane.laneId, session.sessionId)
  let release: () => void = () => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  s.runtime.command.mockImplementation(async (_id, cmd) => {
    await pending
    return { type: 'response', command: cmd.type, success: true, data: state }
  })
  const changing = s.binding.command(session.sessionId, {
    type: 'set_model',
    provider: 'new',
    modelId: 'model',
  })
  const sending = s.binding.command(session.sessionId, {
    type: 'prompt',
    message: 'must wait',
  })
  const promptCalls = s.runtime.command.mock.calls.filter((c) => c[1].type === 'prompt').length
  release()
  const result = await sending
  expect(result).toMatchObject({ success: false, error: 'Wait for the model change to finish.' })
  expect(promptCalls).toBe(0)
  await changing
})

it.each([true, false])(
  'recreates cross-provider selections with persisted=%s',
  async (persisted) => {
    const s = setup()
    const original = await s.binding.sessions.start({ repository: machine.repository })
    const lane = s.saved()
    const file = join(machine.dir, 'transcript')
    if (persisted) await writeFile(file, '{}')
    let provider = 'old'
    s.runtime.command.mockImplementation(async (_id, cmd) => {
      if (cmd.type === 'set_model') provider = cmd.provider
      return {
        type: 'response',
        command: cmd.type,
        success: true,
        data:
          cmd.type === 'get_messages'
            ? { messages: [] }
            : {
                ...state,
                model: laneModel(provider),
                sessionName: 'Original name',
                sessionFile: file,
              },
      }
    })
    await s.binding.sessions.attach(lane.laneId, original.sessionId)
    expect(
      await s.binding.command(original.sessionId, {
        type: 'set_model',
        provider: 'new',
        modelId: 'model',
      }),
    ).toMatchObject({ success: true })
    const request = s.runtime.start.mock.calls.at(-1)?.[0]
    expect(request).toMatchObject({
      repository: machine.repository,
      provider: 'new',
      model: 'model',
    })
    if (persisted) expect(request).toHaveProperty('sessionPath', file)
    else {
      expect(request).not.toHaveProperty('sessionPath')
      expect(s.runtime.command).toHaveBeenCalledWith(expect.any(String), {
        type: 'set_session_name',
        name: 'Original name',
      })
    }
  },
)
it.each(['streaming', 'compacting'] as const)(
  'refuses provider changes while %s',
  async (activity) => {
    const s = setup()
    const session = await s.binding.sessions.start({ repository: machine.repository })
    const lane = s.saved()
    await s.binding.sessions.attach(lane.laneId, session.sessionId)
    s.runtime.command.mockResolvedValue({
      type: 'response',
      command: 'get_state',
      success: true,
      data: {
        ...state,
        model: laneModel('old'),
        isStreaming: activity === 'streaming',
        isCompacting: activity === 'compacting',
      },
    })
    expect(
      await s.binding.command(session.sessionId, {
        type: 'set_model',
        provider: 'new',
        modelId: 'model',
      }),
    ).toMatchObject({
      success: false,
      error: 'Wait for the current turn before changing providers.',
    })
    expect(s.runtime.stop).not.toHaveBeenCalled()
  },
)
it('keeps a confirmed selection successful when persistence and diagnostics throw', async () => {
  const s = setup()
  const session = await s.binding.sessions.start({ repository: machine.repository })
  const lane = s.saved()
  await s.binding.sessions.attach(lane.laneId, session.sessionId)
  s.runtime.command.mockImplementation(async (_id, cmd) => ({
    type: 'response',
    command: cmd.type,
    success: true,
    data: cmd.type === 'get_messages' ? { messages: [] } : { ...state, model: laneModel('same') },
  }))
  vi.spyOn(store, 'updateLane').mockImplementation(() => {
    throw new Error('disk')
  })
  s.log.mockImplementation(() => {
    throw new Error('log')
  })
  expect(
    await s.binding.command(session.sessionId, {
      type: 'set_model',
      provider: 'same',
      modelId: 'model',
    }),
  ).toMatchObject({ success: true })
  expect(s.runtime.stop).not.toHaveBeenCalled()
})
