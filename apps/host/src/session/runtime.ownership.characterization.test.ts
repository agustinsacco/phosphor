import type * as SessionStartupModule from '@phosphor/session-runtime/pi/session-startup'
import type * as SessionDeletionModule from '@phosphor/session-runtime/pi/session-deletion'
import type * as SessionServiceModule from '@phosphor/session-runtime/pi/session-service'
import type * as SessionLaunchModule from '@phosphor/session-runtime/pi/session-launch'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createSessionService } from '@phosphor/session-runtime/pi/session-service'
import { createSessionDeletion } from '@phosphor/session-runtime/pi/session-deletion'
import { createSessionStartup } from '@phosphor/session-runtime/pi/session-startup'
import { EXTENSIONS_ROOT } from '../__fixtures__/machine'
import { createHostRuntime, type HostRuntime } from './runtime'

const launch = vi.hoisted(() => ({ wait: undefined as Promise<void> | undefined, entered: false }))
vi.mock('@phosphor/session-runtime/pi/session-launch', async (original) => {
  const actual = await original<typeof SessionLaunchModule>()
  return {
    ...actual,
    prepareSessionLaunch: async (...args: Parameters<typeof actual.prepareSessionLaunch>) => {
      launch.entered = true
      await launch.wait
      return actual.prepareSessionLaunch(...args)
    },
  }
})
vi.mock('@phosphor/session-runtime/pi/session-service', async (original) => {
  const actual = await original<typeof SessionServiceModule>()
  return { ...actual, createSessionService: vi.fn(actual.createSessionService) }
})
vi.mock('@phosphor/session-runtime/pi/session-deletion', async (original) => {
  const actual = await original<typeof SessionDeletionModule>()
  return { ...actual, createSessionDeletion: vi.fn(actual.createSessionDeletion) }
})
vi.mock('@phosphor/session-runtime/pi/session-startup', async (original) => {
  const actual = await original<typeof SessionStartupModule>()
  return { ...actual, createSessionStartup: vi.fn(actual.createSessionStartup) }
})

let dir: string
let repo: string
let runtime: HostRuntime
const owned = new Set<string>()
const routines = {
  owns: (id: string) => owned.has(id),
  sessionForPath: () => undefined,
  observe: vi.fn(),
  cancel: vi.fn(async (id: string) => {
    owned.delete(id)
  }),
}
beforeEach(() => {
  vi.clearAllMocks()
  owned.clear()
  launch.wait = undefined
  launch.entered = false
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'host-ownership-'))
  repo = join(dir, 'repo')
  mkdirSync(repo)
  vi.stubEnv('PI_CODING_AGENT_DIR', join(dir, 'agent'))
  vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', undefined)
  vi.stubEnv('PATH', process.env.PATH)
  runtime = createHostRuntime(
    {
      pi: {
        binaryPath: process.execPath,
        prefixArgs: [join(import.meta.dirname, '../__fixtures__/fake-pi.cjs')],
      },
      env: { PATH: process.env.PATH!, HOME: dir, PI_CODING_AGENT_DIR: join(dir, 'agent') },
      roots: [repo],
      resourceRoot: EXTENSIONS_ROOT,
      contextBudget: '',
      log: { write: () => {}, hide: (text) => text, path: () => null },
    },
    { routines, timings: { abortMs: 2000, graceMs: 1000, deadlineMs: 10000, settleMs: 1000 } },
  )
  runtime.life.to('validating')
  runtime.life.to('ready')
})
afterEach(async () => {
  const draining = runtime.drain('test over')
  void runtime.drain('hurried')
  await draining
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})
async function until(find: () => boolean, what: string) {
  for (let n = 0; n < 500; n++) {
    if (find()) return
    await sleep(10)
  }
  throw new Error(`timed out: ${what}`)
}
async function fileFor(id: string) {
  const state = await runtime.command(id, { type: 'get_state' })
  if (!state.success || !state.data) throw new Error('no state')
  const file = (state.data as { sessionFile: string }).sessionFile
  await runtime.command(id, { type: 'prompt', message: 'hello' })
  for (let n = 0; n < 500; n++) {
    const next = await runtime.command(id, { type: 'get_state' })
    if (next.success && !(next.data as { isStreaming: boolean }).isStreaming && existsSync(file))
      return file
    await sleep(10)
  }
  throw new Error('turn did not persist')
}
function movedFile(first: string) {
  const files = readdirSync(dirname(first))
    .map((name) => join(dirname(first), name))
    .filter((file) => file !== first)
  expect(files).toHaveLength(1)
  return files[0]!
}

it.each(['reply', 'state'])(
  'blocks every resume/delete while extension %s is held, but admits new sessions',
  async (held) => {
    const { sessionId } = await runtime.start({ repository: repo })
    const first = await fileFor(sessionId)
    const release = join(dir, 'release')
    const prompt = runtime.command(sessionId, {
      type: 'prompt',
      message: `/fake-clone-hold-${held} ${release}`,
    })
    await until(() => existsSync(`${release}.held`), 'held command')
    const moved = movedFile(first)
    for (const sessionPath of [first, moved]) {
      const request = { repository: repo, sessionPath }
      await expect(runtime.start(request)).rejects.toThrow(
        'a session is running a command that may move it',
      )
      await expect(runtime.remove(request)).rejects.toThrow(
        'a session is running a command that may move it',
      )
    }
    await runtime.start({ repository: repo })
    writeFileSync(release, '')
    expect(await prompt).toMatchObject({ success: true })
    await expect(runtime.start({ repository: repo, sessionPath: moved })).rejects.toThrow(
      'already running',
    )
    await expect(runtime.remove({ repository: repo, sessionPath: moved })).rejects.toThrow(
      'stop it first',
    )
  },
)

it.each([
  ['/fake-clone-lose-state', false],
  ['/fake-clone-hide-file', true],
] as const)(
  'keeps failed relearn blocked until success or disposal: %s',
  async (message, recoverable) => {
    const { sessionId } = await runtime.start({ repository: repo })
    const first = await fileFor(sessionId)
    expect(await runtime.command(sessionId, { type: 'prompt', message })).toMatchObject({
      success: true,
    })
    const request = { repository: repo, sessionPath: movedFile(first) }
    await expect(runtime.start(request)).rejects.toThrow('pi could not say which')
    await expect(runtime.remove(request)).rejects.toThrow('pi could not say which')
    await runtime.start({ repository: repo })
    const recovered = runtime.command(sessionId, { type: 'prompt', message: '/fake-find-file' })
    if (recoverable) {
      expect(await recovered).toMatchObject({ success: true })
      await expect(runtime.start(request)).rejects.toThrow('already running')
      await expect(runtime.remove(request)).rejects.toThrow('stop it first')
    } else {
      await expect(recovered).rejects.toThrow('Cannot verify the active pi model.')
      await expect(runtime.remove(request)).rejects.toThrow('pi could not say which')
    }
    await runtime.stop(sessionId)
    await runtime.remove(request)
    expect(existsSync(request.sessionPath)).toBe(false)
  },
)

it('shares registry and path-lock identity and cancels a racing resume before deletion', async () => {
  const { sessionId } = await runtime.start({ repository: repo })
  const sessionPath = await fileFor(sessionId)
  await runtime.stop(sessionId)
  const service = vi.mocked(createSessionService).mock.calls[0]![0]
  const deletion = vi.mocked(createSessionDeletion).mock.calls[0]![0]
  const startup = vi.mocked(createSessionStartup).mock.calls[0]![0]
  expect(service.registry).toBe(deletion.registry)
  expect(service.registry).toBe(startup.registry)
  expect(service.paths).toBe(deletion.paths)
  let release!: () => void
  launch.entered = false
  launch.wait = new Promise<void>((resolve) => {
    release = resolve
  })
  const request = { repository: repo, sessionPath }
  const opening = runtime.start(request)
  const rejected = expect(opening).rejects.toMatchObject({ name: 'AbortError' })
  await until(() => launch.entered, 'resume launch')
  const cancelled = vi.spyOn(service.paths, 'cancelSessionOpens')
  const removing = runtime.remove(request)
  await until(() => cancelled.mock.calls.length > 0, 'deletion cancels resume')
  release()
  await rejected
  await removing
  expect(runtime.list()).toEqual([])
  expect(existsSync(sessionPath)).toBe(false)
})

it('retains routine ownership guards, unattended execution and dynamic compaction pause', async () => {
  const service = vi.mocked(createSessionService).mock.calls[0]![0]
  const spawn = vi.spyOn(service, 'spawn')
  const routine = await runtime.startRoutine({ repository: repo }, () => {}, {})
  expect(spawn.mock.calls[0]?.[2]).toMatchObject({ unattended: true })
  const { sessionId } = routine
  const startup = vi.mocked(createSessionStartup).mock.calls[0]![0]
  expect(startup.budget.paused(sessionId)).toBe(false)
  expect(() => runtime.routineClient(sessionId)).toThrow('not a routine session')
  await expect(runtime.stopRoutine(sessionId)).rejects.toThrow('not a routine session')
  owned.add(sessionId)
  expect(startup.budget.paused(sessionId)).toBe(true)
  expect(runtime.routineClient(sessionId)).toBe(service.registry.get(sessionId)?.client)
  await expect(runtime.command(sessionId, { type: 'prompt', message: 'manual' })).rejects.toThrow(
    'owned by a running routine',
  )
  await expect(runtime.stop(sessionId)).rejects.toThrow('routine owns this session')
  expect(await runtime.command(sessionId, { type: 'get_state' })).toMatchObject({ success: true })
  await runtime.command(sessionId, { type: 'get_messages' })
  expect(routines.observe).toHaveBeenCalledWith(sessionId)
  await runtime.stopRoutine(sessionId)
  expect(runtime.list()).toEqual([])
})
