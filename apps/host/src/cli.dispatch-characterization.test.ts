import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import type * as Identity from './control/identity'
import type * as HostLog from './machine/log'
import type * as ShellPath from './machine/shell-path'
import { identityDirectory } from './control/identity'
import { hostLogDirectory } from './machine/log'
import type { Drainable } from './shutdown'
import { runCli, type CliContext } from './cli'

// Pins what runCli hands each command and prints from it, through the public
// entry, with every command replaced: one call, the same context, the same
// exit code and output, and which wrappers attach to the shutdown.
const h = vi.hoisted(() => {
  const calls: { name: string; args: unknown[] }[] = []
  const effects = new Map<string, (...args: unknown[]) => unknown>()
  const action =
    (name: string, fallback: unknown) =>
    async (...args: unknown[]) => {
      calls.push({ name, args })
      const effect = effects.get(name)
      return effect ? effect(...args) : fallback
    }
  const render = (name: string) => (report: unknown) => `${name} ${JSON.stringify(report)}\n`
  const log = { write: () => {}, hide: (text: string) => text, path: () => null }
  return {
    calls,
    effects,
    action,
    render,
    log,
    identity: { load: async (): Promise<unknown> => null },
  }
})
vi.mock('./commands/doctor', async (original) => ({
  ...(await original<typeof Doctor>()),
  runDoctor: h.action('doctor', { exitCode: 0, ok: true }),
  renderDoctor: h.render('doctor'),
}))
vi.mock('./commands/setup', async (original) => ({
  ...(await original<typeof Setup>()),
  runSetup: h.action('setup', { exitCode: 0 }),
  renderSetup: h.render('setup'),
}))
vi.mock('./commands/guided-setup', async (original) => ({
  ...(await original<typeof GuidedSetup>()),
  runGuidedSetup: h.action('guided-setup', { exitCode: 0 }),
}))
vi.mock('./commands/providers', async (original) => ({
  ...(await original<typeof Providers>()),
  runProviders: h.action('providers', { report: { exitCode: 0 } }),
  renderProviders: h.render('providers'),
}))
vi.mock('./commands/provider-login', async (original) => ({
  ...(await original<typeof ProviderLogin>()),
  runProviderLogin: h.action('provider-login', { exitCode: 0, after: { report: { p: 1 } } }),
}))
vi.mock('./commands/accept', async (original) => ({
  ...(await original<typeof Accept>()),
  runAccept: h.action('accept', { exitCode: 0, evidence: { e: 1 } }),
  renderAccept: h.render('accept'),
}))
vi.mock('./commands/run', async (original) => ({
  ...(await original<typeof Run>()),
  runHost: h.action('run', 0),
}))
vi.mock('./commands/service', async (original) => ({
  ...(await original<typeof Service>()),
  runService: h.action('service', 0),
}))
vi.mock('./commands/login', async (original) => ({
  ...(await original<typeof Login>()),
  runLogin: h.action('login', { exitCode: 0, message: 'logged in' }),
}))
vi.mock('./commands/logout', async (original) => ({
  ...(await original<typeof Logout>()),
  runLogout: h.action('logout', { exitCode: 0, message: 'logged out' }),
}))
vi.mock('./commands/status', async (original) => ({
  ...(await original<typeof Status>()),
  runStatus: h.action('status', { exitCode: 0, report: { status: 'confirmed' } }),
  renderStatus: h.render('status'),
}))
vi.mock('./commands/update', async (original) => ({
  ...(await original<typeof Update>()),
  runUpdate: h.action('update', 0),
}))
vi.mock('./commands/uninstall', async (original) => ({
  ...(await original<typeof Uninstall>()),
  runUninstall: h.action('uninstall', 0),
}))
vi.mock('./commands/tailscale', async (original) => ({
  ...(await original<typeof Tailscale>()),
  runTailscale: h.action('tailscale', { exitCode: 0, message: 'tailnet' }),
}))
vi.mock('./machine/shell-path', async (original) => ({
  ...(await original<typeof ShellPath>()),
  installHostPath: (...args: unknown[]) => {
    h.calls.push({ name: 'install-path', args })
    const effect = h.effects.get('install-path')
    if (effect) effect(...args)
  },
}))
vi.mock('./machine/log', async (original) => ({
  ...(await original<typeof HostLog>()),
  createHostLog: (...args: unknown[]) => {
    h.calls.push({ name: 'host-log', args })
    return h.log
  },
}))
vi.mock('./control/identity', async (original) => ({
  ...(await original<typeof Identity>()),
  createIdentityStore: (...args: unknown[]) => {
    h.calls.push({ name: 'identity', args })
    return { load: () => h.identity.load() }
  },
}))

let home: string
let targets: Drainable[]
let detached: number
let context: CliContext
const fetch = vi.fn()
const runInTerminal = vi.fn(async () => ({ code: 0 }))
const tailscale = { which: vi.fn(async () => null), probe: vi.fn() }
beforeEach(() => {
  h.calls.length = 0
  h.effects.clear()
  h.identity.load = async () => null
  home = mkdtempSync(join(tmpdir(), 'phosphor-cli-dispatch-'))
  targets = []
  detached = 0
  context = {
    env: { TOKEN: 'secret-value-1234', SHORT: 'abc' },
    platform: 'linux',
    uid: 501,
    home,
    hostname: 'bee1',
    nodeVersion: '22.22.3',
    defaultResourceRoot: '/resources',
    cwd: '/work',
    terminal: false,
    runInTerminal,
    tailscale,
    attach: (target) => {
      targets.push(target)
      return () => void detached++
    },
    control: { fetch, now: () => 5 },
  }
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

async function cli(argv: readonly string[], overrides: Partial<CliContext> = {}) {
  const out = { stdout: '', stderr: '' }
  const code = await runCli(
    argv,
    { stdout: (text) => (out.stdout += text), stderr: (text) => (out.stderr += text) },
    { ...context, ...overrides },
  )
  return { code, ...out }
}
const names = () => h.calls.map(({ name }) => name)
const argsOf = (name: string) => h.calls.findLast((call) => call.name === name)!.args
const CONFIG = '/etc/phosphor/config.json'
const DEFAULT_CONFIG = () => join(home, '.config', 'phosphor-host', 'config.json')
const SECRETS = ['secret-value-1234']

describe('runCli report commands', () => {
  it('prints the version plain or as JSON without dispatching', async () => {
    expect(await cli(['version'])).toEqual({
      code: 0,
      stdout: 'phosphor 0.0.0-dev.source\n',
      stderr: '',
    })
    expect(JSON.parse((await cli(['version', '--json'])).stdout)).toEqual({
      hostVersion: '0.0.0-dev.source',
      protocolVersion: 1,
      sourceSha: null,
      node: '22.22.3',
    })
    expect(names()).toEqual([])
  })

  it('installs the shell path with the context and a stdout printer', async () => {
    h.effects.set('install-path', (options) =>
      (options as { print(line: string): void }).print('added'),
    )
    expect(await cli(['internal-install-path'])).toEqual({ code: 0, stdout: 'added\n', stderr: '' })
    expect(names()).toEqual(['install-path'])
    expect(argsOf('install-path')).toEqual([{ ...context, print: expect.any(Function) }])
  })

  it.each([
    [[], 'doctor {"exitCode":69,"ok":false}\n'],
    [['--json'], `${JSON.stringify({ exitCode: 69, ok: false }, null, 2)}\n`],
  ])('runs doctor %j once with the config path', async (flags, stdout) => {
    h.effects.set('doctor', async () => ({ exitCode: 69, ok: false }))
    expect(await cli(['doctor', ...flags])).toEqual({ code: 69, stdout, stderr: '' })
    expect(names()).toEqual(['doctor'])
    expect(argsOf('doctor')).toEqual([{ ...context, configPath: DEFAULT_CONFIG() }])
  })

  it.each([
    [[], 'providers {"exitCode":0,"r":1}\n'],
    [['--json'], `${JSON.stringify({ exitCode: 0, r: 1 }, null, 2)}\n`],
  ])('prints the providers report %j with its exit code', async (flags, stdout) => {
    h.effects.set('providers', async () => ({ exitCode: 69, report: { exitCode: 0, r: 1 } }))
    expect(await cli(['providers', '--config', CONFIG, ...flags])).toEqual({
      code: 0,
      stdout,
      stderr: '',
    })
    expect(argsOf('providers')).toEqual([{ ...context, configPath: CONFIG }])
  })

  it.each([
    [[], 'doctor {"d":1}\n'],
    [['--json'], `${JSON.stringify({ d: 1 }, null, 2)}\n`],
  ])("prints doctor's report %j when pi cannot be asked about providers", async (flags, stdout) => {
    h.effects.set('providers', async () => ({ exitCode: 69, problem: 'no pi', doctor: { d: 1 } }))
    expect(await cli(['providers', ...flags])).toEqual({
      code: 69,
      stdout,
      stderr: 'phosphor: no pi\n',
    })
    expect(names()).toEqual(['providers'])
  })

  it('hands providers login the provider, the terminal and a stderr progress line', async () => {
    h.effects.set('provider-login', async (options) => {
      ;(options as { progress(line: string): void }).progress('step')
      return { exitCode: 0, after: { report: { p: 2 } } }
    })
    const argv = ['providers', 'login', 'xai', '--config', CONFIG]
    expect(await cli(argv, { terminal: true })).toEqual({
      code: 0,
      stdout: 'providers {"p":2}\n',
      stderr: 'step\n',
    })
    expect(names()).toEqual(['provider-login'])
    expect(argsOf('provider-login')).toEqual([
      {
        ...context,
        terminal: true,
        configPath: CONFIG,
        provider: 'xai',
        progress: expect.any(Function),
        run: runInTerminal,
      },
    ])
  })

  it.each([
    [{ exitCode: 64, problem: 'unknown provider' }, '', 64],
    [{ exitCode: 69, problem: 'no pi', doctor: { d: 1 } }, 'doctor {"d":1}\n', 69],
    [{ exitCode: 1, after: { exitCode: 1, problem: 'not signed in' } }, '', 1],
    [{ exitCode: 1, after: { problem: 'gone', doctor: { d: 2 } } }, 'doctor {"d":2}\n', 1],
  ])('reports a failed providers login %j', async (outcome, stdout, code) => {
    h.effects.set('provider-login', async () => outcome)
    const problem = 'problem' in outcome ? outcome.problem : outcome.after.problem
    expect(await cli(['providers', 'login', 'claude'], { terminal: true })).toEqual({
      code,
      stdout,
      stderr: `phosphor: ${problem}\n`,
    })
  })
})

describe('runCli accept', () => {
  const argv = ['accept', '--repository', '/repo', '--lane', 'claude', '--keep-transcripts']
  const models = ['--provider', 'xai', '--model', 'grok', '--claude-model', 'opus']

  it('passes the lane, models and transcript choice, progress on stderr', async () => {
    h.effects.set('accept', async (options) => {
      ;(options as { progress(line: string): void }).progress('lane claude')
      return { exitCode: 1, evidence: { e: 2 } }
    })
    expect(await cli([...argv, ...models])).toEqual({
      code: 1,
      stdout: 'accept {"e":2}\n',
      stderr: 'lane claude\n',
    })
    expect(names()).toEqual(['accept'])
    expect(argsOf('accept')).toEqual([
      {
        ...context,
        configPath: DEFAULT_CONFIG(),
        repository: '/repo',
        lane: 'claude',
        keepTranscripts: true,
        provider: 'xai',
        claudeModel: 'opus',
        model: 'grok',
        progress: expect.any(Function),
      },
    ])
  })

  it('defaults to every lane and no kept transcripts', async () => {
    await cli(['accept', '--repository', '/repo'])
    expect(argsOf('accept')[0]).toMatchObject({
      lane: 'all',
      keepTranscripts: false,
      provider: undefined,
      claudeModel: undefined,
      model: undefined,
    })
  })

  it.each([
    [[], { exitCode: 69, problem: 'p', doctor: { d: 1 } }, 'doctor {"d":1}\n'],
    [['--json'], { exitCode: 69, problem: 'p', doctor: { d: 1 } }, '{\n  "d": 1\n}\n'],
    [['--json'], { exitCode: 78, problem: 'p' }, ''],
    [['--json'], { exitCode: 0, evidence: { e: 1 } }, '{\n  "e": 1\n}\n'],
  ])('prints accept %j outcome %j', async (flags, outcome, stdout) => {
    h.effects.set('accept', async () => outcome)
    const result = await cli(['accept', '--repository', '/repo', ...flags])
    expect(result).toEqual({
      code: outcome.exitCode,
      stdout,
      stderr: 'problem' in outcome ? 'phosphor: p\n' : '',
    })
  })
})

describe('runCli install and tailscale commands', () => {
  it.each(['status', 'enable', 'disable'])('dispatches tailscale %s', async (action) => {
    h.effects.set('tailscale', async () => ({ exitCode: 69, message: 'Tailscale is missing' }))
    expect(await cli(['tailscale', action, '--config', CONFIG])).toEqual({
      code: 69,
      stdout: 'Tailscale is missing\n',
      stderr: '',
    })
    expect(names()).toEqual(['tailscale'])
    expect(argsOf('tailscale')).toEqual([{ ...context, configPath: CONFIG }, action, tailscale])
  })

  it.each([
    [['update', '--check'], 'update', [{ check: true }]],
    [['update', '--version', '1.2.3', '--json'], 'update', [{ version: '1.2.3', json: true }]],
    [['uninstall'], 'uninstall', [undefined, undefined]],
    [['uninstall', '--purge', '--yes', '--json'], 'uninstall', [true, true]],
  ])('dispatches %j with the control ports, messages capped at 256', async (argv, name, rest) => {
    h.effects.set(name, async (options) => {
      const { print } = options as { print(line: string): void }
      for (let index = 0; index < 300; index++) print(`m${index}`)
      return 75
    })
    const json = argv.includes('--json')
    const messages = Array.from({ length: 256 }, (_, index) => `m${index}`)
    expect(await cli(argv)).toEqual({
      code: 75,
      stdout: json ? `${JSON.stringify({ exitCode: 75, messages })}\n` : `${messages.join('\n')}\n`,
      stderr: '',
    })
    expect(names()).toEqual([name])
    const install = {
      ...context,
      json: json || undefined,
      ...context.control,
      configPath: DEFAULT_CONFIG(),
      print: expect.any(Function),
    }
    expect(argsOf(name)).toEqual([install, ...rest])
  })

  it('prints an empty line when an install command prints nothing', async () => {
    expect(await cli(['update'])).toEqual({ code: 0, stdout: '\n', stderr: '' })
  })
})

describe('runCli setup', () => {
  const flags = ['--repository', 'a', '--repository', '/b', '--pi', '/pi', '--node', '/node']

  it.each([
    [async () => null, 0, 'phosphor login'],
    [async () => ({ id: 'host' }), 0, undefined],
    [async () => Promise.reject(new Error('locked')), 0, 'phosphor login'],
    [async () => null, 69, undefined],
  ])('runs non-terminal setup config-only (identity %#)', async (load, exitCode, next) => {
    h.identity.load = load
    h.effects.set('setup', async () => ({ exitCode }))
    const result = await cli(['setup', '--config', CONFIG, ...flags, '--replace'])
    const report = next ? { exitCode, next } : { exitCode }
    expect(result).toEqual({
      code: exitCode,
      stdout: `setup ${JSON.stringify(report)}\n`,
      stderr: '',
    })
    expect(names()).toEqual(['setup', 'identity'])
    expect(argsOf('setup')).toEqual([
      {
        ...context,
        cwd: '/work',
        configPath: CONFIG,
        repositories: ['a', '/b'],
        pi: '/pi',
        node: '/node',
        replace: true,
        tailscaleHints: false,
      },
    ])
    expect(argsOf('identity')).toEqual([identityDirectory(CONFIG), process.getuid?.()])
    expect(fetch).not.toHaveBeenCalled()
    expect(targets).toEqual([])
  })

  it('prints non-terminal setup as indented JSON and takes the process cwd by default', async () => {
    const result = await cli(['setup', '--json'], { cwd: undefined })
    expect(result.stdout).toBe(
      `${JSON.stringify({ exitCode: 0, next: 'phosphor login' }, null, 2)}\n`,
    )
    expect(argsOf('setup')[0]).toMatchObject({ cwd: process.cwd(), repositories: [] })
  })

  it.each([
    [[], 'step\n', ''],
    [['--json'], `${JSON.stringify({ exitCode: 0, done: true }, null, 2)}\n`, 'step\n'],
  ])('runs guided setup %j on a terminal, attached once', async (json, stdout, stderr) => {
    h.effects.set('guided-setup', async (options) => {
      ;(options as { print(line: string): void }).print('step')
      expect(targets).toHaveLength(1)
      expect(detached).toBe(0)
      return { exitCode: 0, done: true }
    })
    const result = await cli(['setup', ...flags, ...json], { terminal: true })
    expect(result).toEqual({ code: 0, stdout, stderr })
    expect(names()).toEqual(['guided-setup'])
    expect(argsOf('guided-setup')).toEqual([
      {
        ...context,
        terminal: true,
        json: json.length ? true : undefined,
        ...context.control,
        cwd: '/work',
        configPath: DEFAULT_CONFIG(),
        repositories: ['a', '/b'],
        pi: '/pi',
        node: '/node',
        replace: undefined,
        signal: expect.any(AbortSignal),
        print: expect.any(Function),
      },
    ])
    expect(targets).toHaveLength(1)
    expect(targets[0]!.log.hide('x')).toBe('Setup could not finish.')
    expect(detached).toBe(1)
  })
})

describe('runCli control commands', () => {
  it('runs the Host with the control log and no attachment of its own', async () => {
    h.effects.set('run', async (options) => {
      const { print } = options as { print(line: string): void }
      print('online')
      print('twice\n')
      return 0
    })
    const result = await cli(['run', '--config', CONFIG, '--supervisor', 'launchd'])
    expect(result).toEqual({ code: 0, stdout: 'online\ntwice\n', stderr: '' })
    expect(names()).toEqual(['host-log', 'run'])
    expect(argsOf('host-log')).toEqual([hostLogDirectory(context.env, home), SECRETS])
    expect(argsOf('run')).toEqual([
      {
        ...context,
        ...context.control,
        log: h.log.write,
        configPath: CONFIG,
        signal: expect.any(AbortSignal),
        print: expect.any(Function),
        supervisor: 'launchd',
      },
    ])
    expect(targets).toEqual([])
    expect(detached).toBe(0)
    await cli(['run'])
    expect(argsOf('run')[0]).toMatchObject({ supervisor: undefined })
  })

  it.each([
    [['service', 'install'], 'install', undefined],
    [['service', 'logs', '--follow'], 'logs', true],
    [['service', 'uninstall', '--config', CONFIG], 'uninstall', undefined],
  ])('runs %j attached once and detached once', async (argv, action, follow) => {
    h.effects.set('service', async () => {
      expect(targets).toHaveLength(1)
      return 3
    })
    expect(await cli(argv)).toEqual({ code: 3, stdout: '', stderr: '' })
    expect(names()).toEqual(['host-log', 'service'])
    const [run, ...rest] = argsOf('service')
    expect(rest).toEqual([action, follow])
    expect(run).toEqual({
      ...context,
      ...context.control,
      log: h.log.write,
      configPath: argv.includes(CONFIG) ? CONFIG : DEFAULT_CONFIG(),
      signal: expect.any(AbortSignal),
      print: expect.any(Function),
    })
    expect(targets[0]!.log.hide('x')).toBe('The service command could not finish.')
    expect(detached).toBe(1)
  })

  it.each([
    [['login'], 'login', 'logged in\n', []],
    [['logout'], 'logout', 'logged out\n', [undefined]],
    [['logout', '--local'], 'logout', 'logged out\n', [true]],
    [['status'], 'status', 'status {"status":"confirmed"}\n', []],
    [['status', '--json'], 'status', '{"status":"confirmed"}\n', []],
  ])('runs %j attached once with the control log', async (argv, name, stdout, rest) => {
    expect(await cli(argv)).toEqual({ code: 0, stdout, stderr: '' })
    expect(names()).toEqual(['host-log', name])
    expect(argsOf(name)).toEqual([
      {
        ...context,
        ...context.control,
        log: h.log.write,
        configPath: DEFAULT_CONFIG(),
        signal: expect.any(AbortSignal),
        print: expect.any(Function),
      },
      ...rest,
    ])
    expect(targets).toHaveLength(1)
    expect(targets[0]!.log.hide('x')).toBe('The control command could not finish.')
    expect(detached).toBe(1)
  })

  it('prints control output lines on stdout', async () => {
    h.effects.set('login', async (options) => {
      ;(options as { print(line: string): void }).print('BCDF-GHJK')
      return { exitCode: 75, message: 'expired' }
    })
    expect(await cli(['login'])).toEqual({ code: 75, stdout: 'BCDF-GHJK\nexpired\n', stderr: '' })
  })
})

describe('runCli shutdown wrappers', () => {
  it.each([
    [['setup'], 'guided-setup', { exitCode: 130 }],
    [['service', 'restart'], 'service', 130],
    [['login'], 'login', { exitCode: 130, message: 'stopped' }],
    [['status'], 'status', { exitCode: 130, report: {} }],
  ])('drains %j by aborting it and waiting for it to end', async (argv, name, result) => {
    let drained: Promise<{ state: string }> | undefined
    let ended = false
    h.effects.set(name, async (options) => {
      const { signal } = options as { signal: AbortSignal }
      drained = targets[0]!.drain('SIGINT').then((state) => {
        expect(ended).toBe(true)
        return state
      })
      expect(signal.aborted).toBe(true)
      await Promise.resolve()
      ended = true
      return result
    })
    expect((await cli(argv, { terminal: true })).code).toBe(130)
    expect(await drained).toEqual({ state: 'stopped' })
    expect(targets).toHaveLength(1)
    expect(detached).toBe(1)
  })

  it.each([
    [['setup'], 'guided-setup'],
    [['service', 'status'], 'service'],
    [['run'], 'run'],
    [['logout'], 'logout'],
  ])('aborts %j when the control signal aborts', async (argv, name) => {
    const controller = new AbortController()
    h.effects.set(name, async (options) => {
      const { signal } = options as { signal: AbortSignal }
      expect(signal).not.toBe(controller.signal)
      expect(signal.aborted).toBe(false)
      controller.abort()
      expect(signal.aborted).toBe(true)
      return name === 'run' || name === 'service' ? 0 : { exitCode: 0, message: '' }
    })
    const control = { ...context.control, signal: controller.signal }
    expect((await cli(argv, { terminal: true, control })).code).toBe(0)
    expect(names()).toContain(name)
  })

  it.each([
    [['setup'], 'guided-setup', 1],
    [['service', 'status'], 'service', 1],
    [['status'], 'status', 1],
    [['run'], 'run', 0],
    [['doctor'], 'doctor', 0],
    [['update'], 'update', 0],
  ])('reports %j failing as an internal error, detached %i times', async (argv, name, times) => {
    h.effects.set(name, async () => {
      throw new Error('boom')
    })
    expect(await cli(argv, { terminal: true })).toEqual({
      code: 70,
      stdout: '',
      stderr: 'phosphor: internal error: boom\n',
    })
    expect(detached).toBe(times)
  })

  it('keeps going without an attach port', async () => {
    for (const argv of [['setup'], ['service', 'status'], ['login']])
      expect((await cli(argv, { terminal: true, attach: undefined })).code).toBe(0)
  })
})
