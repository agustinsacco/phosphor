import type * as StartupModule from '@phosphor/session-runtime/pi/session-startup'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createSessionStartup } from '@phosphor/session-runtime/pi/session-startup'
import { composeDirectives } from '@phosphor/shared/agent-directives'

const DIRECTIVES = {
  machineAwareness: true,
  worktreeGuard: true,
  laneCharter: true,
  subagentPolicy: true,
}

vi.mock('@phosphor/session-runtime/pi/session-startup', async (original) => {
  const actual = await original<typeof StartupModule>()
  return { ...actual, createSessionStartup: vi.fn(actual.createSessionStartup) }
})
vi.mock('../registry', () => ({ registry: { create: vi.fn(), dispose: vi.fn() } }))
vi.mock('../maintenance/history', () => ({
  decideSession: vi.fn(),
  recordWorkspaceIntent: vi.fn(),
  withWorkspace: vi.fn(),
}))
vi.mock('./session-path-lock', () => ({ sessionPaths: {} }))
vi.mock('./stub', () => ({ piStubPath: () => null }))
vi.mock('./session-events', () => ({ desktopSessionSink: vi.fn() }))
vi.mock('../claude/accounts', () => ({ holdAccount: vi.fn() }))
vi.mock('./session-accounts', () => ({
  forgetSpawnAccount: vi.fn(),
  rememberSpawnAccount: vi.fn(),
}))
vi.mock('./context-budget', () => ({ watchContextBudget: vi.fn(), withBudgetCompaction: vi.fn() }))
vi.mock('../store', () => ({
  getPrefs: () => ({ contextBudget: '' }),
  recordWorkspace: vi.fn(),
  realPathOrNull: (path: string) => path,
}))
vi.mock('../debug-log', () => ({ log: vi.fn() }))
vi.mock('@phosphor/session-runtime/pi/lane-reload', () => ({
  createLaneReload: () => ({ capture: async () => 'config', track: vi.fn() }),
}))
vi.mock('./session-launch', () => ({
  prepareDesktopSessionLaunch: async () => ({
    stub: false,
    binaryPath: '/Applications/Phosphor.app/node',
    prefixArgs: ['/pi/cli.js'],
    env: { PATH: '/usr/bin:/bin', PHOSPHOR_ARTIFACT_STORE: '/artifacts' },
    extensions: ['/resources/pi-ext/artifacts.ts', '/resources/pi-ext/lane-reload.ts'],
  }),
}))
vi.mock('./session-policy', () => ({
  desktopSessionPolicy: {
    git: async () => ({ isRepo: false }),
    preferences: () => ({
      agentDirectives: {
        machineAwareness: true,
        worktreeGuard: true,
        laneCharter: true,
        subagentPolicy: true,
      },
      agentDirectivesByProject: {},
      contextFiles: { claude: true, agents: false },
    }),
    machineContext: () => ({ kind: 'desktop', signedIn: true }),
    defaultProvider: async () => 'native',
    packages: async () => [],
    account: async () => null,
    compressionEnvironment: () => ({ HEADROOM_URL: 'http://127.0.0.1:8787' }),
    resetCompaction: async () => {},
  },
}))

beforeEach(() => vi.stubEnv('PI_CODING_AGENT_DIR', '/nonexistent/pinned-agent'))
afterEach(() => vi.unstubAllEnvs())

it('spawns one Desktop lane with exactly the argv and env inputs it had before contributions', async () => {
  await import('./session-runtime')
  const runtime = vi.mocked(createSessionStartup).mock.calls[0]![0]
  const captured: unknown[] = []
  const stop = new Error('captured')
  const spawn = vi.mocked(createSessionStartup).getMockImplementation()!({
    ...runtime,
    registry: {
      create: (_workspace, options) => {
        captured.push(options)
        throw stop
      },
      dispose: async () => {},
    },
  })
  await expect(
    spawn({ workspacePath: '/repo', name: 'Pinned', model: 'm', provider: 'p' }, () => () => {}),
  ).rejects.toBe(stop)
  expect(captured).toEqual([
    {
      ownProcessGroup: true,
      binaryPath: '/Applications/Phosphor.app/node',
      prefixArgs: ['/pi/cli.js'],
      sessionPath: undefined,
      forkFrom: undefined,
      name: 'Pinned',
      model: 'm',
      provider: 'p',
      thinkingLevel: undefined,
      appendSystemPrompt: composeDirectives({
        cwd: '/repo',
        git: { isRepo: false },
        prefs: DIRECTIVES,
        machine: { kind: 'desktop', signedIn: true },
      }),
      extensions: ['/resources/pi-ext/artifacts.ts', '/resources/pi-ext/lane-reload.ts'],
      env: {
        PATH: '/usr/bin:/bin',
        PHOSPHOR_ARTIFACT_STORE: '/artifacts',
        HEADROOM_URL: 'http://127.0.0.1:8787',
        PHOSPHOR_CONTEXT_FILES: 'agents=off',
      },
    },
  ])
  expect(Object.keys(captured[0] as object)).not.toContain('skills')
})
