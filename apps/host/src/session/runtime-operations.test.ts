import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PiRpcClient } from '@phosphor/session-runtime/pi/rpc-client'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import { EXTENSIONS_ROOT } from '../__fixtures__/machine'
import { createRuntimeOperations } from './runtime-operations'
import { createRuntimeState, RequestError, type RuntimeOptions } from './runtime-state'
import type { RuntimeService } from './runtime-wiring'

let dir: string
let repo: string
beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'host-operations-'))
  repo = join(dir, 'repo')
  mkdirSync(repo)
  vi.stubEnv('PI_CODING_AGENT_DIR', join(dir, 'agent'))
  vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', undefined)
  vi.stubEnv('PATH', process.env.PATH)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})
function harness(options: RuntimeOptions = {}) {
  const state = createRuntimeState(
    {
      pi: { binaryPath: process.execPath, prefixArgs: [] },
      env: { PATH: process.env.PATH! },
      roots: [repo],
      resourceRoot: EXTENSIONS_ROOT,
      contextBudget: '',
      log: {
        write: vi.fn(),
        hide: (text) => text.replaceAll('secret', '[redacted]'),
        path: () => null,
      },
    },
    options,
  )
  const folder = sessionDirForCwd(repo)
  mkdirSync(folder, { recursive: true })
  const file = join(folder, 'a.jsonl')
  writeFileSync(file, '{}\n')
  const live = { sessionId: 'session', workspacePath: repo }
  const service: RuntimeService = {
    create: vi.fn(async (_request, delivery) => {
      if (delivery) state.started.add(delivery)
      return live
    }),
    command: vi.fn(async (): ReturnType<RuntimeService['command']> => ({
      type: 'response',
      command: 'abort',
      success: true,
    })),
    respond: vi.fn(),
    mcpControl: vi.fn(async () => ({ ok: false as const, message: 'Not used in this fixture.' })),
    dispose: vi.fn(async () => {}),
    list: () => [],
  }
  const deletion = vi.fn(async () => [] as string[])
  const client = new PiRpcClient({ cwd: repo }, { log: () => {}, isClosing: () => false })
  const request = vi.spyOn(client, 'request').mockResolvedValue({
    type: 'response',
    command: 'get_state',
    success: true,
    data: {
      sessionFile: file,
      sessionId: 'session',
      thinkingLevel: 'off',
      isStreaming: false,
      isCompacting: false,
      steeringMode: 'all',
      followUpMode: 'all',
      autoCompactionEnabled: true,
      messageCount: 0,
      pendingMessageCount: 0,
    },
  })
  vi.spyOn(state.registry, 'get').mockReturnValue({ ...live, client })
  const operations = createRuntimeOperations(state, service, deletion)
  const ready = () => {
    state.life.to('validating')
    state.life.to('ready')
  }
  return { state, operations, service, deletion, client, request, file, ready }
}
it('keeps a single explicit domain and owns roots, defaults, timings and machine context', () => {
  const { state, operations } = harness({ timings: { graceMs: 42 } })
  expect(state.life.state()).toBe('booting')
  expect(state.timings).toMatchObject({ graceMs: 42, abortMs: 5000 })
  expect(state.moving).toBe(0)
  expect(state.lost.size).toBe(0)
  const originalRoots = state.roots
  operations.replaceRoots([join(dir, 'added')])
  expect(state.roots).toBe(originalRoots)
  expect(state.machine.roots).toEqual([repo])
  expect(state.machineContext.repositories).toEqual(['added'])
  expect(process.env.PATH).toBe(state.machine.env.PATH)
  expect(() => createRuntimeState({ ...state.machine, env: {} }, {})).toThrow(
    "pi's environment has no PATH",
  )
})
it('checks readiness before parsing and reports request errors without admitting work', async () => {
  const { operations, service, ready, state } = harness()
  await expect(operations.start({})).rejects.toThrow('Host is booting')
  ready()
  await expect(operations.start({ repository: repo, env: {} })).rejects.toBeInstanceOf(RequestError)
  await expect(operations.remove({ repository: repo })).rejects.toMatchObject({
    errors: [{ pointer: '/sessionPath', message: 'is required' }],
  })
  expect(service.create).not.toHaveBeenCalled()
  state.life.to('draining')
  await expect(operations.remove({})).rejects.toThrow('Host is draining')
})
it('redacts stderr only and refuses a reused session delivery', async () => {
  const { operations, service, ready } = harness()
  ready()
  const deliver = vi.fn()
  await operations.start({ repository: repo }, deliver)
  const delivery = vi.mocked(service.create).mock.calls[0]![1]!
  delivery({ kind: 'stderr', text: 'secret' })
  expect(deliver).toHaveBeenCalledWith({ kind: 'stderr', text: '[redacted]' })
  vi.mocked(service.create).mockImplementationOnce(async () => ({
    sessionId: 'existing',
    workspacePath: repo,
  }))
  await expect(operations.start({ repository: repo })).rejects.toThrow('already running')
})
it('holds admission through relearn even when a command fails, then records lost identity', async () => {
  const { state, operations, service, request, ready, file } = harness()
  ready()
  let finish!: (response: Awaited<ReturnType<PiRpcClient['request']>>) => void
  request.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    }),
  )
  vi.mocked(service.command).mockRejectedValueOnce(new Error('command failed'))
  const running = operations.command('session', { type: 'prompt', message: '/extension' })
  const failure = running.catch((error: unknown) => error)
  await vi.waitFor(() => expect(request).toHaveBeenCalled())
  expect(state.moving).toBe(1)
  await expect(operations.start({ repository: repo, sessionPath: file })).rejects.toThrow(
    'may move it',
  )
  await operations.start({ repository: repo })
  finish({ type: 'response', command: 'get_state', success: false, error: 'state failed' })
  expect(await failure).toEqual(new Error('command failed'))
  expect(state.moving).toBe(0)
  expect(state.lost.has('session')).toBe(true)
  await expect(operations.remove({ repository: repo, sessionPath: file })).rejects.toThrow(
    'pi could not say which',
  )
  await operations.command('session', { type: 'prompt', message: '/recover' })
  expect(state.lost.size).toBe(0)
  await operations.remove({ repository: repo, sessionPath: file })
})
it('clears disposed lost sessions lazily and never marks ordinary prompts moving', async () => {
  const { state, operations, service, request, ready, file } = harness()
  ready()
  state.lost.add('disposed')
  vi.mocked(state.registry.get).mockReturnValue(undefined)
  await operations.remove({ repository: repo, sessionPath: file })
  expect(state.lost.size).toBe(0)
  await operations.command('session', { type: 'prompt', message: 'ordinary' })
  expect(state.moving).toBe(0)
  expect(request).not.toHaveBeenCalled()
  await expect(operations.command('session', { type: 'clone' })).rejects.toThrow('moves pi')
  expect(service.command).toHaveBeenCalledTimes(1)
})
it('uses unattended routine admission and guards routine/manual access', async () => {
  const routines = {
    owns: vi.fn(() => false),
    sessionForPath: () => undefined,
    observe: () => {},
    cancel: async () => {},
  }
  const { operations, service, state, client, ready } = harness({ routines })
  ready()
  const signal = new AbortController().signal
  const deliver = vi.fn()
  await operations.startRoutine({ repository: repo }, deliver, { signal, unattended: false })
  expect(service.create).toHaveBeenCalledWith({ workspacePath: repo }, deliver, {
    signal,
    unattended: true,
  })
  expect(() => operations.routineClient('session')).toThrow('not a routine session')
  await expect(operations.stopRoutine('session')).rejects.toThrow('not a routine session')
  routines.owns.mockReturnValue(true)
  expect(operations.routineClient('session')).toBe(client)
  await expect(operations.stop('session')).rejects.toThrow('routine owns this session')
  vi.mocked(state.registry.get).mockReturnValue(undefined)
  expect(() => operations.routineClient('session')).toThrow('routine session unavailable')
  await expect(operations.stopRoutine('session')).resolves.toBeUndefined()
  routines.owns.mockReturnValue(false)
  await expect(operations.stop('session')).rejects.toThrow('Unknown session: session')
})
it('requires readiness and a living client before delivering dialog responses', () => {
  const { operations, ready, client, service } = harness()
  const response = { type: 'extension_ui_response', id: 'dialog', cancelled: true } as const
  expect(() => operations.extensionUiResponse('session', response)).toThrow('Host is booting')
  ready()
  expect(() => operations.extensionUiResponse('session', response)).toThrow(
    'session is not running',
  )
  vi.spyOn(client, 'alive', 'get').mockReturnValue(true)
  operations.extensionUiResponse('session', response)
  expect(service.respond).toHaveBeenCalledWith('session', response)
})
