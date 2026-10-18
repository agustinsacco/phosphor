import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MIN_PI_VERSION, type PiHealth } from '@shared/models'
import { PiUnavailableError, resolvePiInvoker, type PiInvocationProfile } from './invoker'

const h = vi.hoisted(() => ({
  app: { isPackaged: false },
  health: vi.fn<() => Promise<PiHealth>>(),
  environment: vi.fn(async () => ({ PATH: '/shell/bin', SHELL_SECRET: 'current' })),
}))
vi.mock('electron', () => ({ app: h.app }))
vi.mock('./health', () => ({ cachedPiHealth: h.health }))
vi.mock('./shell-env', () => ({ piProcessEnv: h.environment }))

beforeEach(() => {
  vi.clearAllMocks()
  h.app.isPackaged = false
  vi.stubEnv('PHOSPHOR_PI_STUB', '')
  h.health.mockResolvedValue({ ok: true, binaryPath: '/bin/pi', minVersion: MIN_PI_VERSION })
})
afterEach(() => vi.unstubAllEnvs())

it('keeps Windows node and entry-script prefix separate and protects cached prefix arguments', async () => {
  const prefixArgs = ['C:\\pi\\index.js']
  h.health.mockResolvedValue({
    ok: true,
    binaryPath: 'C:\\node.exe',
    prefixArgs,
    minVersion: MIN_PI_VERSION,
  })
  const invoker = await resolvePiInvoker('minimal-stub')
  expect(invoker).toEqual({
    binaryPath: 'C:\\node.exe',
    prefixArgs,
    stub: false,
    env: { PATH: '/shell/bin', SHELL_SECRET: 'current' },
  })
  invoker.prefixArgs.push('caller-only')
  expect(prefixArgs).toEqual(['C:\\pi\\index.js'])
})

it.each(['minimal-stub', 'inherited-stub', 'piProcessEnv-stub'] as PiInvocationProfile[])(
  'uses the login-shell environment for real pi under %s',
  async (profile) => {
    expect(await resolvePiInvoker(profile)).toEqual({
      binaryPath: '/bin/pi',
      prefixArgs: [],
      env: { PATH: '/shell/bin', SHELL_SECRET: 'current' },
      stub: false,
    })
  },
)

it.each([
  ['not-found', undefined, 'pi is not available'],
  ['too-old', 'Please upgrade pi', 'Please upgrade pi'],
] as const)(
  'rejects %s without reading invocation environment',
  async (reason, message, expected) => {
    h.health.mockResolvedValue({ ok: false, minVersion: MIN_PI_VERSION, reason, message })
    await expect(resolvePiInvoker('minimal-stub')).rejects.toThrow(PiUnavailableError)
    await expect(resolvePiInvoker('minimal-stub')).rejects.toThrow(expected)
    expect(h.environment).not.toHaveBeenCalled()
  },
)

it('keeps minimal stub environments isolated from both inherited and login-shell values', async () => {
  vi.stubEnv('PHOSPHOR_PI_STUB', '/stub.cjs')
  expect(await resolvePiInvoker('minimal-stub')).toEqual({
    binaryPath: process.execPath,
    prefixArgs: ['/stub.cjs'],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    stub: true,
  })
  expect(h.environment).not.toHaveBeenCalled()
  expect(h.health).not.toHaveBeenCalled()
})

it('inherits process values but not shell values for inherited stubs', async () => {
  vi.stubEnv('PHOSPHOR_PI_STUB', '/stub.cjs')
  vi.stubEnv('ELECTRON_RUN_AS_NODE', '0')
  const invoker = await resolvePiInvoker('inherited-stub')
  expect(invoker.env).toEqual({ ...process.env, ELECTRON_RUN_AS_NODE: '1' })
  expect(h.environment).not.toHaveBeenCalled()
  expect(h.health).not.toHaveBeenCalled()
})

it('uses piProcessEnv for shell-aware stubs without caching or mutating the environment', async () => {
  vi.stubEnv('PHOSPHOR_PI_STUB', '/stub.cjs')
  const first = await resolvePiInvoker('piProcessEnv-stub')
  expect(first.env).toEqual({
    PATH: '/shell/bin',
    SHELL_SECRET: 'current',
    ELECTRON_RUN_AS_NODE: '1',
  })
  first.env.SHELL_SECRET = 'caller override'
  expect((await resolvePiInvoker('piProcessEnv-stub')).env.SHELL_SECRET).toBe('current')
  expect(h.environment).toHaveBeenCalledTimes(2)
  expect(h.health).not.toHaveBeenCalled()
})

it('does not honor an environment-provided stub in a packaged application', async () => {
  h.app.isPackaged = true
  vi.stubEnv('PHOSPHOR_PI_STUB', '/untrusted.cjs')
  expect(await resolvePiInvoker('minimal-stub')).toMatchObject({
    binaryPath: '/bin/pi',
    prefixArgs: [],
    stub: false,
  })
  expect(h.health).toHaveBeenCalledOnce()
})

it('does not retain caller overlays or stale credentials between real invocations', async () => {
  const first = await resolvePiInvoker('minimal-stub')
  first.env.SHELL_SECRET = 'account override'
  h.environment.mockResolvedValueOnce({ PATH: '/new/bin', SHELL_SECRET: 'rotated' })
  expect((await resolvePiInvoker('minimal-stub')).env).toEqual({
    PATH: '/new/bin',
    SHELL_SECRET: 'rotated',
  })
})
