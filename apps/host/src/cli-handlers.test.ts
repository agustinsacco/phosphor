import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as Accept from './commands/accept'
import type * as Doctor from './commands/doctor'
import type * as ProviderLogin from './commands/provider-login'
import type * as Providers from './commands/providers'
import type * as Tailscale from './commands/tailscale'
import type * as Uninstall from './commands/uninstall'
import type * as Update from './commands/update'
import type * as ShellPath from './machine/shell-path'
import {
  configPathOf,
  handleAccept,
  handleDoctor,
  handleInstall,
  handleInstallPath,
  handleProviderLogin,
  handleProviders,
  handleTailscale,
  handleVersion,
  type CliContext,
} from './cli-handlers'

const m = vi.hoisted(() => ({
  runDoctor: vi.fn(),
  runProviders: vi.fn(),
  runProviderLogin: vi.fn(),
  runAccept: vi.fn(),
  runTailscale: vi.fn(),
  runUpdate: vi.fn(),
  runUninstall: vi.fn(),
  installHostPath: vi.fn(),
}))
vi.mock('./commands/doctor', async (original) => ({
  ...(await original<typeof Doctor>()),
  runDoctor: m.runDoctor,
  renderDoctor: (report: unknown) => `doctor ${JSON.stringify(report)}\n`,
}))
vi.mock('./commands/providers', async (original) => ({
  ...(await original<typeof Providers>()),
  runProviders: m.runProviders,
  renderProviders: (report: unknown) => `providers ${JSON.stringify(report)}\n`,
}))
vi.mock('./commands/provider-login', async (original) => ({
  ...(await original<typeof ProviderLogin>()),
  runProviderLogin: m.runProviderLogin,
}))
vi.mock('./commands/accept', async (original) => ({
  ...(await original<typeof Accept>()),
  runAccept: m.runAccept,
  renderAccept: (report: unknown) => `accept ${JSON.stringify(report)}\n`,
}))
vi.mock('./commands/tailscale', async (original) => ({
  ...(await original<typeof Tailscale>()),
  runTailscale: m.runTailscale,
}))
vi.mock('./commands/update', async (original) => ({
  ...(await original<typeof Update>()),
  runUpdate: m.runUpdate,
}))
vi.mock('./commands/uninstall', async (original) => ({
  ...(await original<typeof Uninstall>()),
  runUninstall: m.runUninstall,
}))
vi.mock('./machine/shell-path', async (original) => ({
  ...(await original<typeof ShellPath>()),
  installHostPath: m.installHostPath,
}))

afterEach(() => {
  vi.clearAllMocks()
})

const context: CliContext = {
  env: {},
  platform: 'linux',
  uid: 501,
  home: '/home/bee',
  hostname: 'bee1',
  nodeVersion: '22.22.3',
  defaultResourceRoot: '/resources',
  runInTerminal: async () => ({ code: 0 }),
  tailscale: { which: async () => null, probe: vi.fn() },
  control: { now: () => 1 },
}
const DEFAULT = '/home/bee/.config/phosphor-host/config.json'
function io() {
  const out = { stdout: '', stderr: '' }
  return {
    out,
    io: {
      stdout: (text: string) => void (out.stdout += text),
      stderr: (text: string) => void (out.stderr += text),
    },
  }
}

describe('configPathOf', () => {
  it('takes --config, then an absolute XDG_CONFIG_HOME, then the home folder', () => {
    expect(configPathOf({ config: '/c.json' }, context)).toBe('/c.json')
    expect(configPathOf({}, { ...context, env: { XDG_CONFIG_HOME: '/xdg' } })).toBe(
      '/xdg/phosphor-host/config.json',
    )
    expect(configPathOf({}, { ...context, env: { XDG_CONFIG_HOME: 'xdg' } })).toBe(DEFAULT)
  })
})

describe('report handlers', () => {
  it('prints the version plain or as one JSON line', async () => {
    const plain = io()
    expect(await handleVersion({ name: 'version', options: {} }, plain.io, context)).toBe(0)
    expect(plain.out.stdout).toBe('phosphor 0.0.0-dev.source\n')
    const json = io()
    await handleVersion({ name: 'version', options: { json: true } }, json.io, context)
    expect(json.out.stdout).toBe(
      '{"hostVersion":"0.0.0-dev.source","protocolVersion":1,"sourceSha":null,"node":"22.22.3"}\n',
    )
  })

  it('installs the shell path, printing each line to stdout', async () => {
    m.installHostPath.mockImplementation((options: { print(line: string): void }) =>
      options.print('PATH block added'),
    )
    const { io: cli, out } = io()
    expect(
      await handleInstallPath({ name: 'internal-install-path', options: {} }, cli, context),
    ).toBe(0)
    expect(out).toEqual({ stdout: 'PATH block added\n', stderr: '' })
  })

  it('prints the doctor report plain or indented, with its exit code', async () => {
    m.runDoctor.mockResolvedValue({ exitCode: 78, ok: false })
    const { io: cli, out } = io()
    expect(await handleDoctor({ name: 'doctor', options: { json: true } }, cli, context)).toBe(78)
    expect(out.stdout).toBe('{\n  "exitCode": 78,\n  "ok": false\n}\n')
    expect(m.runDoctor).toHaveBeenCalledWith({ ...context, configPath: DEFAULT })
  })

  it("shows doctor's report and pi's problem when providers cannot be listed", async () => {
    m.runProviders.mockResolvedValue({ exitCode: 69, problem: 'pi is missing', doctor: { d: 1 } })
    const { io: cli, out } = io()
    expect(await handleProviders({ name: 'providers', options: {} }, cli, context)).toBe(69)
    expect(out).toEqual({ stdout: 'doctor {"d":1}\n', stderr: 'phosphor: pi is missing\n' })
  })

  it("takes the providers report's own exit code", async () => {
    m.runProviders.mockResolvedValue({ exitCode: 1, report: { exitCode: 0 } })
    const { io: cli, out } = io()
    expect(await handleProviders({ name: 'providers', options: {} }, cli, context)).toBe(0)
    expect(out).toEqual({ stdout: 'providers {"exitCode":0}\n', stderr: '' })
  })

  it('dispatches tailscale with its action and ports', async () => {
    m.runTailscale.mockResolvedValue({ exitCode: 0, message: 'Tailscale serves the API' })
    const { io: cli, out } = io()
    const command = { name: 'tailscale', action: 'enable', options: { config: '/c' } } as const
    expect(await handleTailscale(command, cli, context)).toBe(0)
    expect(out.stdout).toBe('Tailscale serves the API\n')
    expect(m.runTailscale).toHaveBeenCalledWith(
      { ...context, configPath: '/c' },
      'enable',
      context.tailscale,
    )
  })
})

describe('provider login and accept handlers', () => {
  it('signs in on the terminal and shows the providers report after it', async () => {
    m.runProviderLogin.mockImplementation(async (options: { progress(line: string): void }) => {
      options.progress('pi opens next')
      return { exitCode: 0, after: { report: { signedIn: ['xai'] } } }
    })
    const { io: cli, out } = io()
    const command = { name: 'providers login', provider: 'xai', options: {} } as const
    expect(await handleProviderLogin(command, cli, context)).toBe(0)
    expect(out).toEqual({
      stdout: 'providers {"signedIn":["xai"]}\n',
      stderr: 'pi opens next\n',
    })
    expect(m.runProviderLogin.mock.calls[0]![0]).toMatchObject({
      provider: 'xai',
      configPath: DEFAULT,
      run: context.runInTerminal,
    })
  })

  it('shows a login problem, and doctor only when there is one', async () => {
    m.runProviderLogin.mockResolvedValue({ exitCode: 64, problem: 'unknown provider "nope"' })
    const { io: cli, out } = io()
    const command = { name: 'providers login', provider: 'nope', options: {} } as const
    expect(await handleProviderLogin(command, cli, context)).toBe(64)
    expect(out).toEqual({ stdout: '', stderr: 'phosphor: unknown provider "nope"\n' })
  })

  it('passes accept options through with defaults, progress on stderr', async () => {
    m.runAccept.mockImplementation(async (options: { progress(line: string): void }) => {
      options.progress('native: pass')
      return { exitCode: 0, evidence: { lanes: [] } }
    })
    const { io: cli, out } = io()
    const command = { name: 'accept', repository: '/r', lane: 'all', options: {} } as const
    expect(await handleAccept(command, cli, context)).toBe(0)
    expect(out).toEqual({ stdout: 'accept {"lanes":[]}\n', stderr: 'native: pass\n' })
    expect(m.runAccept.mock.calls[0]![0]).toMatchObject({
      repository: '/r',
      lane: 'all',
      keepTranscripts: false,
      provider: undefined,
      claudeModel: undefined,
      model: undefined,
    })
  })

  it.each([
    [{ exitCode: 69, problem: 'p', doctor: { d: 1 } }, '{\n  "d": 1\n}\n'],
    [{ exitCode: 78, problem: 'p' }, ''],
  ])('prints an accept problem %j', async (outcome, stdout) => {
    m.runAccept.mockResolvedValue(outcome)
    const { io: cli, out } = io()
    const command = {
      name: 'accept',
      repository: '/r',
      lane: 'native',
      options: { json: true },
    } as const
    expect(await handleAccept(command, cli, context)).toBe(outcome.exitCode)
    expect(out).toEqual({ stdout, stderr: 'phosphor: p\n' })
  })
})

describe('install handler', () => {
  const print = (count: number) => async (options: { print(line: string): void }) => {
    for (let index = 0; index < count; index++) options.print(`line ${index}`)
    return 0
  }

  it('keeps the first 256 update messages and passes the update options', async () => {
    m.runUpdate.mockImplementation(print(257))
    const { io: cli, out } = io()
    const options = { json: true, check: true }
    expect(await handleInstall({ name: 'update', options }, cli, context)).toBe(0)
    const { messages } = JSON.parse(out.stdout) as { messages: string[] }
    expect(messages).toHaveLength(256)
    expect(messages.at(-1)).toBe('line 255')
    expect(m.runUpdate).toHaveBeenCalledWith(
      {
        ...context,
        json: true,
        ...context.control,
        configPath: DEFAULT,
        print: expect.any(Function),
      },
      options,
    )
  })

  it('prints uninstall messages as lines and passes purge and yes', async () => {
    m.runUninstall.mockImplementation(print(2))
    const { io: cli, out } = io()
    const options = { purge: true, yes: true }
    expect(await handleInstall({ name: 'uninstall', options }, cli, context)).toBe(0)
    expect(out.stdout).toBe('line 0\nline 1\n')
    expect(m.runUninstall.mock.calls[0]!.slice(1)).toEqual([true, true])
  })
})
