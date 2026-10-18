import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fakeMachine, SECRET, type FakeMachine } from '../__fixtures__/machine'
import * as identity from '../control/identity'
import * as executables from '../machine/executables'
import * as providers from '../machine/providers'
import * as claude from '../machine/claude'
import { inspectHost, renderDoctor, runDoctor, type DoctorContext } from './doctor'

let machine: FakeMachine
beforeEach(() => {
  machine = fakeMachine()
  vi.stubEnv('PI_CODING_AGENT_DIR', machine.agentDir)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  machine.cleanup()
})
const context = (overrides: Partial<DoctorContext> = {}): DoctorContext => ({
  configPath: machine.configPath,
  env: machine.hostEnv,
  platform: 'linux',
  uid: process.getuid!(),
  home: machine.home,
  hostname: 'fallback-host',
  nodeVersion: '22.22.3',
  defaultResourceRoot: '/nonexistent',
  probeTimeoutMs: 5_000,
  tailscale: { which: async () => null, probe: vi.fn() },
  ...overrides,
})

it('stops before probing invalid or missing config and distinguishes setup guidance', async () => {
  const probe = vi.spyOn(executables, 'resolvePi')
  machine.writeConfig({ ...machine.config, version: 2 })
  const invalid = await inspectHost(context({ nodeVersion: '20.11.0' }))
  expect(invalid.report).toMatchObject({
    exitCode: 78,
    checks: [
      { id: 'host-node', status: 'fail' },
      { id: 'config', status: 'fail' },
    ],
    lanes: {
      native: { available: false, reason: 'no usable config' },
      claude: { available: false, reason: 'no usable config' },
    },
  })
  expect(invalid.report.next).toBeUndefined()
  expect(invalid).toMatchObject({
    machine: null,
    secrets: [],
    piVersion: null,
    claude: null,
    pi: null,
  })
  rmSync(machine.configPath)
  const missing = await runDoctor(context())
  expect(missing.next).toBe('run phosphor setup')
  expect(missing.checks.map((check) => check.id)).toEqual(['host-node', 'config'])
  expect(probe).not.toHaveBeenCalled()
})

it('keeps check order and substitutes the unsigned-provider warning only for a ready Claude lane', async () => {
  machine.installClaude()
  const inspected = await inspectHost(context())
  expect(inspected.report.checks.map((check) => `${check.status} ${check.id}`)).toEqual([
    'pass host-node',
    'pass config',
    'pass pi-node',
    'pass pi',
    'pass git',
    'pass extensions',
    'pass repository',
    'pass agent-dir',
    'info providers',
    'info context-budget',
    'info accounts',
    'info compression',
    'warn Tailscale',
  ])
  expect(inspected.report.lanes).toEqual({
    native: { available: true },
    claude: { available: true, detail: `${machine.bin}/claude 2.1.283, logged in` },
  })
  expect(inspected.report.checks.find((check) => check.id === 'providers')?.summary).toBe(
    'no pi provider is signed in; the claude lane is ready',
  )
  expect(inspected.claude?.available).toBe(true)
  expect(inspected.report.exitCode).toBe(0)
})

it('gates provider and Claude probes while preserving partial pi inspection and config exit precedence', async () => {
  const providerProbe = vi.spyOn(providers, 'checkProviders')
  const claudeProbe = vi.spyOn(claude, 'checkClaudeLane')
  const healthy = machine.config
  machine.writeConfig({ ...healthy, repositories: [join(machine.dir, 'gone')] })
  const partial = await inspectHost(context())
  expect(partial.report.exitCode).toBe(69)
  expect(partial.report.lanes).toEqual({
    native: { available: false, reason: 'failed: repository' },
    claude: { available: false, reason: 'needs the native lane' },
  })
  expect(partial.pi?.launch.version).toBe('1.2.0')
  expect(partial.machine).toBeNull()
  expect(providerProbe).toHaveBeenCalledOnce()
  expect(claudeProbe).not.toHaveBeenCalled()
  machine.writeConfig({ ...machine.config, pi: { executable: machine.pi } })
  const both = await inspectHost(context())
  expect(both.report.exitCode).toBe(78)
  expect(both.report.lanes.native.reason).toBe('failed: pi, repository')
  expect(both.pi).toBeNull()
  expect(both.report.providers).toBeUndefined()
  expect(providerProbe).toHaveBeenCalledOnce()
  expect(claudeProbe).not.toHaveBeenCalled()
})

it('redacts nested report strings but retains the private environment for sessions', async () => {
  machine.writeConfig({ ...machine.config, environment: { pass: ['LABEL'] } })
  const inspected = await inspectHost(
    context({ env: { ...machine.hostEnv, LABEL: machine.repository } }),
  )
  expect(inspected.report.checks.find((check) => check.id === 'repository')?.summary).toContain(
    '[redacted]',
  )
  expect(inspected.machine?.roots[0]).toBe(machine.repository)
  expect(inspected.machine?.env.ANTHROPIC_API_KEY).toBe(SECRET)
  for (const text of [JSON.stringify(inspected.report), renderDoctor(inspected.report)]) {
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain(machine.repository)
  }
})

it('reads only public enrollment metadata, with hostname fallback for malformed metadata', async () => {
  const directory = join(dirname(machine.configPath), 'identity')
  mkdirSync(directory, { mode: 0o700 })
  writeFileSync(join(directory, 'host.json'), JSON.stringify({ label: 'Enrolled bee' }), {
    mode: 0o600,
  })
  const read = vi.spyOn(identity, 'readIdentityFile')
  const store = vi.spyOn(identity, 'createIdentityStore')
  expect((await inspectHost(context())).machine?.machineContext).toEqual({
    kind: 'host',
    label: 'Enrolled bee',
    os: 'Linux',
    repositories: ['repo'],
  })
  writeFileSync(join(directory, 'host.json'), 'not json', { mode: 0o600 })
  expect((await inspectHost(context())).machine?.machineContext?.label).toBe('fallback-host')
  expect(read.mock.calls.map((call) => call[2])).toEqual(['host.json', 'host.json'])
  expect(store).not.toHaveBeenCalled()
})

it('omits an exposed hello and gives a fresh diagnostic UUID on each safe inspection', async () => {
  machine.writeConfig({ ...machine.config, hostId: 'production' })
  const exposed = await runDoctor(
    context({ env: { ...machine.hostEnv, AWS_PROFILE: 'production' } }),
  )
  expect(exposed.hello).toBeUndefined()
  expect(exposed.exitCode).toBe(78)
  expect(exposed.lanes.native.reason).toBe('failed: hello')
  expect(exposed.checks.find((check) => check.id === 'hello')?.summary).toContain('AWS_PROFILE')
  expect(JSON.stringify(exposed)).not.toContain('production')
  const first = await runDoctor(context())
  const second = await runDoctor(context())
  expect(first.hello?.runtimeEpoch).toMatch(/^[a-f0-9-]{36}$/)
  expect(second.hello?.runtimeEpoch).not.toBe(first.hello?.runtimeEpoch)
})
