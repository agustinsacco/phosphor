import { beforeEach, describe, expect, it, vi } from 'vitest'
import { claudeLoggedIn } from '../machine/claude'
import type { PiEnvironment } from '../machine/environment'
import { which } from '../machine/executables'
import type { ProviderState } from '../machine/providers'
import type { DoctorReport } from './doctor'
import {
  CLAUDE_LOGIN,
  PI_LOGIN_ARGS,
  prepareProviderLogin,
  providerLoginInstructions,
  providerLoginStatus,
  type ProviderLoginPlan,
} from './provider-login-plan'
import type { ProvidersOutcome } from './providers'

vi.mock('../machine/claude', () => ({ claudeLoggedIn: vi.fn() }))
vi.mock('../machine/executables', () => ({ which: vi.fn() }))

const environment: PiEnvironment = {
  env: { PATH: '/host/bin', HOME: '/host/home' },
  names: ['HOME', 'PATH'],
  ambient: [],
  unset: [],
  secrets: [],
}
const pi = {
  launch: { binaryPath: '/node', prefixArgs: ['/pi.js'], version: '1.2.0' },
  environment,
}
const row: ProviderState = { id: 'xai', name: 'xAI', status: 'not_ready' }
const options = { host: 'bee', timeoutMs: 1234 }

function nativePlan(before = false): ProviderLoginPlan {
  return {
    kind: 'native',
    file: '/node',
    args: ['/pi.js', ...PI_LOGIN_ARGS],
    row,
    host: 'bee',
    before,
  }
}

function claudePlan(before = false): ProviderLoginPlan {
  return { kind: 'claude', file: '/claude', args: ['auth', 'login'], host: 'bee', before }
}

function after(providers: ProviderState[]): ProvidersOutcome {
  return {
    report: {
      ok: true,
      exitCode: 0,
      hostId: 'bee',
      providers,
      claude: { available: false },
      next: '',
    },
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(which).mockResolvedValue('/claude')
  vi.mocked(claudeLoggedIn).mockResolvedValue({ loggedIn: false })
})

describe('prepareProviderLogin', () => {
  it('plans native login from the matching row without probing Claude or changing launch args', async () => {
    expect(await prepareProviderLogin('xai', [row], pi, options)).toEqual(nativePlan())
    expect(
      await prepareProviderLogin('xai', [{ ...row, status: 'ready' }], pi, options),
    ).toMatchObject({
      kind: 'native',
      before: true,
    })
    expect(pi.launch.prefixArgs).toEqual(['/pi.js'])
    expect(PI_LOGIN_ARGS).toEqual(['--no-session', '--no-approve', '--no-extensions'])
    expect(which).not.toHaveBeenCalled()
    expect(claudeLoggedIn).not.toHaveBeenCalled()
  })

  it('rejects unknown providers with the ordered known ids, even when the list is empty', async () => {
    expect(await prepareProviderLogin('missing', [row], pi, options)).toEqual({
      exitCode: 64,
      problem: 'unknown provider "missing": one of xai, claude',
    })
    expect(await prepareProviderLogin('missing', [], pi, options)).toEqual({
      exitCode: 64,
      problem: 'unknown provider "missing": one of claude',
    })
    expect(which).not.toHaveBeenCalled()
  })

  it('plans Claude from only the built PATH and probes its earlier auth with the original environment', async () => {
    vi.mocked(claudeLoggedIn).mockResolvedValue({ loggedIn: true })
    expect(await prepareProviderLogin(CLAUDE_LOGIN, [], pi, options)).toEqual(claudePlan(true))
    expect(which).toHaveBeenCalledWith('claude', '/host/bin')
    expect(claudeLoggedIn).toHaveBeenCalledWith('/claude', environment, { timeoutMs: 1234 })
  })

  it('treats unreadable earlier Claude auth as not signed in', async () => {
    vi.mocked(claudeLoggedIn).mockResolvedValue({ unreadable: ': timeout' })
    expect(await prepareProviderLogin('claude', [], pi, options)).toEqual(claudePlan())
  })

  it('reports missing Claude without probing auth', async () => {
    vi.mocked(which).mockResolvedValue(null)
    expect(await prepareProviderLogin('claude', [row], pi, options)).toEqual({
      exitCode: 69,
      problem: 'Claude Code is not installed: run phosphor setup',
    })
    expect(claudeLoggedIn).not.toHaveBeenCalled()
  })
})

describe('providerLoginInstructions', () => {
  it('preserves native instructions and prepends the earlier-login warning only when signed in', () => {
    const lines = [
      'Signing in to xAI on bee. pi opens next:',
      '  1. type /login xai and press Enter (twice if pi first completes the name); if pi asks how, choose to sign in with an account',
      '  2. open the link pi prints, on any computer, and sign in',
      '  3. if pi asks for a code, or the browser ends on an address that does not load, paste it into pi',
      '  4. once pi says you are logged in, type /quit',
    ]
    expect(providerLoginInstructions(nativePlan())).toEqual(lines)
    expect(providerLoginInstructions(nativePlan(true))).toEqual([
      'xAI is already signed in here; signing in again replaces that login.',
      ...lines,
    ])
  })

  it('preserves Claude instructions and its earlier-login warning', () => {
    const lines = [
      'Signing in to Claude Code on bee. claude auth login runs next:',
      '  1. open the link it prints, on any computer, and sign in',
      '  2. paste the code the page shows here, and press Enter',
    ]
    expect(providerLoginInstructions(claudePlan())).toEqual(lines)
    expect(providerLoginInstructions(claudePlan(true))).toEqual([
      'Claude Code is already logged in here; logging in again replaces that login.',
      ...lines,
    ])
  })
})

describe('providerLoginStatus', () => {
  it('describes the matching native status, including provider reasons', async () => {
    expect(await providerLoginStatus(nativePlan(), after([row]), environment)).toEqual({
      signedIn: false,
      message: 'xAI on bee: not signed in.',
    })
    expect(
      await providerLoginStatus(
        nativePlan(true),
        after([{ ...row, status: 'ready' }]),
        environment,
      ),
    ).toEqual({
      signedIn: true,
      message:
        'xAI on bee: signed in. It already was, so if the login did not finish, this is the earlier one.',
    })
    expect(
      await providerLoginStatus(
        nativePlan(true),
        after([{ ...row, reason: 'provider_not_found' }]),
        environment,
      ),
    ).toEqual({ signedIn: false, message: 'xAI on bee: this pi does not offer it.' })
    expect(claudeLoggedIn).not.toHaveBeenCalled()
  })

  it('reports unknown for a missing native row or unusable post-login provider inspection', async () => {
    const doctor: DoctorReport = {
      ok: false,
      exitCode: 69,
      host: { version: '1', node: '22.22.3', platform: 'linux' },
      config: { path: '/host.json' },
      checks: [],
      lanes: { native: { available: false }, claude: { available: false } },
    }
    for (const outcome of [after([]), { exitCode: 69, problem: 'unusable', doctor }]) {
      expect(await providerLoginStatus(nativePlan(true), outcome, environment)).toEqual({
        signedIn: false,
        message: 'xAI on bee: unknown.',
      })
    }
  })

  it.each([
    [{ loggedIn: true }, true, 'logged in'],
    [{ loggedIn: false }, false, 'not logged in'],
    [{ unreadable: ': timeout' }, false, 'claude auth status was unreadable: timeout'],
  ] as const)(
    'uses fresh Claude auth %j rather than the provider report',
    async (auth, signedIn, state) => {
      vi.mocked(claudeLoggedIn).mockResolvedValue(auth)
      expect(await providerLoginStatus(claudePlan(), after([row]), environment, 5678)).toEqual({
        signedIn,
        message: `Claude Code on bee: ${state}.`,
      })
      expect(claudeLoggedIn).toHaveBeenCalledWith('/claude', environment, { timeoutMs: 5678 })
    },
  )

  it('adds the earlier Claude login note only when still signed in', async () => {
    vi.mocked(claudeLoggedIn).mockResolvedValue({ loggedIn: true })
    expect(await providerLoginStatus(claudePlan(true), after([]), environment)).toEqual({
      signedIn: true,
      message:
        'Claude Code on bee: logged in. It already was, so if the login did not finish, this is the earlier one.',
    })
  })
})
