import { mkdir, symlink, writeFile } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseClientFrame } from '@phosphor/shared/host-protocol'
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

describe('lane lifecycle parity', () => {
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

  it.each(['EIO', 'EACCES', 'symlink', 'directory'] as const)(
    'keeps pi running when its post-switch transcript check encounters %s',
    async (failure) => {
      const s = setup()
      const original = await s.binding.sessions.start({ repository: machine.repository })
      const lane = s.saved()
      const file = join(machine.dir, 'post-switch.jsonl')
      let provider = 'old'
      s.runtime.command.mockImplementation(async (_id, cmd) => {
        if (cmd.type === 'set_model') {
          provider = cmd.provider
          if (failure === 'directory') await mkdir(file)
          else if (failure === 'symlink') {
            const target = join(machine.dir, 'post-switch-target.jsonl')
            await writeFile(target, '{}\n')
            await symlink(target, file)
          } else {
            await writeFile(file, '{}\n')
            vi.mocked(fs.lstat).mockRejectedValueOnce(
              Object.assign(new Error('private path'), { code: failure }),
            )
          }
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
      ).toMatchObject({
        success: false,
        error: 'The lane transcript could not be verified. Check the lane before retrying.',
      })
      expect(
        s.runtime.command.mock.calls.filter(([, cmd]) => cmd.type === 'set_model'),
      ).toHaveLength(1)
      expect(s.runtime.stop).not.toHaveBeenCalled()
      expect(s.runtime.start).toHaveBeenCalledTimes(1)
      expect(live.sessionFor(lane.laneId)).toBe(original.sessionId)
      expect(live.summaryFor(lane.laneId)?.model?.provider).toBe('new')
    },
  )

  it.each([
    { provider: 'p'.repeat(65), modelId: 'model' },
    { provider: 'new', modelId: 'm'.repeat(129) },
  ])(
    'refuses a cross-provider model that cannot pass Host startup limits (%j)',
    async (selection) => {
      const s = setup()
      const original = await s.binding.sessions.start({ repository: machine.repository })
      const lane = s.saved()
      s.runtime.command.mockImplementation(async (_id, cmd) => ({
        type: 'response',
        command: cmd.type,
        success: true,
        data:
          cmd.type === 'get_messages' ? { messages: [] } : { ...state, model: laneModel('old') },
      }))
      await s.binding.sessions.attach(lane.laneId, original.sessionId)
      s.runtime.command.mockClear()
      expect(
        await s.binding.command(original.sessionId, { type: 'set_model', ...selection }),
      ).toMatchObject({
        success: false,
        error: "This model can't be used on a Host lane.",
      })
      expect(s.runtime.command.mock.calls.some(([, cmd]) => cmd.type === 'set_model')).toBe(false)
      expect(s.runtime.stop).not.toHaveBeenCalled()
      expect(s.runtime.start).toHaveBeenCalledTimes(1)
      expect(live.sessionFor(lane.laneId)).toBe(original.sessionId)
      expect(live.summaryFor(lane.laneId)?.model).toMatchObject({ provider: 'old', id: 'model' })
    },
  )

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

  it('records the recreated pi file before a prompt and resumes it after a Host restart', async () => {
    const s = setup()
    const original = await s.binding.sessions.start({ repository: machine.repository })
    const lane = s.saved()
    const oldFile = join(machine.dir, 'old-unwritten.jsonl')
    const newFile = join(machine.dir, 'replacement.jsonl')
    const filesAtAttachment: (string | null | undefined)[] = []
    let provider = 'old'
    s.runtime.command.mockImplementation(async (id, cmd) => {
      if (cmd.type === 'set_model') provider = cmd.provider
      if (cmd.type === 'prompt') await writeFile(newFile, '{}\n')
      if (id !== original.sessionId && cmd.type === 'get_messages')
        filesAtAttachment.push(store.getLane(lane.laneId)?.sessionFile)
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
                sessionFile: id === original.sessionId ? oldFile : newFile,
              },
      }
    })
    await s.binding.sessions.attach(lane.laneId, original.sessionId)
    await s.binding.command(original.sessionId, {
      type: 'set_model',
      provider: 'new',
      modelId: 'model',
    })
    expect(store.getLane(lane.laneId)?.sessionFile).toBe(newFile)
    expect(filesAtAttachment).toEqual([newFile])
    const replacement = live.sessionFor(lane.laneId)
    if (!replacement) throw new Error('missing replacement')
    await s.binding.command(replacement, { type: 'prompt', message: 'first prompt' })
    // Shutdown does not perform stopLane's get_state learning. Reopen the store
    // and compose a fresh binding just as a subsequent Host process does.
    await s.binding.sessions.stop(replacement)
    live.close()
    store.close()
    store = await openStore(join(machine.dir, 'state'), process.getuid?.())
    live = createLiveLanes({
      epoch: '0123456789abcdef',
      store,
      runtime: s.runtime,
      now: Date.now,
      log: vi.fn(),
    })
    const restarted = createRuntimeLanes({ runtime: s.runtime, store, live, log: vi.fn() })
    const recorded = store.getLane(lane.laneId)
    if (!recorded) throw new Error('missing stored lane')
    await restarted.resumeLane(recorded)
    expect(s.runtime.start).toHaveBeenLastCalledWith(
      { repository: machine.repository, sessionPath: newFile },
      expect.any(Function),
    )
    expect(filesAtAttachment).toEqual([newFile, newFile])
  })

  it.each(['EIO', 'EACCES', 'symlink', 'directory'] as const)(
    'refuses an unverifiable %s transcript without changing or restarting pi',
    async (failure) => {
      const s = setup()
      const original = await s.binding.sessions.start({ repository: machine.repository })
      const lane = s.saved()
      const file = join(machine.dir, 'session.jsonl')
      if (failure === 'directory') await mkdir(file)
      else if (failure === 'symlink') {
        const target = join(machine.dir, 'target.jsonl')
        await writeFile(target, '{}\n')
        await symlink(target, file)
      } else await writeFile(file, '{}\n')
      s.runtime.command.mockImplementation(async (_id, cmd) => ({
        type: 'response',
        command: cmd.type,
        success: true,
        data:
          cmd.type === 'get_messages'
            ? { messages: [] }
            : {
                ...state,
                model: laneModel('old'),
                sessionFile: file,
              },
      }))
      await s.binding.sessions.attach(lane.laneId, original.sessionId)
      s.runtime.command.mockClear()
      if (failure === 'EIO' || failure === 'EACCES')
        vi.spyOn(fs, 'lstat').mockRejectedValueOnce(
          Object.assign(new Error('private path'), { code: failure }),
        )
      expect(
        await s.binding.command(original.sessionId, {
          type: 'set_model',
          provider: 'new',
          modelId: 'model',
        }),
      ).toMatchObject({
        success: false,
        error: 'The lane transcript could not be verified. Model was not changed.',
      })
      expect(s.runtime.command.mock.calls.some(([, cmd]) => cmd.type === 'set_model')).toBe(false)
      expect(s.runtime.stop).not.toHaveBeenCalled()
      expect(s.runtime.start).toHaveBeenCalledTimes(1)
      expect(live.sessionFor(lane.laneId)).toBe(original.sessionId)
      expect(live.summaryFor(lane.laneId)?.model?.provider).toBe('old')
    },
  )

  it.each([129, 200])(
    'confirms a %i-character model id even when the store cannot persist it',
    async (length) => {
      const s = setup()
      const original = await s.binding.sessions.start({ repository: machine.repository })
      const lane = s.saved()
      store.updateLane(lane.laneId, { provider: 'old', model: 'previous' })
      let id = 'previous'
      s.runtime.command.mockImplementation(async (_id, cmd) => {
        if (cmd.type === 'set_model') id = cmd.modelId
        return {
          type: 'response',
          command: cmd.type,
          success: true,
          data:
            cmd.type === 'get_messages'
              ? { messages: [] }
              : {
                  ...state,
                  model: laneModel('old', id),
                },
        }
      })
      await s.binding.sessions.attach(lane.laneId, original.sessionId)
      const selected = 'm'.repeat(length)
      const op = { type: 'set_model', provider: 'old', modelId: selected } as const
      expect(
        parseClientFrame(
          JSON.stringify({
            type: 'command',
            requestId: randomUUID(),
            laneId: lane.laneId,
            fence: 1,
            op,
          }),
        ).ok,
      ).toBe(true)
      expect(await s.binding.command(original.sessionId, op)).toMatchObject({ success: true })
      expect(live.summaryFor(lane.laneId)?.model).toMatchObject({ provider: 'old', id: selected })
      expect(store.getLane(lane.laneId)?.model).toEqual({ provider: 'old', id: 'previous' })
      expect(s.log).toHaveBeenCalledExactlyOnceWith('host', 'lane.model_persistence_failed')
      expect(s.runtime.stop).not.toHaveBeenCalled()
      live.detach(lane.laneId)
      expect(live.summaryFor(lane.laneId)?.model?.id).toBe('previous')
    },
  )

  it('refuses a 201-character model id at protocol admission', () => {
    expect(
      parseClientFrame(
        JSON.stringify({
          type: 'command',
          requestId: randomUUID(),
          laneId: randomUUID(),
          fence: 1,
          op: { type: 'set_model', provider: 'old', modelId: 'm'.repeat(201) },
        }),
      ).ok,
    ).toBe(false)
  })

  it.each([
    { cross: true, persisted: true },
    { cross: true, persisted: false },
    { cross: false, persisted: true },
    { cross: false, persisted: false },
  ])(
    'rebinds model switches without resuming an unwritten file (%j)',
    async ({ cross, persisted }) => {
      const s = setup()
      const session = await s.binding.sessions.start({ repository: machine.repository })
      const lane = s.saved()
      await s.binding.sessions.attach(lane.laneId, session.sessionId)
      let provider = 'old'
      const file = join(machine.dir, 'session.jsonl')
      if (persisted) await writeFile(file, '{}\n')
      store.updateLane(lane.laneId, { title: '-example' })
      const model = () => ({
        provider,
        id: 'model',
        name: 'Model',
        api: 'test',
        reasoning: false,
        input: ['text'],
        contextWindow: 200000,
        maxTokens: 4096,
        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      })
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
                  sessionName: '-example',
                  model: model(),
                  sessionFile: file,
                  messageCount: 1,
                },
        }
      })
      await s.binding.command(session.sessionId, {
        type: 'set_model',
        provider: cross ? 'new' : 'old',
        modelId: 'model',
      })
      expect(s.runtime.stop).toHaveBeenCalledTimes(cross ? 1 : 0)
      if (cross)
        expect(s.runtime.start).toHaveBeenLastCalledWith(
          expect.objectContaining({
            repository: machine.repository,
            ...(persisted ? { sessionPath: file } : {}),
            provider: 'new',
            model: 'model',
          }),
          expect.any(Function),
        )
      if (cross) {
        expect(s.runtime.start.mock.calls.at(-1)?.[0]).not.toHaveProperty('name')
        if (!persisted) {
          expect(s.runtime.start.mock.calls.at(-1)?.[0]).not.toHaveProperty('sessionPath')
          expect(s.runtime.command).toHaveBeenCalledWith(expect.any(String), {
            type: 'set_session_name',
            name: '-example',
          })
        }
      }
      expect(live.sessionFor(lane.laneId)).not.toBeNull()
      expect(live.summaryFor(lane.laneId)).toMatchObject({
        title: '-example',
        model: { provider: cross ? 'new' : 'old', id: 'model' },
      })
      expect(store.getLane(lane.laneId)?.model).toEqual({
        provider: cross ? 'new' : 'old',
        id: 'model',
      })
      s.push({ kind: 'exit', code: 1, signal: null, expected: false })
      expect(live.summaryFor(lane.laneId)?.model?.provider).toBe(cross ? 'new' : 'old')
      live.detach(lane.laneId)
      expect(live.summaryFor(lane.laneId)?.model?.provider).toBe(cross ? 'new' : 'old')
    },
  )
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
