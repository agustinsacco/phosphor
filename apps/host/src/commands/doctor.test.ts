import { rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { validateHostHello } from '@phosphor/shared/remote-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXTENSIONS_ROOT, fakeMachine, SECRET, type FakeMachine } from '../__fixtures__/machine'
import { HOST_VERSION } from '../version'
import {
  nextStep,
  renderDoctor,
  runDoctor,
  type DoctorContext,
  type DoctorReport,
  type Lane,
} from './doctor'
import type { ProviderState } from '../machine/providers'

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
  tailscale: { which: async () => null, probe: vi.fn() },
  ...overrides,
})
const statuses = (report: DoctorReport) =>
  report.checks.map((check) => `${check.status} ${check.id}`)

describe('doctor', () => {
  it.each(['ours', 'absent', 'other', 'funnel', 'unknown', 'missing', 'stopped'] as const)(
    'reports Tailscale serve %s and keeps missing Tailscale non-fatal',
    async (state) => {
      const name = 'bee.tail123.ts.net'
      const serve =
        state === 'ours'
          ? JSON.stringify({
              TCP: { 47615: { HTTPS: true } },
              Web: {
                [`${name}:47615`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:47615' } } },
              },
            })
          : state === 'absent'
            ? '{}'
            : state === 'other'
              ? '{"TCP":{"47615":{"HTTP":true}}}'
              : state === 'funnel'
                ? JSON.stringify({ AllowFunnel: { [`${name}:47615`]: true } })
                : 'bad'
      const probe = vi.fn(async (_file: string, args: readonly string[]) => ({
        code: 0,
        signal: null,
        stdout:
          args[0] === 'status'
            ? JSON.stringify({
                BackendState: state === 'stopped' ? 'Stopped' : 'Running',
                Self: { DNSName: `${name}.` },
                CertDomains: [name],
              })
            : serve,
        stderr: 'TAILSCALE_PRIVATE_OUTPUT',
        timedOut: false,
        truncated: false,
      }))
      const report = await runDoctor(
        context({
          tailscale: { which: async () => (state === 'missing' ? null : '/fake/tailscale'), probe },
        }),
      )
      expect(report.exitCode).toBe(state === 'other' || state === 'funnel' ? 78 : 0)
      const check = report.checks.find((item) => item.id === 'Tailscale serve')
      expect(check?.status).toBe(
        state === 'missing' || state === 'stopped'
          ? undefined
          : state === 'ours'
            ? 'pass'
            : state === 'other' || state === 'funnel'
              ? 'fail'
              : 'warn',
      )
      const text = renderDoctor(report)
      if (state === 'absent') expect(text).toContain('Run phosphor tailscale enable.')
      if (state === 'other' || state === 'funnel')
        expect(text).toContain('will not replace a route it did not make')
      if (state === 'funnel') expect(text).toContain('publish the Host to the internet')
      expect(text).not.toContain(name)
      expect(text).not.toContain('TAILSCALE_PRIVATE_OUTPUT')
    },
  )

  it('passes a healthy machine: native lane, names-only environment, a valid hello', async () => {
    machine.signIn('openai-codex')
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
      'pass providers',
      'info context-budget',
      'info accounts',
      'info compression',
      'warn Tailscale',
    ])
    expect(report.checks).toContainEqual({
      id: 'providers',
      status: 'pass',
      summary: 'signed in: ChatGPT (Codex)',
    })
    expect(report.providers?.map((provider) => `${provider.id} ${provider.status}`)).toEqual([
      'openai-codex ready',
      'anthropic not_ready',
      'github-copilot not_ready',
      'kimi-for-coding not_ready',
      'xai not_ready',
      'openrouter not_ready',
      'radius not_ready',
    ])
    // pi has no default provider here, so the lane is told which to run on.
    expect(report.next).toBe(
      'run real sessions on ChatGPT (Codex): phosphor accept --repository DIR --lane native ' +
        '--provider openai-codex --model ID (pi --list-models openai-codex lists them)',
    )
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
    expect(report.next).toBeUndefined()
  })

  it('names setup only when the config file is missing, in text and JSON', async () => {
    rmSync(machine.configPath)
    const report = await runDoctor(context())
    expect(report.exitCode).toBe(78)
    expect(JSON.parse(JSON.stringify(report)).next).toBe('run phosphor setup')
    expect(renderDoctor(report).endsWith('next: run phosphor setup\n')).toBe(true)
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
      { id: 'providers', status: 'warn', summary: 'none is signed in: phosphor providers' },
      {
        id: 'Tailscale',
        status: 'warn',
        summary: 'Tailscale is missing: install Tailscale first.',
      },
    ])
    expect(report.next).toBe('sign in to a provider: phosphor providers')
  })

  it("warns when pi's default provider is not signed in, whatever else is", async () => {
    machine.signIn('openai-codex')
    writeFileSync(join(machine.agentDir, 'settings.json'), '{"defaultProvider":"openai"}')
    const report = await runDoctor(context())
    expect(report.exitCode).toBe(0)
    expect(report.checks).toContainEqual({
      id: 'providers',
      status: 'warn',
      summary: "pi's default, openai, is not signed in: phosphor providers",
    })
    expect(report.providers?.at(-1)).toEqual({
      id: 'openai',
      name: 'openai',
      status: 'not_ready',
      reason: 'credentials_not_configured',
      default: true,
    })
    // Signed in to something else, so setup moves on there; the warning stays.
    expect(report.next).toBe(
      'run real sessions on ChatGPT (Codex): phosphor accept --repository DIR --lane native ' +
        '--provider openai-codex --model ID (pi --list-models openai-codex lists them)',
    )
  })

  it('counts the claude lane as something to run on, and asks pi nothing when pi is unusable', async () => {
    machine.installClaude()
    expect((await runDoctor(context())).next).toBe(
      'run real sessions on the claude lane: phosphor accept --repository DIR --lane claude ' +
        '--claude-model ID (pi --list-models pi-claude-cli lists them)',
    )
    const unusable = await runDoctor(context({ env: { ...machine.hostEnv, PI_FAKE_MODE: 'leak' } }))
    expect(unusable.providers).toBeUndefined()
    expect(unusable.next).toBeUndefined()
    expect(statuses(unusable)).not.toContain('warn providers')
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
    expect(text).toContain(`  ok    pi              ${machine.cli} 1.2.0, started with node\n`)
    expect(text).toContain('\nlanes\n  native  available\n  claude  unavailable: ')
    expect(text.endsWith('\nready\nnext: sign in to a provider: phosphor providers\n')).toBe(true)
  })
})

describe('nextStep', () => {
  const row = (id: string, status: ProviderState['status'], isDefault = false): ProviderState => ({
    id,
    name: id.toUpperCase(),
    status,
    ...(isDefault ? { default: true as const } : {}),
  })
  const claude: Lane = { available: true }
  const noClaude: Lane = { available: false, reason: 'not installed' }
  const ACCEPT = 'phosphor accept --repository DIR'

  it.each([
    [
      "pi's default is Claude and the claude lane is available",
      [row('xai', 'ready')],
      claude,
      'pi-claude-cli',
      `run real sessions on pi's default, the claude lane: ${ACCEPT} --lane claude`,
    ],
    [
      "pi's default is a signed-in provider, the claude lane aside",
      [row('xai', 'ready'), row('openai', 'ready', true)],
      claude,
      'openai',
      `run real sessions on pi's default, OPENAI: ${ACCEPT} --lane native`,
    ],
    [
      "pi's default is Claude, which is unavailable",
      [row('anthropic', 'not_ready'), row('xai', 'ready')],
      noClaude,
      'pi-claude-cli',
      `run real sessions on XAI: ${ACCEPT} --lane native --provider xai --model ID ` +
        '(pi --list-models xai lists them)',
    ],
    [
      "pi's default is not signed in, nor anything but the claude lane",
      [row('openai', 'not_ready', true)],
      claude,
      'openai',
      `run real sessions on the claude lane: ${ACCEPT} --lane claude --claude-model ID ` +
        '(pi --list-models pi-claude-cli lists them)',
    ],
    [
      'nothing is signed in',
      [row('xai', 'unknown'), row('openai', 'not_ready', true)],
      noClaude,
      'openai',
      'sign in to a provider: phosphor providers',
    ],
  ])('names an accept that runs as written when %s', (_when, providers, lane, piDefault, step) => {
    expect(nextStep(providers, lane, piDefault)).toBe(step)
  })
})
