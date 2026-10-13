import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeMachine, type FakeMachine } from './__fixtures__/machine'
import { hostLogDirectory } from './machine/log'
import { serviceExitPath } from './machine/launchd'
import type { Drainable } from './shutdown'
import { controlMachine } from './control/__fixtures__/machine'
import {
  runCli,
  USAGE,
  CLI_PARSE_CONFIG,
  scannedCommand,
  supervisedRun,
  type CliContext,
} from './cli'

let machine: FakeMachine | undefined
afterEach(() => {
  vi.unstubAllEnvs()
  machine?.cleanup()
  machine = undefined
})

// Every argv the CLI tests feed in also checks the raw scan against parseArgs.
function expectScanAgrees(argv: readonly string[]) {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({ ...CLI_PARSE_CONFIG, args: [...argv] })
  } catch {
    return
  }
  expect(scannedCommand(argv), JSON.stringify(argv)).toBe(parsed.positionals[0])
}

async function run(argv: readonly string[], context: Partial<CliContext> = {}) {
  expectScanAgrees(argv)
  const out = { stdout: '', stderr: '' }
  const code = await runCli(
    argv,
    { stdout: (text) => (out.stdout += text), stderr: (text) => (out.stderr += text) },
    {
      env: {},
      platform: 'linux',
      uid: process.getuid!(),
      home: '/nonexistent/home',
      hostname: 'bee1',
      nodeVersion: '22.22.3',
      defaultResourceRoot: '/nonexistent',
      tailscale: { which: async () => null, probe: vi.fn() },
      ...context,
    },
  )
  return { code, ...out }
}

const CONFIG_RUN_VALUE = ['--config', 'run', 'doctor', '--supervisor=launchd'] as const
const VERSION_CASES = [['version'], ['version', '--json']] as const
const HELP_CASES = [['help'], ['--help'], ['-h'], ['doctor', '--help']] as const
const USAGE_CASES: [string[], string][] = [
  [[], 'no command given'],
  [['tailscale'], 'tailscale needs status, enable or disable'],
  [['tailscale', 'funnel'], 'tailscale needs status, enable or disable'],
  [['tailscale', 'status', 'extra'], 'unexpected argument'],
  [['tailscale', 'status', '--json'], 'tailscale does not take --json'],
  [['serve'], 'unknown command "serve"'],
  [['accept'], 'accept needs --repository DIR'],
  [['accept', '--repository', 'repo'], '--repository needs an absolute path'],
  [
    ['accept', '--repository', '/a', '--repository', '/b'],
    '--repository may only repeat for setup',
  ],
  [['doctor', '--replace'], 'doctor does not take --replace'],
  [['doctor', '--pi', '/pi'], 'doctor does not take --pi'],
  [['setup', '--pi', ''], '--repository, --pi and --node need a path'],
  [['setup', '--node', ''], '--repository, --pi and --node need a path'],
  [['setup', '--repository', ''], '--repository, --pi and --node need a path'],
  [['accept', '--repository', '/repo', '--lane', 'both'], '--lane is native, claude or all'],
  [['doctor', '--repository', '/repo'], 'doctor does not take --repository'],
  [['doctor', '--model', 'm'], 'doctor does not take --model'],
  [['doctor', '--claude-model', 'm'], 'doctor does not take --claude-model'],
  [['version', '--keep-transcripts'], 'version does not take --keep-transcripts'],
  [['providers', '--repository', '/repo'], 'providers does not take --repository'],
  [['providers', 'status'], 'unexpected argument "status"'],
  [['providers', 'login'], 'providers login needs a provider: an id phosphor providers lists'],
  [['providers', 'login', 'xai', 'extra'], 'unexpected argument "extra"'],
  [['providers', 'login', 'xai', '--json'], 'providers login does not take --json'],
  [['providers', 'login', 'xai'], 'providers login needs a terminal: over SSH, run ssh -t'],
  [['doctor', '--nope'], "Unknown option '--nope'"],
  [['doctor', 'extra'], 'unexpected argument "extra"'],
  [['doctor', '--config'], "Option '--config <value>' argument missing"],
  [['doctor', '--config', ''], '--config needs a file'],
  [['version', '--config', '/x.json'], 'version does not take --config'],
  [['login', '--json'], 'login does not take --json'],
  [['status', '--local'], 'status does not take --local'],
  [['logout', '--json'], 'logout does not take --json'],
  [['login', 'extra'], 'unexpected argument'],
  [['run', '--supervisor', 'systemd'], '--supervisor is launchd'],
  [['run', '--supervisor', ''], '--supervisor is launchd'],
  [['run', '--supervisor'], "Option '--supervisor <value>' argument missing"],
  [['status', '--supervisor', 'launchd'], 'status does not take --supervisor'],
]

describe('phosphor', () => {
  it('prints its version, plain or as JSON', async () => {
    expect(await run(VERSION_CASES[0])).toEqual({
      code: 0,
      stdout: 'phosphor 0.0.0-dev.source\n',
      stderr: '',
    })
    expect(JSON.parse((await run(VERSION_CASES[1])).stdout)).toEqual({
      hostVersion: '0.0.0-dev.source',
      protocolVersion: 1,
      sourceSha: null,
      node: '22.22.3',
    })
  })

  it('prints usage when asked', async () => {
    for (const argv of HELP_CASES) {
      expect(await run(argv)).toEqual({ code: 0, stdout: USAGE, stderr: '' })
    }
  })

  it.each(USAGE_CASES)('refuses %j with exit 64 and usage on stderr', async (argv, problem) => {
    const result = await run(argv)
    expect(result).toMatchObject({ code: 64, stdout: '' })
    expect(result.stderr).toContain(problem)
    expect(result.stderr.endsWith(USAGE)).toBe(true)
  })

  it('scans the same command as parseArgs for shared CLI fixtures', () => {
    const cases = [
      ...USAGE_CASES.map(([argv]) => argv),
      ...VERSION_CASES,
      ...HELP_CASES,
      ['--config', '/tmp/config', 'run', '--supervisor', 'launchd'],
      ['--config=/tmp/config', 'run', '--supervisor=launchd'],
      ['-h', 'run'],
      ['--', 'run', '--supervisor', 'launchd'],
      CONFIG_RUN_VALUE,
      ['--config', 'run'],
      ['--config=run', 'doctor'],
    ]
    for (const argv of cases) expectScanAgrees(argv)
  })
  it('does not mistake --config run for the command', () => {
    const parsed = parseArgs({ ...CLI_PARSE_CONFIG, args: [...CONFIG_RUN_VALUE] })
    expect(scannedCommand(CONFIG_RUN_VALUE)).toBe(parsed.positionals[0])
    expect(supervisedRun(CONFIG_RUN_VALUE)).toBe(false)
  })
  it.each([
    [['run', '--supervisor=launchd'], true],
    [['run', '--supervisor', 'launchd'], true],
    [['--config', '/tmp/config', '--supervisor', 'launchd', 'run'], true],
    [['--', 'run', '--supervisor', 'launchd'], false],
    [['run', '--', '--supervisor=launchd'], false],
    [['run', '--supervisor=launchd', '--supervisor', 'foo'], false],
    [['run', '--supervisor=launchd', '--supervisor'], false],
    [['run', '--supervisor', ''], false],
    [['run', '--supervisor'], false],
    [['status', '--supervisor=launchd'], false],
    [['--config', 'run', '--supervisor=launchd'], false],
    [['run', '--config', '--supervisor=launchd'], false],
  ])('detects supervised runs from raw argv %j: %s', (argv, expected) => {
    expect(supervisedRun(argv)).toBe(expected)
  })
  it.each([['--config', ''], ['--nope'], ['extra']])(
    'records supervised usage errors %j without restarting',
    async (...options) => {
      machine = fakeMachine()
      for (const supervisor of [['--supervisor', 'launchd'], ['--supervisor=launchd']]) {
        const result = await run(['run', ...supervisor, ...options], { home: machine.home })
        expect(result.code).toBe(0)
        expect(result.stderr).toContain(USAGE)
        expect(JSON.parse(readFileSync(serviceExitPath({}, machine.home), 'utf8'))).toMatchObject({
          code: 64,
        })
        expect(
          readFileSync(join(hostLogDirectory({}, machine.home), 'phosphor.log'), 'utf8'),
        ).toContain('[service] stopped {"code":64}')
      }
    },
  )
  it('runs setup with repeated relative repositories, overrides, replace and JSON', async () => {
    machine = fakeMachine()
    const options = {
      cwd: machine.dir,
      env: { ...machine.hostEnv, PATH: machine.bin },
      home: machine.home,
    }
    const relative = machine.repository.slice(machine.dir.length + 1)
    const node = machine.script(
      'node',
      'if [ "$1" = --version ]; then echo v22.22.3; else echo 0.87.1; fi',
    )
    const argv = [
      'setup',
      '--config',
      machine.configPath,
      '--replace',
      '--pi',
      machine.pi,
      '--node',
      node,
      '--repository',
      relative,
      '--repository',
      relative,
    ]
    const result = await run([...argv, '--json'], options)
    expect(result).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(result.stdout)).toMatchObject({
      next: 'phosphor doctor',
      repositories: [machine.repository],
    })
    const existing = await run(['setup', '--config', machine.configPath], options)
    expect(existing.code).toBe(0)
    expect(existing.stdout).toContain('already set up; rerun with --replace')
  })

  it('prints missing-config setup guidance in both doctor renderers', async () => {
    machine = fakeMachine()
    const missing = join(machine.dir, 'missing.json')
    expect((await run(['doctor', '--config', missing])).stdout).toContain(
      'next: run phosphor setup',
    )
    expect(JSON.parse((await run(['doctor', '--config', missing, '--json'])).stdout).next).toBe(
      'run phosphor setup',
    )
  })

  it('runs doctor against --config, with the report alone on stdout', async () => {
    machine = fakeMachine()
    vi.stubEnv('PI_CODING_AGENT_DIR', machine.agentDir)
    const result = await run(['doctor', '--json', '--config', machine.configPath], {
      env: machine.hostEnv,
      home: machine.home,
    })
    expect(result).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      config: { path: machine.configPath },
    })
  })

  it("runs providers, with the report alone on stdout, or doctor's when pi is unusable", async () => {
    machine = fakeMachine()
    vi.stubEnv('PI_CODING_AGENT_DIR', machine.agentDir)
    const options = { env: machine.hostEnv, home: machine.home }
    const none = await run(['providers', '--json', '--config', machine.configPath], options)
    expect(none).toMatchObject({ code: 69, stderr: '' })
    expect(JSON.parse(none.stdout)).toMatchObject({ ok: false, hostId: 'test-host' })
    machine.signIn('openai-codex')
    const plain = await run(['providers', '--config', machine.configPath], options)
    expect(plain).toMatchObject({ code: 0, stderr: '' })
    expect(plain.stdout).toMatch(/^phosphor providers · test-host\n/)
    const env = { ...machine.hostEnv, PI_FAKE_MODE: 'leak' }
    const unusable = await run(['providers', '--json', '--config', machine.configPath], {
      ...options,
      env,
    })
    expect(unusable.code).toBe(69)
    expect(unusable.stderr).toBe(
      'phosphor: pi is not usable here, so it was not asked about providers\n',
    )
    expect(JSON.parse(unusable.stdout)).toMatchObject({
      ok: false,
      lanes: { native: { reason: 'failed: pi' } },
    })
  })

  it("passes accept's lane, models and transcript choice through, evidence alone on stdout", async () => {
    machine = fakeMachine({ rpc: true })
    machine.installClaude()
    vi.stubEnv('PI_CODING_AGENT_DIR', machine.agentDir)
    vi.stubEnv('PATH', process.env.PATH)
    const argv = ['accept', '--json', '--config', machine.configPath, '--repository']
    const result = await run(
      [
        ...argv,
        machine.repository,
        '--lane',
        'claude',
        '--claude-model',
        'claude-test',
        '--keep-transcripts',
      ],
      {
        env: machine.hostEnv,
        home: machine.home,
      },
    )
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).lanes).toEqual([
      expect.objectContaining({ lane: 'claude', model: 'claude-test', transcriptDeleted: false }),
    ])
  })

  it('signs in on the terminal: steps on stderr, then the providers report on stdout', async () => {
    machine = fakeMachine()
    vi.stubEnv('PI_CODING_AGENT_DIR', machine.agentDir)
    const signIn = machine.signIn.bind(machine)
    const result = await run(['providers', 'login', 'xai', '--config', machine.configPath], {
      env: machine.hostEnv,
      home: machine.home,
      terminal: true,
      runInTerminal: async () => {
        signIn('xai')
        return { code: 0 }
      },
    })
    expect(result.code).toBe(0)
    expect(result.stderr).toMatch(/^Signing in to xAI on test-host\. pi opens next:\n/)
    expect(result.stderr.endsWith('xAI on test-host: signed in.\n')).toBe(true)
    expect(result.stdout).toMatch(/^phosphor providers · test-host\n/)
    expect(result.stdout).toContain('  ok    xAI              signed in (xai)\n')
    const unknown = await run(['providers', 'login', 'nope', '--config', machine.configPath], {
      env: machine.hostEnv,
      home: machine.home,
      terminal: true,
    })
    expect(unknown).toMatchObject({ code: 64, stdout: '' })
    expect(unknown.stderr).toMatch(/^phosphor: unknown provider "nope": one of openai-codex, /)
  })

  // The setup steps end in an accept: the one doctor names must pass as written.
  it.each([
    {
      setup: "pi's default is Claude",
      claude: true,
      settings: { defaultProvider: 'pi-claude-cli' },
      signedIn: ['openai-codex'],
      // The fake pi's stand-in for pi running on its default.
      env: { PI_FAKE_PROVIDER: 'pi-claude-cli' },
      lane: 'claude',
    },
    {
      setup: "pi's default is a signed-in provider, with the claude lane available",
      claude: true,
      settings: { defaultProvider: 'openai-codex' },
      signedIn: ['openai-codex'],
      env: { PI_FAKE_PROVIDER: 'openai-codex' },
      lane: 'native',
    },
    {
      setup: 'pi has no default provider',
      claude: false,
      settings: {},
      signedIn: ['xai'],
      env: {},
      lane: 'native',
      model: 'grok-test',
    },
    {
      setup: "only the claude lane can run, pi's default being signed out",
      claude: true,
      settings: { defaultProvider: 'openai' },
      signedIn: [],
      env: {},
      lane: 'claude',
      model: 'claude-test',
    },
  ])(
    'recommends an accept that passes as written when $setup',
    { timeout: 30_000 },
    async ({ claude, settings, signedIn, env, lane, model }) => {
      machine = fakeMachine({ rpc: true })
      if (claude) machine.installClaude()
      const packages = claude ? { packages: ['npm:@saccolabs/pi-claude-cli'] } : {}
      writeFileSync(
        join(machine.agentDir, 'settings.json'),
        JSON.stringify({ ...packages, ...settings }),
      )
      machine.signIn(...signedIn)
      vi.stubEnv('PI_CODING_AGENT_DIR', machine.agentDir)
      vi.stubEnv('PATH', process.env.PATH)
      const options = { env: { ...machine.hostEnv, ...env }, home: machine.home }
      const config = ['--json', '--config', machine.configPath]
      const doctor = await run(['doctor', ...config], options)
      const next: string = JSON.parse(doctor.stdout).next
      const command = next.slice(next.indexOf('phosphor ') + 'phosphor '.length)
      const argv = command
        .replace(/ \(pi --list-models [^)]+\)$/, '')
        .split(' ')
        .map((word) => (word === 'DIR' ? machine!.repository : word === 'ID' ? model! : word))
      expect(argv.includes('ID') || argv.includes('DIR')).toBe(false)
      expect(argv.slice(0, 4)).toEqual(['accept', '--repository', machine.repository, '--lane'])
      expect(argv[4]).toBe(lane)
      expect(next.includes(' ID ')).toBe(model !== undefined)
      const result = await run([...argv, ...config], options)
      expect(result.code, `${next}\n${result.stderr}`).toBe(0)
      expect(JSON.parse(result.stdout).lanes).toEqual([
        expect.objectContaining({ lane, verdict: 'pass' }),
      ])
    },
  )

  it('looks for the config in the XDG folder by default', async () => {
    const result = await run(['doctor'], { env: { XDG_CONFIG_HOME: '/nonexistent/xdg' } })
    expect(result.code).toBe(78)
    expect(result.stdout).toContain('/nonexistent/xdg/phosphor-host/config.json')
  })
})

describe('control commands', () => {
  it('places identity beside the default XDG config file', async () => {
    const control = await controlMachine()
    try {
      const parent = join(control.root, 'phosphor-host')
      mkdirSync(parent, { mode: 0o700 })
      writeFileSync(join(parent, 'config.json'), JSON.stringify(control.config), { mode: 0o600 })
      const outcome = await run(['login'], {
        env: { XDG_CONFIG_HOME: control.root },
        control: { ...control.context, store: undefined },
      })
      expect(outcome.code).toBe(0)
      expect(JSON.parse(readFileSync(join(parent, 'identity', 'host.json'), 'utf8')).label).toBe(
        'bee1',
      )
      expect(await control.store.load()).toBeNull()
    } finally {
      await control.cleanup()
    }
  })
  it('routes login without a TTY, status --json and logout --local, with no headers on output', async () => {
    const control = await controlMachine()
    try {
      const options = { control: control.context, terminal: false }
      const login = await run(['login', '--config', control.configPath], options)
      expect(login.code).toBe(0)
      expect(login.stdout).toContain('BCDF-GHJK')
      expect(login.stderr).toBe('')
      const status = await run(['status', '--config', control.configPath, '--json'], options)
      expect(status.code).toBe(0)
      expect(JSON.parse(status.stdout)).toMatchObject({ version: 1, status: 'confirmed' })
      const logout = await run(['logout', '--config', control.configPath, '--local'], options)
      expect(logout.code).toBe(0)
      expect(logout.stdout).toContain('Forgot this machine locally')
      expect(login.stdout + status.stdout + logout.stdout).not.toMatch(
        /PRIVATE KEY|signature|x-phosphor-/,
      )
    } finally {
      await control.cleanup()
    }
  })
  it('attaches cancellation to the existing shutdown', async () => {
    const control = await controlMachine()
    try {
      let target: Drainable | undefined
      let draining: Promise<{ state: 'stopped' | 'failed' }> | undefined
      control.onWait(() => {
        draining = target?.drain('SIGINT')
      })
      const outcome = await run(['login', '--config', control.configPath], {
        control: control.context,
        attach: (value) => {
          target = value
          return () => {
            target = undefined
          }
        },
      })
      expect(outcome.code).toBe(130)
      expect(await draining).toEqual({ state: 'stopped' })
      expect(target).toBeUndefined()
      expect(await control.store.load()).toBeNull()
      const notEnrolled = await run(['status', '--json'], {
        env: { XDG_CONFIG_HOME: '/nonexistent/xdg' },
      })
      expect(notEnrolled.code).toBe(78)
      expect(JSON.parse(notEnrolled.stdout).status).toBe('invalid')
    } finally {
      await control.cleanup()
    }
  })
})

describe('tailscale CLI dispatch', () => {
  it.each(['status', 'enable', 'disable'])(
    'dispatches %s with config and probe port',
    async (action) => {
      machine = fakeMachine()
      const result = await run(['tailscale', action, '--config', machine.configPath], {
        tailscale: { which: async () => null, probe: vi.fn() },
      })
      expect(result.code).toBe(69)
      expect(result.stdout).toContain('Tailscale is missing')
      expect(result.stderr).toBe('')
    },
  )
})
