import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Receipt } from '@phosphor/shared/host-protocol'
import type { SessionPush } from '@phosphor/shared/models'
import type { RpcCommand, RpcSessionState } from '@phosphor/shared/rpc'
import { fakeMachine, type FakeMachine } from '../__fixtures__/machine'
import type { HostRuntime, Delivery } from '../session/runtime'
import { createLaneCommands } from './commands'
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
// Runtime binding guards: startup buffering, attachment readiness, stop/resume and delete authority.
describe('runtime lane binding', () => {
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
    await expect(
      s.binding.sessions.start({ repository: machine.repository }),
    ).rejects.toMatchObject({ message: 'the lane could not start', code: 'pi-state-failed' })
    expect(s.runtime.stop).toHaveBeenCalledTimes(1)
    const stopped = s.runtime.stop.mock.calls[0]?.[0]
    if (!stopped) throw new Error('missing stopped session')
    await expect(s.binding.sessions.attach(s.saved().laneId, stopped)).rejects.toThrow(
      'unknown lane start',
    )
    await expect(s.binding.resumeLane(s.saved())).rejects.toThrow('could not start')
    expect(s.runtime.start).toHaveBeenCalledTimes(1)
  })
  // A state pi answered but the Host could not read (thinking level max, before the
  // Host knew it) logged only "failed internal", with nothing pointing at the cause.
  it('codes a start whose pi state the Host cannot read, for the Host log', async () => {
    const s = setup()
    s.runtime.command.mockResolvedValue({
      type: 'response',
      command: 'get_state',
      success: true,
      // A level newer than this Host knows; the protocol types cannot express it.
      data: { thinkingLevel: 'extreme' } as never,
    })
    await expect(
      s.binding.sessions.start({ repository: machine.repository }),
    ).rejects.toMatchObject({ message: 'the lane could not start', code: 'pi-state-unreadable' })
  })
  it('refuses to resume a lane whose folder was removed, naming why, without starting pi', async () => {
    const s = setup()
    const lane = { ...s.saved(), cwd: `${machine.repository}/.phosphor/worktrees/gone` }
    await expect(
      s.binding.resumeLane({ ...lane, sessionFile: `${machine.repository}/x.jsonl` }),
    ).rejects.toMatchObject({ code: 'lane-folder-missing' })
    expect(s.runtime.start).not.toHaveBeenCalled()
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

describe('lane lifecycle parity', () => {
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

function commitBase() {
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'base',
    ],
    { cwd: machine.repository },
  )
}
function laneCommands(s: ReturnType<typeof setup>, receipts: Receipt[]) {
  return createLaneCommands({
    store,
    ...s.binding,
    runtime: s.binding,
    sessionFor: live.sessionFor,
    openDialogs: live.openDialogs,
    summaryFor: live.summaryFor,
    publish: live.publish,
    deliver: (_id, receipt) => receipts.push(receipt),
    now: Date.now,
    log: s.log,
  })
}
const creator = { id: randomUUID(), label: 'Client', caps: ['sessions.control' as const] }
const createFrame = (fields: { worktree?: { branch: string; fresh?: true }; prompt?: string }) => ({
  type: 'command' as const,
  requestId: randomUUID(),
  op: { type: 'lane.create' as const, repositoryId, worktree: null, ...fields },
})

it('fresh branch conflicts produce a fixed rejection once every free name is taken', async () => {
  commitBase()
  for (const name of ['occupied', 'occupied-2', 'occupied-3', 'occupied-4', 'occupied-5'])
    execFileSync('git', ['branch', name], { cwd: machine.repository })
  const s = setup()
  const receipts: Receipt[] = []
  const commands = laneCommands(s, receipts)
  await commands.submit(creator, createFrame({ worktree: { branch: 'occupied', fresh: true } }))
  expect(receipts.at(-1)).toMatchObject({ status: 'rejected', code: 'branch-exists' })
  expect(s.runtime.start).not.toHaveBeenCalled()
  expect(store.listLanes()).toHaveLength(0)
  expect(s.log).toHaveBeenCalledWith(
    'host',
    'lane.command',
    expect.objectContaining({ code: 'branch-exists' }),
  )
  expect(JSON.stringify(s.log.mock.calls)).not.toContain('occupied')
  await commands.close()
})

it('creates a fresh branch under the first free suffixed name and stores that name', async () => {
  commitBase()
  execFileSync('git', ['branch', 'taken'], { cwd: machine.repository })
  const s = setup()
  const receipts: Receipt[] = []
  const commands = laneCommands(s, receipts)
  await commands.submit(creator, createFrame({ worktree: { branch: 'taken', fresh: true } }))
  const done = receipts.at(-1)
  if (done?.status !== 'done' || !done.laneId) throw new Error('expected a created lane')
  expect(done.data).toBeUndefined()
  expect(store.getLane(done.laneId)).toMatchObject({ branch: 'taken-2', worktree: true })
  expect(
    execFileSync('git', ['branch', '--list', 'taken*'], {
      cwd: machine.repository,
      encoding: 'utf8',
    }),
  ).toContain('taken-2')
  await commands.close()
})

it('sends the first prompt through the lane runtime, so first-prompt hooks run', async () => {
  const s = setup([], vi.fn())
  const receipts: Receipt[] = []
  const commands = laneCommands(s, receipts)
  const firstPrompt = vi.spyOn(live, 'firstPrompt')
  const frame = createFrame({ prompt: 'Fix the login page' })
  await commands.submit(creator, frame)
  const done = receipts.at(-1)
  if (done?.status !== 'done' || !done.laneId) throw new Error('expected a created lane')
  expect(done.data).toEqual({ prompted: true })
  expect(s.runtime.command).toHaveBeenCalledWith(expect.any(String), {
    type: 'prompt',
    message: 'Fix the login page',
    id: frame.requestId,
  })
  expect(firstPrompt).toHaveBeenCalledWith(done.laneId, 'Fix the login page')
  expect(store.getLane(done.laneId)?.title).toBe('Fix the login page')
  // Auto-naming considered the lane; this fixture's pi reports no model to name with.
  await vi.waitFor(() =>
    expect(s.log).toHaveBeenCalledWith(
      'host',
      'lane.naming',
      expect.objectContaining({ laneId: done.laneId, outcome: 'skipped-no-model' }),
    ),
  )
  await commands.close()
})
