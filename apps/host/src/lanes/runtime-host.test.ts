import { mkdir, symlink, writeFile } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { renameSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  parseClientFrame,
  parseHostFrame,
  type HostFrame,
  type Receipt,
} from '@phosphor/shared/host-protocol'
import { createLoopbackPair } from '@phosphor/shared/host-protocol-testing'
import type { SessionPush } from '@phosphor/shared/models'
import type { RpcCommand, RpcSessionState } from '@phosphor/shared/rpc'
import { fakeMachine, EXTENSIONS_ROOT, type FakeMachine } from '../__fixtures__/machine'
import { createHostRuntime, type HostRuntime, type Delivery } from '../session/runtime'
import { buildPiEnvironment } from '../machine/environment'
import { createHostLog } from '../machine/log'
import { isGone } from '../session/lifecycle'
import { createLaneCommands } from './commands'
import { createLaneCalls } from './calls'
import { createRuntimeLanes } from './runtime-host'
import { createLiveLanes } from './live'
import { openStore, type HostStore } from './store'
import { createUnattachedSnapshots } from './transcript'
import { createSubscriptions } from './subscriptions'

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
let real: HostRuntime | undefined
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
  const drained = real?.drain('test finished')
  void real?.drain('test forced')
  await drained
  real = undefined
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
      await job.apply('Generated title')
      expect(
        s.runtime.command.mock.calls.filter((c) => c[1].type === 'set_session_name'),
      ).toHaveLength(change === 'none' ? 1 : 0)
      if (change === 'none') expect(store.getLane(lane.laneId)?.title).toBe('Generated title')
      if (change === 'rename') expect(store.getLane(lane.laneId)?.title).toBe('Manual')
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

  it('buffers startup UI, excludes stderr, refreshes successful state mutations and retains unexpected exits', async () => {
    const status: SessionPush = {
      kind: 'extension-ui',
      request: {
        type: 'extension_ui_request',
        id: 'status',
        method: 'setStatus',
        statusKey: 'test',
        statusText: 'early',
      },
    }
    const s = setup([
      ...Array.from({ length: 257 }, (): SessionPush => ({
        kind: 'stderr',
        text: 'stderr-secret-sentinel',
      })),
      status,
    ])
    const session = await s.binding.sessions.start({ repository: machine.repository })
    const lane = s.saved()
    await s.binding.sessions.attach(lane.laneId, session.sessionId)
    const snapshot = live.streams.snapshot(lane.laneId)
    expect(JSON.stringify(snapshot)).toContain('early')
    expect(JSON.stringify(snapshot)).not.toContain('stderr-secret-sentinel')
    for (const command of [
      { type: 'set_model', provider: 'fake', modelId: 'other' },
      { type: 'set_thinking_level', level: 'high' },
      { type: 'set_session_name', name: 'new' },
    ] satisfies RpcCommand[]) {
      const refresh = s.runtime.command.mock.calls.filter((c) => c[1].type === 'get_state').length
      await s.binding.command(session.sessionId, command)
      await Promise.resolve()
      expect(s.runtime.command.mock.calls.filter((c) => c[1].type === 'get_state').length).toBe(
        refresh + (command.type === 'set_model' ? 3 : 1),
      )
    }
    s.runtime.command.mockClear()
    await s.binding.command(session.sessionId, { type: 'get_state' })
    expect(s.runtime.command).toHaveBeenCalledTimes(1)
    s.push({ kind: 'exit', code: 3, signal: null, expected: false })
    expect(live.sessionFor(lane.laneId)).toBeNull()
    expect(live.summaryFor(lane.laneId)?.activity).toBe('failed')
    expect(live.streams.snapshot(lane.laneId)).not.toBeNull()
  })
  it.each([256, 257, 'bytes-limit', 'bytes-over'] as const)(
    'bounds startup count/bytes at %s and logs only lane identity on overflow',
    async (size) => {
      const push: SessionPush = {
        kind: 'extension-ui',
        request: {
          type: 'extension_ui_request',
          id: 'status',
          method: 'setStatus',
          statusKey: 'test',
          statusText: 'early',
        },
      }
      if (typeof size === 'string' && push.request.method === 'setStatus') {
        const overhead = Buffer.byteLength(JSON.stringify(push)) - 5
        push.request.statusText = 'x'.repeat(
          1024 * 1024 - overhead + (size === 'bytes-over' ? 1 : 0),
        )
      }
      const s = setup(typeof size === 'string' ? [push] : Array.from({ length: size }, () => push))
      const session = await s.binding.sessions.start({ repository: machine.repository })
      const lane = s.saved()
      await s.binding.sessions.attach(lane.laneId, session.sessionId)
      if (size === 256 || size === 'bytes-limit') {
        expect(s.log).not.toHaveBeenCalled()
        if (size === 256)
          expect(JSON.stringify(live.streams.snapshot(lane.laneId))).toContain('early')
      } else {
        expect(s.log).toHaveBeenCalledExactlyOnceWith('host', 'lane.startup_overflow', {
          laneId: lane.laneId,
        })
        expect(JSON.stringify(live.streams.snapshot(lane.laneId))).not.toContain('early')
      }
    },
  )
  it('stops failed starts, discards their buffer and refuses a resume without a recorded file', async () => {
    const s = setup()
    s.runtime.command.mockResolvedValue({
      type: 'response',
      command: 'get_state',
      success: false,
      error: 'private',
    })
    await expect(s.binding.sessions.start({ repository: machine.repository })).rejects.toThrow(
      'could not start',
    )
    expect(s.runtime.stop).toHaveBeenCalledTimes(1)
    const stopped = s.runtime.stop.mock.calls[0]?.[0]
    if (!stopped) throw new Error('missing stopped session')
    await expect(s.binding.sessions.attach(s.saved().laneId, stopped)).rejects.toThrow(
      'unknown lane start',
    )
    await expect(s.binding.resumeLane(s.saved())).rejects.toThrow('could not start')
    expect(s.runtime.start).toHaveBeenCalledTimes(1)
  })
  it('does not refresh a failed mutation and stop receives the runtime id and detaches', async () => {
    const s = setup()
    const session = await s.binding.sessions.start({ repository: machine.repository })
    const lane = s.saved()
    await s.binding.sessions.attach(lane.laneId, session.sessionId)
    s.runtime.command.mockClear().mockResolvedValue({
      type: 'response',
      command: 'set_model',
      success: false,
      error: 'private',
    })
    await s.binding.command(session.sessionId, {
      type: 'set_model',
      provider: 'fake',
      modelId: 'other',
    })
    expect(s.runtime.command).toHaveBeenCalledTimes(2)
    s.runtime.command.mockResolvedValue({
      type: 'response',
      command: 'get_state',
      success: true,
      data: state,
    })
    await s.binding.deleteStop(lane.laneId)
    expect(s.runtime.stop).toHaveBeenCalledWith(session.sessionId)
    expect(live.sessionFor(lane.laneId)).toBeNull()
  })
  it('creates, streams, stops, reads, resumes and drains a real fake-pi process', async () => {
    const env = buildPiEnvironment({
      hostEnv: machine.hostEnv,
      nodePath: process.execPath,
      platform: process.platform,
    }).env
    const log = createHostLog(join(machine.dir, 'logs'), [])
    real = createHostRuntime(
      {
        pi: { binaryPath: process.execPath, prefixArgs: [machine.cli] },
        env,
        roots: [machine.repository],
        resourceRoot: EXTENSIONS_ROOT,
        contextBudget: '',
        log,
      },
      { dialogs: 'forward' },
    )
    real.life.to('validating')
    real.life.to('ready')
    let reader: ReturnType<typeof createUnattachedSnapshots> = () => null
    live = createLiveLanes({
      epoch: '0123456789abcdef',
      store,
      runtime: real,
      now: Date.now,
      log: vi.fn(),
      unattached: (id) => reader(id),
    })
    reader = createUnattachedSnapshots({
      store,
      summary: live.summaryFor,
      cursor: live.streams.cursor,
      sessionsRoot: join(machine.agentDir, 'sessions'),
      log: vi.fn(),
    })
    const binding = createRuntimeLanes({ runtime: real, store, live, log: log.write })
    const receipts: Receipt[] = []
    const commands = createLaneCommands({
      store,
      ...binding,
      runtime: binding,
      sessionFor: live.sessionFor,
      openDialogs: live.openDialogs,
      summaryFor: live.summaryFor,
      publish: live.publish,
      deliver: (_id, receipt) => receipts.push(receipt),
      now: Date.now,
      log: log.write,
    })
    const client = { id: randomUUID(), label: 'Client', caps: ['sessions.control'] as const }
    await commands.submit(client, {
      type: 'command',
      requestId: randomUUID(),
      op: { type: 'lane.create', repositoryId, worktree: null },
    })
    const receipt = receipts.at(-1)
    if (receipt?.status !== 'done' || !receipt.laneId) throw new Error('missing created lane')
    const laneId = receipt.laneId
    const pair = createLoopbackPair()
    const frames: HostFrame[] = []
    pair.client.onMessage((text) => {
      const frame = parseHostFrame(text)
      if (!frame.ok) throw new Error('invalid frame')
      frames.push(frame.value)
    })
    const subscriptions = createSubscriptions(pair.server, live.streams, live.lanesTopic)
    subscriptions.handle({ type: 'subscribe', id: 'watch', topic: 'lane', laneId })
    await commands.submit(client, {
      type: 'command',
      requestId: randomUUID(),
      laneId,
      fence: 1,
      op: { type: 'prompt', message: 'hello' },
    })
    for (
      let i = 0;
      i < 300 &&
      !frames.some(
        (f) =>
          f.type === 'event' &&
          f.event.kind === 'pi' &&
          f.event.push.kind === 'event' &&
          f.event.push.event.type === 'agent_end',
      );
      i++
    )
      await sleep(10)
    expect(
      frames.some(
        (f) =>
          f.type === 'event' &&
          f.event.kind === 'pi' &&
          f.event.push.kind === 'event' &&
          f.event.push.event.type === 'agent_end',
      ),
    ).toBe(true)
    const pids = real.list().map((s) => s.pid)
    await commands.submit(client, {
      type: 'command',
      requestId: randomUUID(),
      laneId,
      fence: 1,
      op: { type: 'lane.stop' },
    })
    const calls = createLaneCalls({
      store,
      live,
      runtime: real,
      unattached: reader,
      now: Date.now,
      log: log.write,
    })
    expect(await calls.call('lane.messages', { laneId })).toMatchObject({
      ok: true,
      data: { messages: [{ role: 'user' }, { role: 'assistant' }] },
    })
    const recorded = store.getLane(laneId)?.sessionFile
    if (!recorded) throw new Error('missing recorded file')
    renameSync(recorded, `${recorded}.saved`)
    await commands.submit(client, {
      type: 'command',
      requestId: randomUUID(),
      laneId,
      fence: 1,
      op: { type: 'lane.resume' },
    })
    expect(receipts.at(-1)).toMatchObject({
      status: 'failed',
      error: { code: 'internal', message: 'the lane could not start' },
    })
    expect(real.list()).toEqual([])
    renameSync(`${recorded}.saved`, recorded)
    await commands.submit(client, {
      type: 'command',
      requestId: randomUUID(),
      laneId,
      fence: 1,
      op: { type: 'lane.resume' },
    })
    expect(receipts.at(-1)).toMatchObject({ status: 'done', fence: 1 })
    expect(await calls.call('lane.messages', { laneId })).toMatchObject({
      ok: true,
      data: { messages: [{ role: 'user' }, { role: 'assistant' }] },
    })
    pids.push(...real.list().map((s) => s.pid))
    const endedBefore = frames.filter(
      (f) =>
        f.type === 'event' &&
        f.event.kind === 'pi' &&
        f.event.push.kind === 'event' &&
        f.event.push.event.type === 'agent_end',
    ).length
    const sessionId = live.sessionFor(laneId)
    if (!sessionId) throw new Error('missing resumed session')
    await binding.command(sessionId, { type: 'prompt', message: 'stream' })
    for (let i = 0; i < 300 && live.summaryFor(laneId)?.activity !== 'working'; i++) await sleep(10)
    expect(live.summaryFor(laneId)?.activity).toBe('working')
    await binding.stopLane(laneId)
    await Promise.resolve()
    expect(
      frames.filter(
        (f) =>
          f.type === 'event' &&
          f.event.kind === 'pi' &&
          f.event.push.kind === 'event' &&
          f.event.push.event.type === 'agent_end',
      ),
    ).toHaveLength(endedBefore + 1)
    expect(await calls.call('lane.messages', { laneId })).toMatchObject({
      ok: true,
      data: {
        messages: [
          { role: 'user' },
          { role: 'assistant' },
          { role: 'user' },
          { role: 'assistant' },
        ],
      },
    })
    const lane = store.getLane(laneId)
    if (!lane) throw new Error('missing lane')
    await binding.resumeLane(lane)
    pids.push(...real.list().map((s) => s.pid))
    expect((await real.drain('integration finished')).state).toBe('stopped')
    await commands.close()
    subscriptions.close()
    pair.client.close(1000, 'test finished')
    expect(real.list()).toEqual([])
    for (const pid of pids) if (pid !== undefined) expect(isGone(pid)).toBe(true)
  })
})

it('attachment waits for the first full refresh', async () => {
  const s = setup()
  const session = await s.binding.sessions.start({ repository: machine.repository })
  const lane = s.saved()
  let release: (() => void) | undefined
  const messages = new Promise<void>((resolve) => {
    release = resolve
  })
  const command = s.runtime.command.getMockImplementation()
  if (!command) throw new Error('missing command')
  s.runtime.command.mockImplementation(async (...args) => {
    if (args[1].type === 'get_messages') await messages
    return command(...args)
  })
  let attached = false
  const attachment = s.binding.sessions.attach(lane.laneId, session.sessionId).then(() => {
    attached = true
  })
  for (let i = 0; i < 8; i++) await Promise.resolve()
  expect(attached).toBe(false)
  release?.()
  await attachment
  expect(attached).toBe(true)
})

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

  it('refuses Stop before the first prompt, then records pi file identity for resume', async () => {
    const s = setup()
    const session = await s.binding.sessions.start({ repository: machine.repository })
    const lane = s.saved()
    await s.binding.sessions.attach(lane.laneId, session.sessionId)
    await expect(s.binding.stopLane(lane.laneId)).rejects.toThrow('Send a first message')
    expect(s.runtime.stop).not.toHaveBeenCalled()
    const file = join(machine.dir, 'session.jsonl')
    s.runtime.command.mockImplementation(async (_id, cmd) => ({
      type: 'response',
      command: cmd.type,
      success: true,
      data: { ...state, sessionFile: file, messageCount: 1 },
    }))
    // pi reports the path before it writes the file: still nothing to resume.
    await expect(s.binding.stopLane(lane.laneId)).rejects.toThrow('Send a first message')
    expect(s.runtime.stop).not.toHaveBeenCalled()
    await writeFile(file, '{}\n')
    await s.binding.stopLane(lane.laneId)
    expect(store.getLane(lane.laneId)?.sessionFile).toBe(file)
    const saved = store.getLane(lane.laneId)
    if (!saved) throw new Error('fixture')
    await s.binding.resumeLane(saved)
    expect(s.runtime.start).toHaveBeenLastCalledWith(
      { repository: machine.repository, sessionPath: file },
      expect.any(Function),
    )
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

it('does not delete a lane when pi cannot verify its transcript identity', async () => {
  const s = setup(),
    session = await s.binding.sessions.start({ repository: machine.repository })
  const lane = s.saved()
  await s.binding.sessions.attach(lane.laneId, session.sessionId)
  s.runtime.command.mockResolvedValue({
    type: 'response',
    command: 'get_state',
    success: false,
    error: 'unavailable',
  })
  await expect(s.binding.deleteStop(lane.laneId)).rejects.toThrow('identity could not be verified')
  expect(s.runtime.stop).not.toHaveBeenCalled()
})

it('does not stop a deleting lane after authority expires while reading pi state', async () => {
  const s = setup(),
    session = await s.binding.sessions.start({ repository: machine.repository })
  const lane = s.saved()
  await s.binding.sessions.attach(lane.laneId, session.sessionId)
  await expect(s.binding.deleteStop(lane.laneId, () => false)).rejects.toThrow('control changed')
  expect(s.runtime.stop).not.toHaveBeenCalled()
})
