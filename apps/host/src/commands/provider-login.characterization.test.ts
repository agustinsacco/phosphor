import { existsSync, readdirSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { claudeLoggedIn } from '../machine/claude'
import { which } from '../machine/executables'
import { inspectHost, type HostInspection } from './doctor'
import { runProviderLogin, type LoginContext } from './provider-login'
import { runProviders, type ProvidersOutcome } from './providers'

vi.mock('./doctor', () => ({ inspectHost: vi.fn() }))
vi.mock('./providers', () => ({ runProviders: vi.fn() }))
vi.mock('../machine/claude', () => ({ claudeLoggedIn: vi.fn() }))
vi.mock('../machine/executables', () => ({ which: vi.fn() }))

function inspection(): HostInspection {
  return {
    report: {
      ok: true,
      exitCode: 0,
      host: { version: '1', node: '22.22.3', platform: 'linux' },
      config: { path: '/host.json', hostId: 'test-host' },
      checks: [],
      lanes: { native: { available: true }, claude: { available: false } },
      providers: [{ id: 'xai', name: 'xAI', status: 'not_ready' }],
    },
    machine: null,
    secrets: ['provider-owned-secret'],
    piVersion: '1.2.0',
    claude: null,
    pi: {
      launch: { binaryPath: '/node', prefixArgs: ['/pi.js'], version: '1.2.0' },
      environment: {
        env: { PATH: '/bin', HOME: '/home/test' },
        names: ['HOME', 'PATH'],
        ambient: [],
        unset: [],
        secrets: [],
      },
    },
  }
}

function providers(status: 'ready' | 'not_ready'): ProvidersOutcome {
  return {
    report: {
      ok: status === 'ready',
      exitCode: status === 'ready' ? 0 : 69,
      hostId: 'test-host',
      providers: [{ id: 'xai', name: 'xAI', status }],
      claude: { available: false },
      next: 'next step',
    },
  }
}

function context(provider = 'xai'): LoginContext {
  return {
    configPath: '/host.json',
    env: { TERM: 'xterm-256color', NODE_OPTIONS: 'not-inherited' },
    platform: 'linux',
    uid: 1000,
    home: '/home/test',
    hostname: 'fallback-host',
    nodeVersion: '22.22.3',
    defaultResourceRoot: '/resources',
    probeTimeoutMs: 1234,
    provider,
    progress: vi.fn(),
    run: vi.fn(async () => ({ code: 0 })),
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(inspectHost).mockResolvedValue(inspection())
  vi.mocked(runProviders).mockResolvedValue(providers('not_ready'))
  vi.mocked(which).mockResolvedValue('/bin/claude')
  vi.mocked(claudeLoggedIn).mockResolvedValue({ loggedIn: false })
})

describe('runProviderLogin characterization', () => {
  it('starts nothing for an unknown provider or unusable pi', async () => {
    const input = context('--credentials')
    expect(await runProviderLogin(input)).toEqual({
      exitCode: 64,
      problem: 'unknown provider "--credentials": one of xai, claude',
    })
    const unavailable = inspection()
    unavailable.pi = null
    unavailable.report.exitCode = 69
    vi.mocked(inspectHost).mockResolvedValue(unavailable)
    expect(await runProviderLogin(input)).toEqual({
      exitCode: 69,
      problem: 'pi is not usable here, so nothing can sign in through it',
      doctor: unavailable.report,
    })
    expect(input.run).not.toHaveBeenCalled()
    expect(input.progress).not.toHaveBeenCalled()
    expect(runProviders).not.toHaveBeenCalled()
  })

  it.each(['xai', 'claude'])(
    'runs exact %s argv with TERM only for login and removes its empty cwd',
    async (provider) => {
      const input = context(provider)
      input.attach = () => () => {}
      let cwd = ''
      input.run = vi.fn(async (file, args, options) => {
        expect([file, ...args]).toEqual(
          provider === 'claude'
            ? ['/bin/claude', 'auth', 'login']
            : ['/node', '/pi.js', '--no-session', '--no-approve', '--no-extensions'],
        )
        cwd = options.cwd
        expect(existsSync(cwd)).toBe(true)
        expect(readdirSync(cwd)).toEqual([])
        expect(options.env).toEqual({ PATH: '/bin', HOME: '/home/test', TERM: 'xterm-256color' })
        expect(options.attach).toBe(input.attach)
        return { code: 0 }
      })
      const outcome = await runProviderLogin(input)
      expect(existsSync(cwd)).toBe(false)
      expect(inspectHost).toHaveBeenCalledWith(input)
      expect(runProviders).toHaveBeenCalledWith(input)
      for (const [, environment, options] of vi.mocked(claudeLoggedIn).mock.calls) {
        expect(environment.env).toEqual({ PATH: '/bin', HOME: '/home/test' })
        expect(options).toEqual({ timeoutMs: 1234 })
      }
      expect(JSON.stringify(outcome)).not.toContain('provider-owned-secret')
      expect(outcome.exitCode).toBe(69)
    },
  )

  it('does not add TERM when absent and always removes cwd after a thrown login', async () => {
    const input = context()
    input.env = {}
    let cwd = ''
    input.run = async (_file, _args, options) => {
      cwd = options.cwd
      expect(options.env).toEqual({ PATH: '/bin', HOME: '/home/test' })
      throw new Error('terminal failed')
    }
    await expect(runProviderLogin(input)).rejects.toThrow('terminal failed')
    expect(existsSync(cwd)).toBe(false)
    expect(runProviders).not.toHaveBeenCalled()
  })

  it('removes cwd and stops before status checks when the program cannot start', async () => {
    const input = context()
    let cwd = ''
    input.run = async (_file, _args, options) => {
      cwd = options.cwd
      return { code: null, error: 'spawn EACCES' }
    }
    expect(await runProviderLogin(input)).toEqual({
      exitCode: 69,
      problem: '/node could not start: spawn EACCES',
    })
    expect(existsSync(cwd)).toBe(false)
    expect(runProviders).not.toHaveBeenCalled()
  })

  it.each(['xai', 'claude'])(
    'uses post-login %s auth, not child exit, and explains an earlier login',
    async (provider) => {
      const before = inspection()
      if (before.report.providers)
        before.report.providers[0] = { id: 'xai', name: 'xAI', status: 'ready' }
      vi.mocked(inspectHost).mockResolvedValue(before)
      vi.mocked(claudeLoggedIn).mockResolvedValue({ loggedIn: true })
      const after = providers('ready')
      vi.mocked(runProviders).mockResolvedValue(after)
      const input = context(provider)
      input.run = vi.fn(async () => ({ code: 7 }))
      expect(await runProviderLogin(input)).toEqual({ exitCode: 0, after })
      const name = provider === 'claude' ? 'Claude Code' : 'xAI'
      const state = provider === 'claude' ? 'logged in' : 'signed in'
      expect(input.progress).toHaveBeenCalledWith(
        `${name} on test-host: ${state}. It already was, so if the login did not finish, this is the earlier one.`,
      )
      expect(input.progress).toHaveBeenCalledWith(
        provider === 'claude'
          ? 'Claude Code is already logged in here; logging in again replaces that login.'
          : 'xAI is already signed in here; signing in again replaces that login.',
      )
    },
  )

  it('reports unreadable Claude auth without claiming that child success signed in', async () => {
    vi.mocked(claudeLoggedIn).mockResolvedValue({ unreadable: ': timed out' })
    const input = context('claude')
    expect((await runProviderLogin(input)).exitCode).toBe(69)
    expect(input.progress).toHaveBeenLastCalledWith(
      'Claude Code on test-host: claude auth status was unreadable: timed out.',
    )
  })
})
