import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { MIN_PI_VERSION, type PiHealth } from '@shared/models'

const h = vi.hoisted(() => ({
  app: {
    isPackaged: false,
    getAppPath: vi.fn(() => '/repo/apps/desktop'),
    getPath: vi.fn(() => '/user-data'),
  },
  health: vi.fn<() => Promise<PiHealth>>(),
  resetHealth: vi.fn(),
  environment: vi.fn(async () => ({ PATH: '/login-shell/bin', PI_CLAUDE_CLI_CONTEXT: 'old' })),
  provider: vi.fn(() => ({ PI_CLAUDE_CLI_CONTEXT: 'pi' })),
}))
vi.mock('electron', () => ({ app: h.app }))
vi.mock('./health', async () => {
  const { createTtlCache } = await import('./ttl-cache')
  const cache = createTtlCache(async () => {
    const health = await h.health()
    if (!health.ok) throw health
    return health
  }, 5 * 60_000)
  h.resetHealth.mockImplementation(cache.invalidate)
  return { cachedPiHealth: () => cache.get().catch((health: PiHealth) => health) }
})
vi.mock('./shell-env', () => ({ piProcessEnv: h.environment }))
vi.mock('./provider-detect', () => ({ claudeProviderSpawnEnv: h.provider }))
const prepare = async () => (await import('./session-launch')).prepareDesktopSessionLaunch()

const originalResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  h.resetHealth()
  h.app.isPackaged = false
  h.health.mockResolvedValue({
    ok: true,
    minVersion: MIN_PI_VERSION,
    binaryPath: '/tools/node',
    prefixArgs: ['/tools/pi.js'],
  })
  vi.stubEnv('PHOSPHOR_PI_STUB', '')
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value: '/desktop/resources',
  })
})
afterEach(() => {
  vi.unstubAllEnvs()
  if (originalResources) Object.defineProperty(process, 'resourcesPath', originalResources)
  else Reflect.deleteProperty(process, 'resourcesPath')
})

it('retains shell PATH, provider overrides, Windows prefix arguments and dev resources', async () => {
  const launch = await prepare()
  expect(launch).toMatchObject({
    binaryPath: '/tools/node',
    prefixArgs: ['/tools/pi.js'],
    stub: false,
    env: {
      PATH: '/login-shell/bin',
      PI_CLAUDE_CLI_CONTEXT: 'pi',
      // The artifacts extension reads other sessions' artifacts from here.
      PHOSPHOR_ARTIFACT_STORE: join('/user-data', 'artifacts'),
    },
  })
  expect(launch.extensions[0]).toBe(
    join('/repo/apps/desktop', '../../libs/pi-extensions/pi-ext', 'artifacts.ts'),
  )
  await prepare()
  expect(h.health).toHaveBeenCalledOnce() // Successful discovery stays cached.
  expect(h.environment).toHaveBeenCalledTimes(2)
})

it('keeps the unpackaged stub independent of real discovery and environment', async () => {
  vi.stubEnv('PHOSPHOR_PI_STUB', '/fake-pi.cjs')
  expect(await prepare()).toMatchObject({
    stub: true,
    binaryPath: process.execPath,
    prefixArgs: ['/fake-pi.cjs'],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  })
  expect(h.health).not.toHaveBeenCalled()
  expect(h.environment).not.toHaveBeenCalled()
  expect(h.provider).not.toHaveBeenCalled()
})

it('ignores the stub in a packaged app and uses real discovery and packaged resources', async () => {
  h.app.isPackaged = true
  vi.stubEnv('PHOSPHOR_PI_STUB', '/untrusted.cjs')
  const launch = await prepare()
  expect(launch).toMatchObject({ stub: false, binaryPath: '/tools/node' })
  expect(launch.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
  expect(launch.extensions[0]).toBe(join('/desktop/resources', 'pi-ext', 'artifacts.ts'))
  expect(h.app.getAppPath).not.toHaveBeenCalled()
  expect(h.health).toHaveBeenCalledOnce()
})

it.each([
  ['Custom failure', 'Custom failure'],
  [undefined, 'pi is not available'],
])('preserves health errors and retries discovery (%s)', async (message, expected) => {
  h.health.mockResolvedValueOnce({ ok: false, minVersion: MIN_PI_VERSION, message })
  await expect(prepare()).rejects.toThrow(expected!)
  expect(h.environment).not.toHaveBeenCalled()
  expect(h.app.getAppPath).not.toHaveBeenCalled()
  expect((await prepare()).stub).toBe(false)
  expect(h.health).toHaveBeenCalledTimes(2)
})
