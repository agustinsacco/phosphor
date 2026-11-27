import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gitInfo } from '@phosphor/session-runtime/git/git-info'
import { PiRpcClient } from '@phosphor/session-runtime/pi/rpc-client'
import type { OpChannelRequestEvent } from '@phosphor/session-runtime/pi/op-channel'
import { bindSessionEvents } from '@phosphor/session-runtime/pi/session-events'
import { newRoutine, type RoutineRun } from '@phosphor/shared/routines'
import { createLifecycle } from '../session/lifecycle'
import type { HostRuntime } from '../session/runtime'
import { createRoutineExecutor } from './runner'

vi.mock('@phosphor/session-runtime/git/git-info', () => ({ gitInfo: vi.fn() }))

const OP_PI = join(
  import.meta.dirname,
  '../../../../libs/session-runtime/src/pi/__fixtures__/op-pi.cjs',
)
const root = realpathSync.native(tmpdir())
const sessionId = 'routine-op-session'
const clients: PiRpcClient[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(clients.splice(0).map((client) => client.dispose()))
})

function run(): RoutineRun {
  return {
    id: 'run',
    routineId: 'routine',
    trigger: 'manual',
    scheduledAt: 0,
    createdAt: 0,
    startedAt: 0,
    endedAt: null,
    status: 'running',
    reason: '',
    definition: {
      ...newRoutine(root),
      id: 'routine',
      revision: 1,
      createdAt: 0,
      updatedAt: 0,
      nextAt: null,
      attention: null,
      archived: false,
      instructions: 'Report.',
      provider: 'test',
      model: 'model',
      isolated: false,
      intent: 'report',
    },
    sessionId: null,
    sessionPath: null,
    workspacePath: null,
    branch: null,
    baseCommit: null,
    accountId: null,
    summary: '',
  }
}

/** The Host runner over a real client: pi's output reaches it through the real session events. */
function execute(env: Record<string, string>, owner?: (event: OpChannelRequestEvent) => void) {
  vi.mocked(gitInfo).mockResolvedValue({ isRepo: false, branch: '', dirtyCount: 0 })
  const client = new PiRpcClient(
    { cwd: root, binaryPath: process.execPath, prefixArgs: [OP_PI], env },
    { log: vi.fn(), isClosing: () => false },
  )
  clients.push(client)
  if (owner) client.on('phosphor-op', owner)
  const runtime = {
    withAuthorization: <T>(_allowed: () => boolean, work: () => Promise<T>) => work(),
    mutateStoppedSession: <T>(_path: string, change: () => Promise<T>) => change(),
    withSessionFile: <T>(_path: string, read: (owner: () => undefined) => Promise<T>) =>
      read(() => undefined),
    replaceRoots: vi.fn<HostRuntime['replaceRoots']>(),
    life: createLifecycle(vi.fn()),
    drain: vi.fn<HostRuntime['drain']>(),
    start: vi.fn<HostRuntime['start']>(),
    command: vi.fn<HostRuntime['command']>(),
    exportHtml: vi.fn<HostRuntime['exportHtml']>(),
    extensionUiResponse: vi.fn<HostRuntime['extensionUiResponse']>(),
    stop: vi.fn<HostRuntime['stop']>(),
    remove: vi.fn<HostRuntime['remove']>(),
    list: vi.fn<HostRuntime['list']>().mockReturnValue([]),
    accountForSession: vi.fn<HostRuntime['accountForSession']>(),
    startRoutine: vi.fn<HostRuntime['startRoutine']>().mockImplementation(async (_, deliver) => {
      bindSessionEvents(
        { sessionId, workspacePath: root, client },
        {
          emit: deliver,
          log: vi.fn(),
          budget: { watch: () => {}, read: () => '', paused: () => false },
          onExtensionUI: () => {},
        },
      )
      client.spawn()
      return { sessionId, workspacePath: root }
    }),
    routineClient: vi.fn<HostRuntime['routineClient']>().mockReturnValue(client),
    stopRoutine: vi.fn<HostRuntime['stopRoutine']>().mockImplementation(() => client.dispose()),
    liveLanes: () => 0,
    refreshDirectives: vi.fn(async () => 0),
    abortTurns: vi.fn<HostRuntime['abortTurns']>(async () => []),
    mcpControl: vi.fn<HostRuntime['mcpControl']>(),
    reloadNow: vi.fn<HostRuntime['reloadNow']>(),
  } satisfies HostRuntime
  const signal = new AbortController().signal
  return createRoutineExecutor(runtime, (path) => path)(run(), signal, vi.fn())
}

describe('Host routine runner and the op channel', () => {
  it('finishes, not blocked, when the lane sends an op and no owner listens', async () => {
    const outcome = await execute({ PHOSPHOR_OPS: 'v1' })
    expect(outcome.status).toBe('finished')
    expect(outcome.summary).toContain('"code":"no-owner"')
  })

  it('continues when the owner denies an asked op as unattended', async () => {
    const outcome = await execute({ PHOSPHOR_OPS: 'v1' }, ({ request, respond }) =>
      respond({
        v: 1,
        id: request.id,
        status: 'denied',
        code: 'unattended',
        text: 'No one is watching this run.',
      }),
    )
    expect(outcome.status).toBe('finished')
    expect(outcome.summary).toContain('"code":"unattended"')
  })

  it('still ends blocked on the same editor request in a session without the marker', async () => {
    const outcome = await execute({})
    expect(outcome.status).toBe('blocked')
  })
})
