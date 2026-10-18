import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readAgentSettings } from '@phosphor/session-runtime/pi/agent-settings'
import { listPackages } from '@phosphor/session-runtime/pi/packages'
import { stat } from 'node:fs/promises'
import { fail, pass, type Check } from '../checks'
import type { HostConfigV1 } from '../config/schema'
import { checkClaudeLane } from '../machine/claude'
import { buildPiEnvironment } from '../machine/environment'
import { checkGit, resolvePi } from '../machine/executables'
import { checkProviders } from '../machine/providers'
import type * as Providers from '../machine/providers'
import type * as Tailscale from '../machine/tailscale'
import { checkRepositories } from '../machine/repositories'
import { checkExtensions } from '../machine/resources'
import { inspectTailscale } from '../machine/tailscale'
import type { DoctorContext } from './doctor'
import { inspectClaude, inspectProbes } from './doctor-probes'

vi.mock('node:fs/promises', () => ({ stat: vi.fn() }))
vi.mock('@phosphor/session-runtime/pi/agent-settings', () => ({ readAgentSettings: vi.fn() }))
vi.mock('@phosphor/session-runtime/pi/packages', () => ({ listPackages: vi.fn() }))
vi.mock('../machine/executables', () => ({ resolvePi: vi.fn(), checkGit: vi.fn(), which: vi.fn() }))
vi.mock('../machine/providers', async (original) => ({
  ...(await original<typeof Providers>()),
  checkProviders: vi.fn(),
}))
vi.mock('../machine/repositories', () => ({ checkRepositories: vi.fn() }))
vi.mock('../machine/resources', () => ({ checkExtensions: vi.fn() }))
vi.mock('../machine/tailscale', async (original) => ({
  ...(await original<typeof Tailscale>()),
  inspectTailscale: vi.fn(),
}))
vi.mock('../machine/claude', () => ({ checkClaudeLane: vi.fn() }))

const context: DoctorContext = {
  configPath: '/host/config.json',
  env: { HOME: '/home/host' },
  platform: 'linux',
  uid: 1,
  home: '/home/host',
  hostname: 'host',
  nodeVersion: '22.22.3',
  defaultResourceRoot: '/bundle',
  probeTimeoutMs: 123,
}
const config: HostConfigV1 = { version: 1, pi: { executable: '/pi' }, repositories: ['/repo'] }
const environment = buildPiEnvironment({ hostEnv: context.env, platform: context.platform })
const launch = { binaryPath: '/pi', prefixArgs: [], version: '1.2.0' }

beforeEach(() => {
  vi.mocked(resolvePi).mockResolvedValue({ launch, checks: [pass('pi', 'ready')] })
  vi.mocked(checkGit).mockResolvedValue({ git: '/git', check: pass('git', 'ready') })
  vi.mocked(checkExtensions).mockResolvedValue(pass('extensions', 'ready'))
  vi.mocked(checkRepositories).mockResolvedValue({
    roots: ['/repo'],
    checks: [pass('repository', 'ready')],
  })
  vi.mocked(stat).mockRejectedValue(new Error('absent'))
  vi.mocked(readAgentSettings).mockResolvedValue({ defaultProvider: 'xai' })
  vi.mocked(checkProviders).mockResolvedValue([
    { id: 'xai', name: 'XAI', status: 'ready', default: true },
  ])
  vi.mocked(inspectTailscale).mockResolvedValue({
    name: null,
    readiness: 'missing',
    state: 'unknown',
    endpoint: null,
    executable: null,
    port: 47615,
  })
  vi.mocked(listPackages).mockResolvedValue([])
  vi.mocked(checkClaudeLane).mockResolvedValue({ available: false, reason: 'not installed' })
})
afterEach(() => {
  vi.resetAllMocks()
})

it('awaits each probe in order and passes earlier results to dependent checks', async () => {
  const checks: Check[] = []
  const result = await inspectProbes(context, config, environment, checks)
  const calls = [
    resolvePi,
    checkGit,
    checkExtensions,
    checkRepositories,
    stat,
    readAgentSettings,
    checkProviders,
    inspectTailscale,
  ].map((fn) => vi.mocked(fn).mock.invocationCallOrder[0])
  expect(calls).toEqual([...calls].sort((a, b) => a! - b!))
  expect(checks.map((check) => check.id)).toEqual([
    'pi',
    'git',
    'extensions',
    'repository',
    'agent-dir',
    'providers',
    'context-budget',
    'accounts',
    'compression',
    'Tailscale',
  ])
  expect(resolvePi).toHaveBeenCalledWith(config.pi, environment, { timeoutMs: 123 })
  expect(checkExtensions).toHaveBeenCalledWith('/bundle')
  expect(checkRepositories).toHaveBeenCalledWith(['/repo'], {
    home: context.home,
    git: '/git',
    environment,
  })
  expect(checkProviders).toHaveBeenCalledWith(launch, environment, {
    defaultProvider: 'xai',
    timeoutMs: 123,
  })
  expect(result).toMatchObject({
    pi: { launch },
    repositories: { roots: ['/repo'] },
    piDefault: 'xai',
  })
})

it('continues partial inspection without pi but skips settings and provider checks', async () => {
  vi.mocked(resolvePi).mockResolvedValue({ launch: null, checks: [fail('pi', 'missing')] })
  const checks: Check[] = []
  const result = await inspectProbes(
    context,
    { ...config, contextBudget: 'off' },
    environment,
    checks,
  )
  expect(result.pi.launch).toBeNull()
  expect(result.providers).toBeUndefined()
  expect(readAgentSettings).not.toHaveBeenCalled()
  expect(checkProviders).not.toHaveBeenCalled()
  expect(checkRepositories).toHaveBeenCalledOnce()
  expect(inspectTailscale).toHaveBeenCalledOnce()
  expect(checks.find((check) => check.id === 'context-budget')?.summary).toContain(
    "pi's own compaction threshold",
  )
})

it('does not read packages or probe Claude when the native lane is unavailable', async () => {
  expect(await inspectClaude(context, environment, { available: false })).toEqual({
    claude: { available: false, reason: 'needs the native lane' },
    claudeLane: null,
  })
  expect(listPackages).not.toHaveBeenCalled()
  expect(checkClaudeLane).not.toHaveBeenCalled()
})

it('keeps the checked Claude result and treats package-read failures as optional', async () => {
  const lane = { available: true as const, claude: '/claude', version: '2.1.0' }
  vi.mocked(checkClaudeLane).mockResolvedValue(lane)
  expect(await inspectClaude(context, environment, { available: true })).toEqual({
    claude: { available: true, detail: '/claude 2.1.0, logged in' },
    claudeLane: lane,
  })
  expect(checkClaudeLane).toHaveBeenCalledWith([], environment, { timeoutMs: 123 })
  vi.mocked(listPackages).mockRejectedValue(new Error('unreadable'))
  expect(await inspectClaude(context, environment, { available: true })).toEqual({
    claude: { available: false, reason: "pi's packages could not be read: unreadable" },
    claudeLane: null,
  })
})
