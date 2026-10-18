import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionPush } from '@phosphor/shared/models'
import type { RpcCommand, RpcSessionState } from '@phosphor/shared/rpc'
import { fakeMachine, type FakeMachine } from '../../__fixtures__/machine'
import type { HostRuntime, Delivery } from '../../session/runtime'
import type { RuntimeLaneState, RuntimeLaneOptions } from './state'
import { start, attach, stop, hasSavedSession } from './lifecycle'
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

describe('lifecycle helpers', () => {
  it.each([256, 257, 1048576, 1048577])('bounds buffered pushes at %i', async (limit) => {
    const push: SessionPush = { kind: 'stderr', text: 'excluded' }
    const s = setup([push])
    const session = await start(s.context, {})
    const binding = s.context.bindings.get(session.sessionId)
    if (!binding) throw new Error('missing binding')
    expect(binding.pushes).toEqual([])
    const event: SessionPush = { kind: 'exit', code: 0, signal: null, expected: true }
    if (limit < 1000) {
      for (let i = 0; i < limit; i++) s.push(event)
    } else {
      // Extension UI payloads are measured in serialized bytes, not text length.
      const status: SessionPush = {
        kind: 'extension-ui',
        request: {
          type: 'extension_ui_request',
          id: 'status',
          method: 'setStatus',
          statusKey: 'test',
          statusText: '',
        },
      }
      const overhead = Buffer.byteLength(JSON.stringify(status))
      if (status.request.method === 'setStatus')
        status.request.statusText = 'x'.repeat(limit - overhead)
      s.push(status)
    }
    const overflow = limit === 257 || limit === 1048577
    expect(binding.overflow).toBe(overflow)
    expect(binding.pushes.length).toBe(overflow ? 0 : limit === 256 ? 256 : 1)
    if (overflow) {
      expect(binding.bytes).toBe(0)
      s.push(event)
      expect(binding.pushes).toEqual([])
    }
  })
  it('removes failed-stop bindings before awaiting pi and rejects late attachment', async () => {
    const s = setup([{ kind: 'exit', code: 0, signal: null, expected: true }])
    const session = await start(s.context, {})
    const binding = s.context.bindings.get(session.sessionId)
    s.runtime.stop.mockRejectedValueOnce(new Error('stop failed'))
    await expect(stop(s.context, session.sessionId)).rejects.toThrow('stop failed')
    expect(s.context.bindings.has(session.sessionId)).toBe(false)
    expect(binding?.pushes).toEqual([])
    await expect(attach(s.context, s.saved().laneId, session.sessionId)).rejects.toThrow(
      'unknown lane start',
    )
  })
  it('removes the previous incarnation when attaching a replacement', async () => {
    const s = setup()
    const first = await start(s.context, {})
    const lane = s.saved()
    await attach(s.context, lane.laneId, first.sessionId)
    const next = await start(s.context, {})
    await attach(s.context, lane.laneId, next.sessionId)
    expect(s.context.bindings.has(first.sessionId)).toBe(false)
    expect(live.sessionFor(lane.laneId)).toBe(next.sessionId)
  })
  it('classifies missing files but refuses directories', async () => {
    const file = join(machine.dir, 'transcript')
    expect(await hasSavedSession(undefined)).toBe(false)
    expect(await hasSavedSession(file)).toBe(false)
    await mkdir(file)
    expect(await hasSavedSession(join(file, 'missing'))).toBe(false)
    await expect(hasSavedSession(file)).rejects.toThrow('Model was not changed.')
    const regular = join(machine.dir, 'regular')
    await writeFile(regular, '{}')
    expect(await hasSavedSession(regular)).toBe(true)
    expect(await hasSavedSession(join(regular, 'child'))).toBe(false)
  })
})
