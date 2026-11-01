import type * as StartupModule from '@phosphor/session-runtime/pi/session-startup'
import type * as ServiceModule from '@phosphor/session-runtime/pi/session-service'
import type * as DeletionModule from '@phosphor/session-runtime/pi/session-deletion'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_DIRECTIVES, type SessionPush } from '@phosphor/shared/models'
import {
  createSessionStartup,
  type SessionSink,
} from '@phosphor/session-runtime/pi/session-startup'
import { createSessionService } from '@phosphor/session-runtime/pi/session-service'
import { createSessionDeletion } from '@phosphor/session-runtime/pi/session-deletion'
import { EXTENSIONS_ROOT } from '../__fixtures__/machine'
import { createRuntimeState, type RuntimeOptions } from './runtime-state'
import { wireRuntimeStartup, wireRuntimeService, wireRuntimeDeletion } from './runtime-wiring'

vi.mock('@phosphor/session-runtime/pi/session-startup', async (original) => {
  const actual = await original<typeof StartupModule>()
  return { ...actual, createSessionStartup: vi.fn(actual.createSessionStartup) }
})
vi.mock('@phosphor/session-runtime/pi/session-service', async (original) => {
  const actual = await original<typeof ServiceModule>()
  return { ...actual, createSessionService: vi.fn(actual.createSessionService) }
})
vi.mock('@phosphor/session-runtime/pi/session-deletion', async (original) => {
  const actual = await original<typeof DeletionModule>()
  return { ...actual, createSessionDeletion: vi.fn(actual.createSessionDeletion) }
})
let dir: string
let repo: string
beforeEach(() => {
  vi.clearAllMocks()
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'host-wiring-'))
  repo = join(dir, 'repo')
  mkdirSync(repo)
  vi.stubEnv('PATH', process.env.PATH)
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})
function setup(options: RuntimeOptions = {}) {
  const state = createRuntimeState(
    {
      pi: { binaryPath: '/trusted/pi', prefixArgs: ['trusted-cli'] },
      env: { PATH: process.env.PATH!, ONLY_MACHINE: 'yes' },
      roots: [repo],
      resourceRoot: EXTENSIONS_ROOT,
      contextBudget: '123456',
      log: { write: vi.fn(), hide: (text) => text, path: () => null },
    },
    options,
  )
  wireRuntimeStartup(state)
  const startup = vi.mocked(createSessionStartup).mock.calls[0]![0]
  let sink!: SessionSink
  const spawn = vi.fn(async (_options, delivery: SessionSink) => {
    sink = delivery
    return { sessionId: 'session', workspacePath: repo }
  })
  const service = wireRuntimeService(state, spawn)
  const deletion = wireRuntimeDeletion(state)
  return { state, startup, service, deletion, spawn, sink: () => sink('session') }
}
it('injects one registry/path domain into every wiring entry and pauses compaction dynamically', () => {
  const owns = vi.fn(() => false)
  const routines = {
    owns,
    sessionForPath: () => undefined,
    observe: () => {},
    cancel: async () => {},
  }
  const { state, startup } = setup({ routines })
  const service = vi.mocked(createSessionService).mock.calls[0]![0]
  const deletion = vi.mocked(createSessionDeletion).mock.calls[0]![0]
  expect(startup.registry).toBe(state.registry)
  expect(service.registry).toBe(state.registry)
  expect(deletion.registry).toBe(state.registry)
  expect(service.paths).toBe(state.paths)
  expect(deletion.paths).toBe(state.paths)
  expect(service.routines).toBe(routines)
  expect(startup.budget.watch).toBe(state.budget.watchContextBudget)
  expect(service.withBudgetCompaction).toBe(state.budget.withBudgetCompaction)
  expect(startup.budget.read()).toBe('123456')
  expect(startup.budget.paused('session')).toBe(false)
  owns.mockReturnValue(true)
  expect(startup.budget.paused('session')).toBe(true)
})
it('reads the directive toggles at each lane start, all on without a reader', () => {
  expect(setup().startup.policy.preferences().agentDirectives).toEqual(DEFAULT_AGENT_DIRECTIVES)
  vi.clearAllMocks()
  let laneCharter = true
  const { startup } = setup({
    agentDirectives: () => ({ ...DEFAULT_AGENT_DIRECTIVES, laneCharter }),
  })
  laneCharter = false
  expect(startup.policy.preferences().agentDirectives.laneCharter).toBe(false)
})
it('uses machine-only executable/environment and canonical workspace confinement', async () => {
  vi.stubEnv('UNTRUSTED_INHERITED', 'not forwarded')
  const { state, startup } = setup()
  const launch = await startup.launch()
  expect(launch).toMatchObject({
    binaryPath: '/trusted/pi',
    prefixArgs: ['trusted-cli'],
    stub: false,
  })
  expect(launch.env).toEqual({ ...state.machine.env, PI_CLAUDE_CLI_CONTEXT: 'pi' })
  expect(launch.extensions).toHaveLength(6)
  expect(state.machine.env).not.toHaveProperty('PI_CLAUDE_CLI_CONTEXT')
  const alias = join(dir, 'alias')
  symlinkSync(repo, alias)
  expect(startup.resolveWorkspace(alias)).toBe(repo)
  const outside = join(dir, 'repo-other')
  mkdirSync(outside)
  expect(() => startup.resolveWorkspace(outside)).toThrow('outside the configured repositories')
  state.roots.splice(0, 1, outside)
  expect(startup.resolveWorkspace(outside)).toBe(outside)
  expect(startup.budget.paused('session')).toBe(false)
})
it.each(['cancel', 'forward'] as const)(
  'keeps %s dialog behavior and delivers the original request',
  async (dialogs) => {
    const { state, service, sink } = setup({ dialogs })
    const deliver = vi.fn()
    await service.create({ workspacePath: repo }, deliver)
    expect(state.started.has(deliver)).toBe(true)
    const push: SessionPush = {
      kind: 'extension-ui',
      request: {
        type: 'extension_ui_request',
        id: 'dialog',
        method: 'confirm',
        title: 'Allow?',
        message: 'private body',
      },
    }
    sink()(push)
    expect(deliver).toHaveBeenCalledWith(push)
    if (dialogs === 'cancel') {
      expect(state.machine.log.write).toHaveBeenCalledWith('host', 'dialog cancelled', {
        sessionId: 'session',
        method: 'confirm',
        title: 'Allow?',
      })
    } else {
      expect(state.machine.log.write).toHaveBeenCalledExactlyOnceWith('host', 'dialog forwarded', {
        method: 'confirm',
      })
    }
  },
)
it('defaults to cancellation, ignores status dialogs and reports delivery failures', async () => {
  const { state, service, sink } = setup()
  await service.create({ workspacePath: repo }, () => {
    throw new Error('viewer gone')
  })
  const push: SessionPush = {
    kind: 'extension-ui',
    request: {
      type: 'extension_ui_request',
      id: 'status',
      method: 'setStatus',
      statusKey: 'key',
      statusText: 'value',
    },
  }
  expect(() => sink()(push)).not.toThrow()
  expect(state.machine.log.write).toHaveBeenCalledExactlyOnceWith('host', 'delivery failed', {
    sessionId: 'session',
    kind: 'extension-ui',
    error: 'viewer gone',
  })
  vi.mocked(state.machine.log.write).mockClear()
  sink()({
    kind: 'extension-ui',
    request: {
      type: 'extension_ui_request',
      id: 'dialog',
      method: 'confirm',
      title: 'Allow?',
      message: 'body',
    },
  })
  expect(state.machine.log.write).toHaveBeenCalledWith(
    'host',
    'dialog cancelled',
    expect.any(Object),
  )
})
it('does not silently swallow a logger exception while reporting a delivery failure', async () => {
  const { state, service, sink } = setup()
  await service.create({ workspacePath: repo }, () => {
    throw new Error('viewer gone')
  })
  const failure = new Error('logger failed')
  vi.mocked(state.machine.log.write).mockImplementation(() => {
    throw failure
  })
  expect(() => sink()({ kind: 'stderr', text: 'line' })).toThrow(failure)
})
