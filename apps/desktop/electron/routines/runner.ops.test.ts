import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PiRpcClient } from '@phosphor/session-runtime/pi/rpc-client'
import type { OpChannelRequestEvent } from '@phosphor/session-runtime/pi/op-channel'
import { newRoutine, type RoutineRun } from '@shared/routines'
import { executeRoutine } from './runner'

const h = vi.hoisted(() => ({
  spawn: vi.fn(),
  get: vi.fn(),
  dispose: vi.fn(),
  gitInfo: vi.fn(),
}))
vi.mock('../pi/session-runtime', () => ({ spawnSession: h.spawn }))
vi.mock('../registry', () => ({ registry: { get: h.get, list: () => [], dispose: h.dispose } }))
vi.mock('../fs/lane-workspace', () => ({ createLaneWorkspace: vi.fn() }))
vi.mock('@phosphor/session-runtime/git/git-info', () => ({ gitInfo: h.gitInfo }))
vi.mock('../claude/accounts', () => ({ bindSession: vi.fn() }))
vi.mock('../pi/session-accounts', () => ({
  spawnAccountFor: () => undefined,
  forgetSpawnAccount: vi.fn(),
}))
vi.mock('../pi/stub', () => ({ piStubPath: () => '/stub' }))
vi.mock('../broadcast', () => ({ broadcast: vi.fn() }))

const OP_PI = join(
  import.meta.dirname,
  '../../../../libs/session-runtime/src/pi/__fixtures__/op-pi.cjs',
)
let directory: string
let client: PiRpcClient | undefined
beforeEach(() => {
  vi.clearAllMocks()
  directory = mkdtempSync(join(tmpdir(), 'routine-runner-ops-'))
  h.gitInfo.mockResolvedValue({ isRepo: false })
  h.spawn.mockResolvedValue({ sessionId: 'session' })
  h.dispose.mockImplementation(() => client?.dispose())
})
afterEach(async () => {
  await client?.dispose()
  client = undefined
  rmSync(directory, { recursive: true, force: true })
})

function run(): RoutineRun {
  return {
    id: 'run',
    routineId: 'routine',
    trigger: 'manual',
    scheduledAt: Date.now(),
    createdAt: Date.now(),
    startedAt: Date.now(),
    endedAt: null,
    status: 'running',
    reason: '',
    definition: {
      ...newRoutine(directory),
      provider: 'test',
      model: 'model',
      name: 'Test',
      instructions: 'Report.',
      trusted: true,
      id: 'routine',
      revision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      nextAt: null,
      attention: null,
      archived: false,
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

/** Desktop's runner over a real client whose pi sends one op request on prompt. */
function execute(env: Record<string, string>, owner?: (event: OpChannelRequestEvent) => void) {
  const live = new PiRpcClient(
    { cwd: directory, binaryPath: process.execPath, prefixArgs: [OP_PI], env },
    { log: vi.fn(), isClosing: () => false },
  )
  client = live
  if (owner) live.on('phosphor-op', owner)
  live.spawn()
  h.get.mockReturnValue({ client: live })
  return executeRoutine(run(), new AbortController().signal, vi.fn())
}

describe('Desktop routine runner and the op channel', () => {
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
