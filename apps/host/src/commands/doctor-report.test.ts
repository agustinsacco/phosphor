import { afterEach, expect, it, vi } from 'vitest'
import { validateHostHello } from '@phosphor/shared/remote-host'
import { fail, info, pass, type Check } from '../checks'
import type { HostConfigV1 } from '../config/schema'
import { readIdentityFile } from '../control/identity'
import { buildPiEnvironment } from '../machine/environment'
import type { DoctorContext, Lane } from './doctor'
import type { DoctorProbes } from './doctor-probes'
import {
  buildHello,
  buildMachine,
  helloExposure,
  nativeLane,
  nextStep,
  providersCheck,
  redactStrings,
  reportPolicy,
  unavailable,
} from './doctor-report'

vi.mock('../control/identity', () => ({
  identityDirectory: (path: string) => `${path}/identity`,
  readIdentityFile: vi.fn(),
}))
afterEach(() => {
  vi.resetAllMocks()
})
const context: DoctorContext = {
  configPath: '/host/config.json',
  env: {},
  platform: 'linux',
  uid: 1,
  home: '/home/host',
  hostname: 'hostname',
  nodeVersion: '22.22.3',
  defaultResourceRoot: '/bundle',
}
const config: HostConfigV1 = { version: 1, pi: { executable: '/pi' }, repositories: ['/work/repo'] }
const environment = buildPiEnvironment({
  hostEnv: { API_KEY: 'private-value' },
  pass: ['API_KEY'],
  platform: 'linux',
})
const probes = (): DoctorProbes => ({
  pi: { launch: { binaryPath: '/pi', prefixArgs: [], version: '1.2.0' }, checks: [] },
  repositories: { roots: ['/canonical/repo'], checks: [] },
  providers: [{ id: 'xai', name: 'XAI', status: 'ready', default: true }],
  piDefault: 'xai',
  tailscale: {
    name: null,
    readiness: 'ok',
    state: 'ours',
    endpoint: null,
    executable: '/tailscale',
    port: 47615,
  },
})
const ready: Lane = { available: true }
const noClaude = unavailable('not installed')

it('deduplicates failures in check order and preserves config-over-prerequisite precedence', () => {
  const checks = [
    fail('pi', 'missing'),
    fail('repository', 'missing'),
    fail('pi', 'bad config', 78),
  ]
  expect(nativeLane(checks)).toEqual({
    failed: ['pi', 'repository'],
    native: unavailable('failed: pi, repository'),
  })
  expect(reportPolicy(checks, probes(), noClaude)).toMatchObject({ exitCode: 78, next: undefined })
  expect(reportPolicy([fail('pi', 'missing')], probes(), noClaude).exitCode).toBe(69)
  expect(nativeLane([pass('pi', 'ready')]).native).toEqual(ready)
})

it('substitutes only the unsigned-provider warning when Claude is ready', () => {
  const result = { ...probes(), providers: [] }
  const checks = [providersCheck([])]
  expect(reportPolicy(checks, result, noClaude).next).toBe(
    'sign in to a provider: phosphor providers login PROVIDER',
  )
  expect(checks[0]?.status).toBe('warn')
  expect(reportPolicy(checks, result, ready).next).toContain('--lane claude --claude-model ID')
  expect(checks).toEqual([
    info('providers', 'no pi provider is signed in; the claude lane is ready'),
  ])
  const defaultWarning = providersCheck([
    { id: 'xai', name: 'XAI', status: 'not_ready', default: true },
  ])
  const other = [defaultWarning]
  reportPolicy(other, result, ready)
  expect(other).toEqual([defaultWarning])
})

it('prioritizes provider login, Tailscale readiness, route setup and then acceptance', () => {
  const result = probes()
  expect(reportPolicy([], result, noClaude).next).toBe(nextStep(result.providers!, noClaude, 'xai'))
  result.tailscale.state = 'absent'
  expect(reportPolicy([], result, noClaude).next).toBe('phosphor setup')
  result.tailscale.readiness = 'missing'
  expect(reportPolicy([], result, noClaude).next).toBe(
    'Tailscale is missing: install Tailscale first.',
  )
  result.providers = []
  expect(reportPolicy([], result, noClaude).next).toBe(
    'sign in to a provider: phosphor providers login PROVIDER',
  )
})

it('provides route-only repair guidance but none when other checks fail', () => {
  const result = probes()
  result.tailscale.state = 'other'
  const checks: Check[] = [fail('Tailscale serve', 'other route', 78)]
  expect(reportPolicy(checks, result, noClaude).next).toContain(
    'will not replace a route it did not make',
  )
  checks.push(fail('pi', 'missing'))
  expect(reportPolicy(checks, result, noClaude).next).toBeUndefined()
})

it('validates a fresh diagnostic hello and identifies secret-bearing fields without their values', () => {
  const hello = buildHello('host')
  expect(validateHostHello(hello, 'host').ok).toBe(true)
  expect(buildHello('host').runtimeEpoch).not.toBe(hello.runtimeEpoch)
  expect(helloExposure(hello, environment)).toBeNull()
  const exposed = { ...hello, hostId: 'private-value' }
  const check = helloExposure(exposed, environment)
  expect(check).toMatchObject({ id: 'hello', status: 'fail', exit: 78 })
  expect(check?.summary).toContain('API_KEY')
  expect(check?.summary).not.toContain('private-value')
  expect(
    redactStrings(
      { nested: ['private-value', { value: 'a private-value b' }] },
      environment.secrets,
    ),
  ).toEqual({
    nested: ['[redacted]', { value: 'a [redacted] b' }],
  })
})

it.each([
  ['darwin', 'macOS'],
  ['win32', 'Windows'],
  ['linux', 'Linux'],
  ['freebsd', 'freebsd'],
] as const)(
  'builds metadata-only machine context for %s without loading a signing key',
  async (platform, os) => {
    vi.mocked(readIdentityFile).mockResolvedValue('{"label":"Enrolled label"}')
    const machine = await buildMachine(
      { ...context, platform },
      config,
      environment,
      probes(),
      ready,
    )
    expect(machine).toEqual({
      pi: { binaryPath: '/pi', prefixArgs: [] },
      env: environment.env,
      roots: ['/canonical/repo'],
      resourceRoot: '/bundle',
      contextBudget: '',
      machineContext: { kind: 'host', label: 'Enrolled label', os, repositories: ['repo'] },
    })
    expect(readIdentityFile).toHaveBeenCalledExactlyOnceWith(
      '/host/config.json/identity',
      1,
      'host.json',
    )
  },
)

it.each(['not json', '{}', '{"label":"   "}', '{"label":5}'])(
  'falls back to hostname for invalid or missing public label %s',
  async (metadata) => {
    vi.mocked(readIdentityFile).mockResolvedValue(metadata)
    expect(
      (await buildMachine(context, config, environment, probes(), ready))?.machineContext?.label,
    ).toBe('hostname')
  },
)

it('keeps enrollment optional and withholds a machine when native or pi is unavailable', async () => {
  vi.mocked(readIdentityFile).mockRejectedValue(new Error('missing metadata'))
  const explicit = { ...config, resourceRoot: '/explicit', contextBudget: '100k', repositories: [] }
  const machine = await buildMachine(context, explicit, environment, probes(), ready)
  expect(machine).toMatchObject({
    resourceRoot: '/explicit',
    contextBudget: '100k',
    machineContext: { label: 'hostname', repositories: [] },
  })
  expect(await buildMachine(context, config, environment, probes(), noClaude)).toBeNull()
  const noPi = probes()
  noPi.pi.launch = null
  expect(await buildMachine(context, config, environment, noPi, ready)).toBeNull()
})
