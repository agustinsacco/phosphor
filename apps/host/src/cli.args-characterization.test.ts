import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Accept from './commands/accept'
import type * as Doctor from './commands/doctor'
import type * as GuidedSetup from './commands/guided-setup'
import type * as Login from './commands/login'
import type * as Logout from './commands/logout'
import type * as ProviderLogin from './commands/provider-login'
import type * as Providers from './commands/providers'
import type * as Run from './commands/run'
import type * as Service from './commands/service'
import type * as Setup from './commands/setup'
import type * as Status from './commands/status'
import type * as Tailscale from './commands/tailscale'
import type * as Uninstall from './commands/uninstall'
import type * as Update from './commands/update'
import type * as ShellPath from './machine/shell-path'
import { serviceExitPath } from './machine/launchd'
import { hostLogDirectory } from './machine/log'
import { CLI_PARSE_CONFIG, runCli, USAGE, type CliContext } from './cli'

// Pins the public runCli argument contract: what is refused, with which exact
// text and exit code, and that a refusal never reaches a command.
const actions = vi.hoisted(() => {
  const calls: { name: string; args: unknown[] }[] = []
  const record =
    (name: string, result: unknown) =>
    (...args: unknown[]) => {
      calls.push({ name, args })
      return Promise.resolve(result)
    }
  return { calls, record }
})
vi.mock('./commands/doctor', async (original) => ({
  ...(await original<typeof Doctor>()),
  runDoctor: actions.record('doctor', { exitCode: 0 }),
  renderDoctor: () => 'doctor report\n',
}))
vi.mock('./commands/setup', async (original) => ({
  ...(await original<typeof Setup>()),
  runSetup: actions.record('setup', { exitCode: 0 }),
  renderSetup: () => 'setup report\n',
}))
vi.mock('./commands/guided-setup', async (original) => ({
  ...(await original<typeof GuidedSetup>()),
  runGuidedSetup: actions.record('guided-setup', { exitCode: 0 }),
}))
vi.mock('./commands/providers', async (original) => ({
  ...(await original<typeof Providers>()),
  runProviders: actions.record('providers', { report: { exitCode: 0 } }),
  renderProviders: () => 'providers report\n',
}))
vi.mock('./commands/provider-login', async (original) => ({
  ...(await original<typeof ProviderLogin>()),
  runProviderLogin: actions.record('provider-login', { exitCode: 0, after: { report: {} } }),
}))
vi.mock('./commands/accept', async (original) => ({
  ...(await original<typeof Accept>()),
  runAccept: actions.record('accept', { exitCode: 0, evidence: {} }),
  renderAccept: () => 'accept report\n',
}))
vi.mock('./commands/run', async (original) => ({
  ...(await original<typeof Run>()),
  runHost: actions.record('run', 0),
}))
vi.mock('./commands/service', async (original) => ({
  ...(await original<typeof Service>()),
  runService: actions.record('service', 0),
}))
vi.mock('./commands/login', async (original) => ({
  ...(await original<typeof Login>()),
  runLogin: actions.record('login', { exitCode: 0, message: 'login done' }),
}))
vi.mock('./commands/logout', async (original) => ({
  ...(await original<typeof Logout>()),
  runLogout: actions.record('logout', { exitCode: 0, message: 'logout done' }),
}))
vi.mock('./commands/status', async (original) => ({
  ...(await original<typeof Status>()),
  runStatus: actions.record('status', { exitCode: 0, report: { status: 'confirmed' } }),
}))
vi.mock('./commands/update', async (original) => ({
  ...(await original<typeof Update>()),
  runUpdate: actions.record('update', 0),
}))
vi.mock('./commands/uninstall', async (original) => ({
  ...(await original<typeof Uninstall>()),
  runUninstall: actions.record('uninstall', 0),
}))
vi.mock('./commands/tailscale', async (original) => ({
  ...(await original<typeof Tailscale>()),
  runTailscale: actions.record('tailscale', { exitCode: 0, message: 'tailscale done' }),
}))
vi.mock('./machine/shell-path', async (original) => ({
  ...(await original<typeof ShellPath>()),
  installHostPath: (...args: unknown[]) => void actions.calls.push({ name: 'install-path', args }),
}))

const NOW = Date.UTC(2026, 0, 2, 3, 4, 5)
let home: string
beforeEach(() => {
  actions.calls.length = 0
  home = mkdtempSync(join(tmpdir(), 'phosphor-cli-args-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

async function cli(argv: readonly string[], context: Partial<CliContext> = {}) {
  const out = { stdout: '', stderr: '' }
  const code = await runCli(
    argv,
    { stdout: (text) => (out.stdout += text), stderr: (text) => (out.stderr += text) },
    {
      env: {},
      platform: 'linux',
      uid: process.getuid?.(),
      home,
      hostname: 'bee1',
      nodeVersion: '22.22.3',
      defaultResourceRoot: '/nonexistent',
      control: { now: () => NOW },
      ...context,
    },
  )
  return { code, ...out }
}

const refusal = (problem: string) => ({
  code: 64,
  stdout: '',
  stderr: `phosphor: ${problem}\n\n${USAGE}`,
})

function parserProblem(argv: readonly string[]): string {
  try {
    parseArgs({ ...CLI_PARSE_CONFIG, args: [...argv] })
  } catch (error) {
    return (error as Error).message
  }
  throw new Error(`parseArgs accepted ${JSON.stringify(argv)}`)
}

const HELP: string[][] = [
  ['help'],
  ['--help'],
  ['-h'],
  ['help', 'extra', 'more'],
  ['help', '--json'],
  ['-h', 'run'],
  ['serve', '--help'],
  ['doctor', '--replace', '-h'],
  ['doctor', 'extra', '--help'],
  ['providers', 'login', '-h'],
  ['tailscale', '--help'],
  ['service', 'bogus', '--help'],
  ['run', '--supervisor', 'systemd', '--help'],
  ['accept', '--help'],
  ['update', '--rollback', '--check', '--help'],
  ['uninstall', '--purge', '-h'],
]

const REFUSED: [string[], string][] = [
  [[], 'no command given'],
  [['--json'], 'no command given'],
  [['--version', 'doctor'], 'no command given'],
  [['--config', 'run'], 'no command given'],
  [['serve'], 'unknown command "serve"'],
  [['serve', '--json', 'extra'], 'unknown command "serve"'],
  [['Doctor'], 'unknown command "Doctor"'],
  [
    ['providers', 'login'],
    'providers login needs a provider: an id phosphor providers lists, or claude',
  ],
  [
    ['providers', 'login', '--json'],
    'providers login needs a provider: an id phosphor providers lists, or claude',
  ],
  [['providers', 'login', 'xai', 'extra'], 'unexpected argument "extra"'],
  [['providers', 'login', 'xai', '--json'], 'providers login does not take --json'],
  [
    ['providers', 'login', 'xai'],
    'providers login needs a terminal: over SSH, run ssh -t HOST phosphor ...',
  ],
  [['providers', 'status'], 'unexpected argument "status"'],
  [['providers', '--repository', '/repo'], 'providers does not take --repository'],
  [['service'], 'service needs install, status, restart, logs or uninstall'],
  [['service', 'bogus', '--json'], 'service needs install, status, restart, logs or uninstall'],
  [['service', 'status', '--follow'], '--follow is only for service logs'],
  [['service', 'install', '--follow', 'extra'], '--follow is only for service logs'],
  [['service', 'logs', '--follow', 'extra'], 'unexpected argument "extra"'],
  [['service', 'status', 'extra', '--json'], 'unexpected argument "extra"'],
  [['service', 'status', '--json'], 'service does not take --json'],
  [['tailscale'], 'tailscale needs status, enable or disable'],
  [['tailscale', 'funnel'], 'tailscale needs status, enable or disable'],
  [['tailscale', 'status', 'extra'], 'unexpected argument "extra"'],
  [['tailscale', 'status', '--json'], 'tailscale does not take --json'],
  [['doctor', 'extra', '--replace'], 'unexpected argument "extra"'],
  [['doctor', '--', '--json'], 'unexpected argument "--json"'],
  [['--', 'run', '--supervisor', 'launchd'], 'unexpected argument "--supervisor"'],
  [['doctor', '--replace'], 'doctor does not take --replace'],
  [['doctor', '--lane', 'bogus'], 'doctor does not take --lane'],
  [['doctor', '--follow', '--local'], 'doctor does not take --follow'],
  [['version', '--config', '/x.json'], 'version does not take --config'],
  [['version', '--version', '1.2.3'], 'version does not take --version'],
  [['version', 'extra'], 'unexpected argument "extra"'],
  [['internal-install-path', '/tmp/elsewhere'], 'unexpected argument "/tmp/elsewhere"'],
  [['internal-install-path', '--json'], 'internal-install-path does not take --json'],
  [['status', '--supervisor', 'launchd'], 'status does not take --supervisor'],
  [['run', '--supervisor', 'systemd', '--config', ''], '--supervisor is launchd'],
  [['run', '--supervisor', ''], '--supervisor is launchd'],
  [['run', '--supervisor=launchd', '--supervisor', 'foo'], '--supervisor is launchd'],
  [['doctor', '--config', ''], '--config needs a file'],
  [['doctor', '--config='], '--config needs a file'],
  [['accept', '--config', '', '--lane', 'both'], '--config needs a file'],
  [['accept', '--lane', 'both'], '--lane is native, claude or all'],
  [['accept', '--repository', 'repo', '--lane', 'both'], '--lane is native, claude or all'],
  [['accept', '--repository', '/a', '--repository', 'b'], '--repository may only repeat for setup'],
  [['accept'], 'accept needs --repository DIR'],
  [['accept', '--lane', 'native'], 'accept needs --repository DIR'],
  [['accept', '--repository', ''], 'accept needs --repository DIR'],
  [['accept', '--repository', 'repo'], '--repository needs an absolute path'],
  [
    ['setup', '--repository', '/a', '--repository', ''],
    '--repository, --pi and --node need a path',
  ],
  [['setup', '--pi', ''], '--repository, --pi and --node need a path'],
  [['setup', '--node', ''], '--repository, --pi and --node need a path'],
  [['update', '--version', '../x'], 'invalid update options'],
  [['update', '--version', '01.2.3'], 'invalid update options'],
  [['update', '--rollback', '--check'], 'invalid update options'],
  [['update', '--rollback', '--version', '1.2.3'], 'invalid update options'],
  [['update', '--local'], 'update does not take --local'],
  [['uninstall', '--purge'], '--purge and --yes are both required'],
  [['uninstall', '--yes', '--json'], '--purge and --yes are both required'],
  [['uninstall', '--version', '1.2.3'], 'uninstall does not take --version'],
]

const PARSER_REFUSED: string[][] = [
  ['doctor', '--nope'],
  ['doctor', '--nope', '--help'],
  ['-v', 'doctor'],
  ['doctor', '--config'],
  ['doctor', '--json=yes'],
  ['--help=yes'],
  ['run', '--supervisor'],
  ['run', '--supervisor=launchd', '--supervisor'],
  ['run', '--config', '--supervisor=launchd'],
  ['accept', '-x'],
]

describe('runCli argument contract', () => {
  it.each(HELP)('prints usage alone for %j before any other check', async (...argv) => {
    expect(await cli(argv)).toEqual({ code: 0, stdout: USAGE, stderr: '' })
    expect(actions.calls).toEqual([])
  })

  it.each([['--version'], ['-v'], ['version']])('prints the version for %j', async (...argv) => {
    expect(await cli(argv)).toEqual({ code: 0, stdout: 'phosphor 0.0.0-dev.source\n', stderr: '' })
  })

  it.each([
    ['version', '--json'],
    ['--json', 'version'],
    ['version', '--json', '--json'],
  ])('prints the version as JSON for %j', async (...argv) => {
    const result = await cli(argv)
    expect(result).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(result.stdout)).toEqual({
      hostVersion: '0.0.0-dev.source',
      protocolVersion: 1,
      sourceSha: null,
      node: '22.22.3',
    })
  })

  it.each(REFUSED)('refuses %j: %s', async (argv, problem) => {
    expect(await cli(argv)).toEqual(refusal(problem))
    expect(actions.calls).toEqual([])
  })

  it.each(PARSER_REFUSED)('refuses %j with the parser message', async (...argv) => {
    expect(await cli(argv)).toEqual(refusal(parserProblem(argv)))
    expect(actions.calls).toEqual([])
  })

  it('refuses providers login without a terminal and hands it the terminal with one', async () => {
    const problem = 'providers login needs a terminal: over SSH, run ssh -t HOST phosphor ...'
    const argv = ['providers', 'login', 'xai', '--config', '/c.json']
    expect(await cli(argv, { terminal: false })).toEqual(refusal(problem))
    expect(actions.calls).toEqual([])
    const runInTerminal = async () => ({ code: 0 })
    expect(await cli(argv, { terminal: true, runInTerminal })).toEqual({
      code: 0,
      stdout: 'providers report\n',
      stderr: '',
    })
    expect(actions.calls.map(({ name }) => name)).toEqual(['provider-login'])
    expect(actions.calls[0]!.args[0]).toMatchObject({
      configPath: '/c.json',
      provider: 'xai',
      run: runInTerminal,
    })
  })
})

describe('runCli option permutations', () => {
  const defaultConfig = () => join(home, '.config', 'phosphor-host', 'config.json')

  it.each([
    [['doctor'], () => defaultConfig()],
    [['--', 'doctor'], () => defaultConfig()],
    [['--config', '/c.json', 'doctor'], () => '/c.json'],
    [['doctor', '--config=/c.json'], () => '/c.json'],
    [['--config=/c.json', '--json', 'doctor'], () => '/c.json'],
    [['doctor', '--config', '/a.json', '--config', '/b.json'], () => '/b.json'],
    [['--config', 'run', 'doctor'], () => 'run'],
    [['doctor', '--json', '--json', '--config', '/c.json'], () => '/c.json'],
  ])('runs doctor once for %j', async (argv, configPath) => {
    const result = await cli(argv)
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(actions.calls.map(({ name }) => name)).toEqual(['doctor'])
    expect(actions.calls[0]!.args[0]).toMatchObject({ configPath: configPath() })
  })

  it('takes the XDG config folder when no --config is given', async () => {
    await cli(['doctor', '--json'], { env: { XDG_CONFIG_HOME: '/xdg' } })
    expect(actions.calls[0]!.args[0]).toMatchObject({
      configPath: '/xdg/phosphor-host/config.json',
    })
  })

  it('keeps repeated, relative setup repositories in order', async () => {
    const argv = ['setup', '--repository', 'a', '--json', '--repository', '/b', '--replace']
    const result = await cli(argv, { cwd: '/work' })
    expect(result.code).toBe(0)
    expect(actions.calls.map(({ name }) => name)).toEqual(['setup'])
    expect(actions.calls[0]!.args[0]).toMatchObject({
      cwd: '/work',
      repositories: ['a', '/b'],
      replace: true,
    })
  })

  it.each([
    [['accept', '--repository', '/r'], 'all'],
    [['accept', '--lane', 'claude', '--repository=/r'], 'claude'],
    [['accept', '--repository', '/r', '--lane', 'native', '--lane', 'all'], 'all'],
  ])('passes accept %j with lane %s', async (argv, lane) => {
    expect((await cli(argv)).code).toBe(0)
    expect(actions.calls.map(({ name }) => name)).toEqual(['accept'])
    expect(actions.calls[0]!.args[0]).toMatchObject({ repository: '/r', lane })
  })

  it.each([
    [['run'], undefined],
    [['run', '--supervisor', 'launchd'], 'launchd'],
    [['--supervisor=launchd', '--config', '/c.json', 'run'], 'launchd'],
  ])('runs the Host once for %j with supervisor %s', async (argv, supervisor) => {
    expect((await cli(argv)).code).toBe(0)
    expect(actions.calls.map(({ name }) => name)).toEqual(['run'])
    expect(actions.calls[0]!.args[0]).toMatchObject({ supervisor })
  })

  it.each([
    [['service', 'logs', '--follow'], 'logs', true],
    [['service', '--follow', 'logs'], 'logs', true],
    [['service', 'restart'], 'restart', undefined],
  ])('runs service %j as %s', async (argv, action, follow) => {
    expect((await cli(argv)).code).toBe(0)
    expect(actions.calls.map(({ name }) => name)).toEqual(['service'])
    expect(actions.calls[0]!.args.slice(1)).toEqual([action, follow])
  })

  it.each([
    [['update', '--version', '1.2.3', '--check'], 'update'],
    [['update', '--rollback'], 'update'],
    [['uninstall', '--purge', '--yes'], 'uninstall'],
    [['internal-install-path'], 'install-path'],
    [['tailscale', 'enable'], 'tailscale'],
    [['logout', '--local'], 'logout'],
  ])('accepts %j', async (argv, name) => {
    expect((await cli(argv)).code).toBe(0)
    expect(actions.calls.map((call) => call.name)).toEqual([name])
  })
})

describe('runCli supervised usage errors', () => {
  const exitRecord = () => serviceExitPath({}, home)
  const logText = () => readFileSync(join(hostLogDirectory({}, home), 'phosphor.log'), 'utf8')

  it.each([
    ['run', '--supervisor', 'launchd', '--nope'],
    ['run', '--supervisor=launchd', 'extra'],
    ['--config', '/c.json', '--supervisor', 'launchd', 'run', '--json'],
    ['run', '--supervisor', 'launchd', '--config', ''],
  ])('records a permanent usage exit for launchd %j and exits 0', async (...argv) => {
    const result = await cli(argv)
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr.startsWith('phosphor: ')).toBe(true)
    expect(result.stderr.endsWith(`\n\n${USAGE}`)).toBe(true)
    expect(JSON.parse(readFileSync(exitRecord(), 'utf8'))).toEqual({
      code: 64,
      at: new Date(NOW).toISOString(),
    })
    expect(logText()).toContain('[service] stopped {"code":64}')
    expect(actions.calls).toEqual([])
  })

  it.each([
    ['--config', 'run', '--supervisor=launchd'],
    ['--', 'run', '--supervisor', 'launchd'],
    ['run', '--', '--supervisor=launchd'],
    ['run', '--supervisor=launchd', '--supervisor', 'foo'],
    ['run', '--supervisor=launchd', '--supervisor'],
    ['status', '--supervisor=launchd'],
    ['run', '--config', '--supervisor=launchd'],
    ['run', '--nope'],
  ])('keeps exit 64 and records nothing for unsupervised %j', async (...argv) => {
    const result = await cli(argv)
    expect(result.code).toBe(64)
    expect(result.stdout).toBe('')
    expect(result.stderr.endsWith(`\n\n${USAGE}`)).toBe(true)
    expect(existsSync(exitRecord())).toBe(false)
    expect(existsSync(hostLogDirectory({}, home))).toBe(false)
    expect(actions.calls).toEqual([])
  })

  it('exits 75 when the usage exit cannot be recorded', async () => {
    const file = join(home, 'not-a-folder')
    writeFileSync(file, '')
    const result = await cli(['run', '--supervisor', 'launchd', '--nope'], { home: file })
    expect(result.code).toBe(75)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(
      `phosphor: ${parserProblem(['run', '--supervisor', 'launchd', '--nope'])}\n\n${USAGE}` +
        'The service command could not finish.\n',
    )
    expect(actions.calls).toEqual([])
  })
})
