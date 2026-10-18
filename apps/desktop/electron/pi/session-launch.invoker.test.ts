import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { prepareSessionPolicy } from '@phosphor/session-runtime/pi/session-policy'
import { sessionFixture } from '@phosphor/session-runtime/pi/__fixtures__/session-runtime'
import { prepareDesktopSessionLaunch } from './session-launch'
import type { PiInvoker } from './invoker'

const h = vi.hoisted(() => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/repo/apps/desktop',
    getPath: () => '/data',
  },
  resolve: vi.fn<(profile: string) => Promise<PiInvoker>>(),
  provider: vi.fn(() => ({ PI_CLAUDE_CLI_CONTEXT: 'pi' })),
  artifacts: vi.fn(() => ({ PHOSPHOR_ARTIFACT_STORE: '/artifacts' })),
}))
vi.mock('electron', () => ({ app: h.app }))
vi.mock('./invoker', () => ({ resolvePiInvoker: h.resolve }))
vi.mock('./provider-detect', () => ({ claudeProviderSpawnEnv: h.provider }))
vi.mock('../artifacts/artifact-store-root', () => ({ artifactStoreEnv: h.artifacts }))

const originalResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
beforeEach(() => {
  vi.clearAllMocks()
  h.app.isPackaged = false
  h.resolve.mockResolvedValue({
    binaryPath: '/node',
    prefixArgs: ['/pi.js'],
    env: {
      PATH: '/shell/bin',
      PI_CLAUDE_CLI_CONTEXT: 'old',
      PHOSPHOR_ARTIFACT_STORE: '/old/artifacts',
    },
    stub: false,
  })
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: '/resources' })
})
afterEach(() => {
  if (originalResources) Object.defineProperty(process, 'resourcesPath', originalResources)
  else Reflect.deleteProperty(process, 'resourcesPath')
})

it('applies provider and artifact overlays without changing the resolved environment', async () => {
  const original = await h.resolve('minimal-stub')
  h.resolve.mockClear()
  const launch = await prepareDesktopSessionLaunch()
  expect(h.resolve).toHaveBeenCalledExactlyOnceWith('minimal-stub')
  expect(launch.env).toEqual({
    PATH: '/shell/bin',
    PI_CLAUDE_CLI_CONTEXT: 'pi',
    PHOSPHOR_ARTIFACT_STORE: '/artifacts',
  })
  expect(original.env.PI_CLAUDE_CLI_CONTEXT).toBe('old')
  expect(original.env.PHOSPHOR_ARTIFACT_STORE).toBe('/old/artifacts')
  expect(launch.extensions[0]).toBe(join('/repo/libs/pi-extensions/pi-ext/artifacts.ts'))
})

it('uses packaged resources without changing the executable prefix', async () => {
  h.app.isPackaged = true
  const launch = await prepareDesktopSessionLaunch()
  expect(launch).toMatchObject({ binaryPath: '/node', prefixArgs: ['/pi.js'], stub: false })
  expect(launch.extensions[0]).toBe(join('/resources/pi-ext/artifacts.ts'))
})

it('keeps stub environments minimal and omits extensions at the session policy boundary', async () => {
  h.resolve.mockResolvedValue({
    binaryPath: process.execPath,
    prefixArgs: ['/stub.cjs'],
    stub: true,
    env: { ELECTRON_RUN_AS_NODE: '1' },
  })
  const launch = await prepareDesktopSessionLaunch()
  expect(launch.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
  expect(h.provider).not.toHaveBeenCalled()
  expect(h.artifacts).not.toHaveBeenCalled()
  const { runtime } = sessionFixture()
  const { spawnOptions } = await prepareSessionPolicy(
    { workspacePath: '/repo' },
    {},
    launch,
    runtime.policy,
  )
  expect(spawnOptions).not.toHaveProperty('extensions')
  expect(spawnOptions).toMatchObject({
    binaryPath: process.execPath,
    prefixArgs: ['/stub.cjs'],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  })
})
