import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionPush } from '@phosphor/shared/models'
import type { RpcCommand, RpcSessionState } from '@phosphor/shared/rpc'
import { fakeMachine, type FakeMachine } from '../../__fixtures__/machine'
import type { HostRuntime, Delivery } from '../../session/runtime'
import { createLiveLanes } from '../live'
import { openStore, type HostStore } from '../store'
import { checkedOutBranch } from './branch'
import { attach, start } from './lifecycle'
import type { RuntimeLaneState } from './state'

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
const ended = (willRetry?: boolean): SessionPush => ({
  kind: 'event',
  event: { type: 'agent_end', messages: [], ...(willRetry ? { willRetry } : {}) },
})

let machine: FakeMachine
let store: HostStore
let live: ReturnType<typeof createLiveLanes>
let repositoryId: string
beforeEach(async () => {
  machine = fakeMachine({ rpc: true })
  store = await openStore(join(machine.dir, 'state'), process.getuid?.())
  const repository = store.syncRepositories([machine.repository])[0]
  if (!repository) throw new Error('fixture')
  repositoryId = repository.id
})
afterEach(() => {
  live?.close()
  store.close()
  vi.restoreAllMocks()
  machine.cleanup()
})

const repo = (...args: string[]) =>
  execFileSync('git', ['-C', machine.repository, ...args], { stdio: 'ignore' })
const checkout = (branch: string) => repo('symbolic-ref', 'HEAD', `refs/heads/${branch}`)

async function attached(branch: string | null) {
  let deliver: Delivery = () => {}
  const runtime = {
    start: vi.fn(async (_request: unknown, sink?: Delivery) => {
      deliver = sink ?? (() => {})
      return { sessionId: randomUUID(), workspacePath: machine.repository }
    }),
    stop: vi.fn(async () => {}),
    command: vi.fn(async (_id: string, cmd: RpcCommand): ReturnType<HostRuntime['command']> => ({
      type: 'response',
      command: cmd.type,
      success: true,
      data: cmd.type === 'get_messages' ? { messages: [] } : state,
    })),
    extensionUiResponse: vi.fn(),
  }
  live = createLiveLanes({ epoch: '0123456789abcdef', store, runtime, now: Date.now, log: vi.fn() })
  const context: RuntimeLaneState = {
    options: { runtime, store, live, log: vi.fn() },
    bindings: new Map(),
  }
  const lane = store.ensureLane({
    repositoryId,
    cwd: machine.repository,
    sessionFile: null,
    branch,
  })
  const session = await start(context, {})
  await attach(context, lane.laneId, session.sessionId)
  return { laneId: lane.laneId, push: (push: SessionPush) => deliver(push) }
}

describe('a lane branch follows its folder', () => {
  it('reads the checked-out branch, and nothing for a detached HEAD or a plain folder', async () => {
    checkout('feature/one')
    expect(await checkedOutBranch(machine.repository)).toBe('feature/one')
    repo('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'i')
    repo('checkout', '-q', '--detach')
    expect(await checkedOutBranch(machine.repository)).toBeNull()
    const plain = join(machine.dir, 'plain')
    await mkdir(plain)
    expect(await checkedOutBranch(plain)).toBeNull()
  })

  it('records the branch the folder is on when the lane attaches', async () => {
    checkout('phosphor/renamed')
    const { laneId } = await attached('phosphor/slug')
    expect(store.getLane(laneId)?.branch).toBe('phosphor/renamed')
    expect(live.summaryFor(laneId)?.branch).toBe('phosphor/renamed')
  })

  it('publishes a branch switched during a run once the run ends', async () => {
    checkout('feature/one')
    const { laneId, push } = await attached('feature/one')
    const delta = vi.spyOn(live.lanesTopic, 'delta')
    checkout('feature/two')
    push(ended(true))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(store.getLane(laneId)?.branch).toBe('feature/one')
    push(ended())
    await vi.waitFor(() => expect(store.getLane(laneId)?.branch).toBe('feature/two'))
    await vi.waitFor(() =>
      expect(delta.mock.calls.some(([upsert]) => upsert[0]?.branch === 'feature/two')).toBe(true),
    )
  })

  it('keeps the last branch while HEAD is detached', async () => {
    checkout('feature/one')
    repo('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'i')
    repo('checkout', '-q', '--detach')
    const { laneId, push } = await attached('feature/one')
    push(ended())
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(store.getLane(laneId)?.branch).toBe('feature/one')
  })
})
