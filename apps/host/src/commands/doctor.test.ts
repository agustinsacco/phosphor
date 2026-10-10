import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { validateHostHello } from '@phosphor/shared/remote-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXTENSIONS_ROOT, fakeMachine, SECRET, type FakeMachine } from '../__fixtures__/machine'
import { HOST_VERSION } from '../version'
import { renderDoctor, runDoctor, type DoctorContext, type DoctorReport } from './doctor'

let machine: FakeMachine
beforeEach(() => {
  machine = fakeMachine()
  // pi's layout is read from the process environment, as the runtime reads it.
  vi.stubEnv('PI_CODING_AGENT_DIR', machine.agentDir)
})
afterEach(() => {
  vi.unstubAllEnvs()
  machine.cleanup()
})

const context = (overrides: Partial<DoctorContext> = {}): DoctorContext => ({
  configPath: machine.configPath,
  env: machine.hostEnv,
  platform: 'linux',
  uid: process.getuid!(),
  home: machine.home,
  hostname: 'bee1.tail9f6158.ts.net',
  nodeVersion: '22.22.3',
  defaultResourceRoot: '/nonexistent',
  probeTimeoutMs: 5_000,
  ...overrides,
})
const statuses = (report: DoctorReport) =>
  report.checks.map((check) => `${check.status} ${check.id}`)

describe('doctor', () => {
  it('passes a healthy machine: native lane, names-only environment, a valid hello', async () => {
    const report = await runDoctor(context())
    expect(report).toMatchObject({ ok: true, exitCode: 0, config: { hostId: 'test-host' } })
    expect(statuses(report)).toEqual([
      'pass host-node',
      'pass config',
      'pass pi-node',
      'pass pi',
      'pass git',
      'pass extensions',
      'pass repository',
      'pass agent-dir',
      'info context-budget',
      'info accounts',
      'info compression',
    ])
    expect(report.lanes.native).toEqual({ available: true })
    expect(report.lanes.claude.reason).toContain('(it is not installed)')
    expect(report.environment?.names).toEqual([
      'ANTHROPIC_API_KEY',
      'HOME',
      'LANG',
      'PATH',
      'PI_CODING_AGENT_DIR',
      'USER',
    ])
    expect(report.environment?.path[0]).toBe(dirname(process.execPath))
    expect(validateHostHello(report.hello, 'test-host')).toMatchObject({ ok: true })
    expect(report.hello?.capabilities).toEqual(['sessions.read', 'sessions.control'])
    expect(JSON.stringify(report)).not.toContain(SECRET)
  })

  it.each([
    ['as it is', {}],
    ['across the cut at 200 characters', { PI_FAKE_PAD: '170' }],
    ['across lines', { ANTHROPIC_API_KEY: `${SECRET}\nsecond-line-of-the-key` }],
  ])('never prints a secret value a program echoes %s', async (_how, extra) => {
    const env = { ...machine.hostEnv, PI_FAKE_MODE: 'leak', ...extra }
    const report = await runDoctor(context({ env }))
    expect(report).toMatchObject({ ok: false, exitCode: 69 })
    expect(report.lanes.native).toEqual({ available: false, reason: 'failed: pi' })
    const pi = report.checks.find((check) => check.id === 'pi')
    expect(pi?.summary).toMatch(/cannot start with x*\[redacted\]$/)
    for (const text of [JSON.stringify(report), renderDoctor(report)]) {
      expect(text).not.toContain(SECRET.slice(0, 8))
      expect(text).not.toContain('second-line')
    }
  })

  it.each([
    [
      // AWS_PROFILE is a provider variable, so its value is a secret.
      'its host id',
      { hostId: 'production' },
      { AWS_PROFILE: 'production' },
      'the host id holds the value of AWS_PROFILE, which pi receives: set /hostId to another name',
    ],
    [
      // A passed variable's value is a secret, whatever its name.
      'its version',
      { environment: { pass: ['BUILD_VERSION'] } },
      { BUILD_VERSION: HOST_VERSION },
      'the hello field hostVersion holds the value of BUILD_VERSION, which pi receives: ' +
        "change that value, or keep it out of pi's environment",
    ],
    [
      'a capability',
      { environment: { pass: ['MODE'] } },
      { MODE: 'sessions.control' },
      'the hello field capabilities holds the value of MODE, which pi receives: ' +
        "change that value, or keep it out of pi's environment",
    ],
  ])('never presents a hello with a secret value in %s', async (_where, config, env, summary) => {
    machine.writeConfig({ ...machine.config, ...config })
    const report = await runDoctor(context({ env: { ...machine.hostEnv, ...env } }))
    expect(report).toMatchObject({ ok: false, exitCode: 78 })
    expect(report.checks).toContainEqual({ id: 'hello', status: 'fail', summary, exit: 78 })
    expect(report.hello).toBeUndefined()
    expect(report.lanes.native.reason).toBe('failed: hello')
    const [value] = Object.values(env)
    expect(JSON.stringify(report)).not.toContain(value)
    expect(renderDoctor(report)).not.toContain(value)
  })

  it('presents the hello when no variable pi receives holds its values', async () => {
    machine.writeConfig({ ...machine.config, hostId: 'production' })
    expect(await runDoctor(context())).toMatchObject({ ok: true, hello: { hostId: 'production' } })
  })

  it('stops at an unusable config with every problem and exit 78', async () => {
    machine.writeConfig({ ...machine.config, version: 2, run: true })
    const report = await runDoctor(context())
    expect(report).toMatchObject({ ok: false, exitCode: 78 })
    expect(statuses(report)).toEqual(['pass host-node', 'fail config'])
    expect(report.config.errors?.map((error) => error.pointer)).toEqual(['/run', '/version'])
    expect(renderDoctor(report)).toContain('        /version: must be 1')
  })

  it('exits 78 for a Node-script pi without /pi/node, 69 for a missing prerequisite', async () => {
    const healthy = machine.config
    machine.writeConfig({ ...healthy, pi: { executable: machine.pi } })
    expect((await runDoctor(context())).exitCode).toBe(78)
    machine.writeConfig({ ...healthy, repositories: [join(machine.dir, 'gone')] })
    const missing = await runDoctor(context())
    expect(missing.exitCode).toBe(69)
    expect(missing.lanes.native.reason).toBe('failed: repository')
    // Both at once: the config problem wins, since fixing it may fix the rest.
    machine.writeConfig({
      ...healthy,
      pi: { executable: machine.pi },
      repositories: [join(machine.dir, 'gone')],
    })
    const both = await runDoctor(context())
    expect(both.exitCode).toBe(78)
    expect(both.lanes.native.reason).toBe('failed: pi, repository')
    expect(statuses(await runDoctor(context({ nodeVersion: '20.11.0' })))[0]).toBe('fail host-node')
  })

  it('finds pi-ext/ beside the bundle when the config does not say', async () => {
    const { resourceRoot: _ignored, ...config } = machine.config
    machine.writeConfig(config)
    expect(statuses(await runDoctor(context()))).toContain('fail extensions')
    const report = await runDoctor(context({ defaultResourceRoot: EXTENSIONS_ROOT }))
    expect(statuses(report)).toContain('pass extensions')
  })

  it('warns about ambient authority, unset names and a missing agent folder', async () => {
    machine.writeConfig({
      ...machine.config,
      environment: { pass: ['SSH_AUTH_SOCK', 'NOT_SET'] },
    })
    rmSync(machine.agentDir, { recursive: true })
    const report = await runDoctor(context())
    expect(report.exitCode).toBe(0)
    expect(report.checks.filter((check) => check.status === 'warn')).toEqual([
      {
        id: 'environment',
        status: 'warn',
        summary: 'pi receives SSH_AUTH_SOCK, which act on other systems for you',
      },
      {
        id: 'environment',
        status: 'warn',
        summary: 'the config passes NOT_SET, which this Host does not have',
      },
      {
        id: 'agent-dir',
        status: 'warn',
        summary: `${machine.agentDir} does not exist yet: run pi once as this user and log in`,
      },
    ])
  })

  it('reports the Claude lane available with the provider package and a logged-in claude', async () => {
    machine.installClaude()
    const report = await runDoctor(context())
    expect(report.lanes.claude).toEqual({
      available: true,
      detail: `${machine.bin}/claude 2.1.283, logged in`,
    })
    expect(JSON.stringify(report)).not.toContain('person@example.com')
  })

  it('renders a readable report', async () => {
    const text = renderDoctor(await runDoctor(context()))
    expect(text).toMatch(/^phosphor 0\.0\.0-dev\.source · node 22\.22\.3 · linux\n/)
    expect(text).toContain(`  ok    pi              ${machine.cli} 0.87.1, started with node\n`)
    expect(text).toContain('\nlanes\n  native  available\n  claude  unavailable: ')
    expect(text.endsWith('\nready\n')).toBe(true)
  })
})
