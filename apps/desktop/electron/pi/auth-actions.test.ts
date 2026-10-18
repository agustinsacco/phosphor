import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LoginFlowState, LoginProviderId } from '@shared/models'
import type * as Health from './health'

const state = vi.hoisted(() => ({
  open: vi.fn(),
  start: vi.fn<(id: LoginProviderId, emit: (state: LoginFlowState) => void) => Promise<void>>(),
  health: vi.fn(),
  cachedHealth: vi.fn(),
  cwd: vi.fn(),
  env: vi.fn(),
  create: vi.fn(),
}))
vi.mock('electron', () => ({ shell: { openExternal: state.open } }))
vi.mock('./login-flow', () => ({
  startLogin: state.start,
  signInCwd: state.cwd,
  LOGIN_TERMINAL_ARGS: ['--no-session', '--no-approve'],
}))
vi.mock('./health', async (original) => ({
  ...(await original<typeof Health>()),
  checkPiHealth: state.health,
  cachedPiHealth: state.cachedHealth,
}))
vi.mock('./shell-env', () => ({ piProcessEnv: state.env }))
vi.mock('../pty/pty-manager', () => ({ ptyManager: { create: state.create } }))

import { createLoginTerminal, startLoginWithBrowser } from './auth-actions'

const browser = (url: string): LoginFlowState => ({
  providerId: 'xai',
  phase: 'awaiting-browser',
  url,
})

beforeEach(() => {
  vi.resetAllMocks()
  state.open.mockResolvedValue(undefined)
  state.health.mockResolvedValue({ ok: true, binaryPath: '/bin/pi' })
  state.cwd.mockReturnValue('/sign-in')
  state.env.mockResolvedValue({ PATH: '/shell/bin' })
  state.create.mockReturnValue({ ptyId: 'pty' })
})
afterEach(() => vi.unstubAllEnvs())

describe('startLoginWithBrowser', () => {
  it('opens the normalized first browser prompt once and forwards all states unchanged', async () => {
    const states: LoginFlowState[] = [
      { providerId: 'xai', phase: 'starting' },
      browser('https://EXAMPLE.com'),
      browser('https://EXAMPLE.com'),
      browser('https://other.example/'),
      { providerId: 'xai', phase: 'signed-in' },
    ]
    const notify = vi.fn()
    state.start.mockImplementation(async (_provider, emit) => states.forEach(emit))
    await expect(startLoginWithBrowser('xai', notify)).resolves.toBeUndefined()
    expect(state.start.mock.calls[0]![0]).toBe('xai')
    expect(state.open).toHaveBeenCalledExactlyOnceWith('https://example.com/')
    expect(notify.mock.calls).toEqual(states.map((value) => [value]))
  })

  it.each(['file:///etc/passwd', 'custom:handler', 'invalid'])(
    'consumes the first prompt even when %s is refused',
    async (url) => {
      const notify = vi.fn()
      state.start.mockImplementation(async (_provider, emit) => {
        emit(browser(url))
        emit(browser('https://valid.example/'))
      })
      await startLoginWithBrowser('xai', notify)
      expect(state.open).not.toHaveBeenCalled()
      expect(notify).toHaveBeenCalledTimes(2)
    },
  )

  it('keeps broadcasting when opening the browser throws synchronously', async () => {
    state.open.mockImplementation(() => {
      throw new Error('no browser')
    })
    const notify = vi.fn()
    const prompt = browser('http://localhost:3000')
    state.start.mockImplementation(async (_provider, emit) => {
      emit(prompt)
      emit(prompt)
    })
    await startLoginWithBrowser('xai', notify)
    expect(state.open).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls).toEqual([[prompt], [prompt]])
  })

  it('isolates the browser guard for concurrent sign-ins', async () => {
    const emitters: Array<(value: LoginFlowState) => void> = []
    state.start.mockImplementation(async (_provider, emit) => {
      emitters.push(emit)
    })
    const first = vi.fn()
    const second = vi.fn()
    await Promise.all([
      startLoginWithBrowser('xai', first),
      startLoginWithBrowser('anthropic', second),
    ])
    for (const emit of emitters) {
      emit(browser('https://login.example/'))
      emit(browser('https://login.example/'))
    }
    expect(state.open).toHaveBeenCalledTimes(2)
    expect(first).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledTimes(2)
  })

  it('propagates login rejection without manufacturing a state', async () => {
    const error = new Error('provider unavailable')
    state.start.mockRejectedValue(error)
    const notify = vi.fn()
    await expect(startLoginWithBrowser('xai', notify)).rejects.toBe(error)
    expect(notify).not.toHaveBeenCalled()
  })
})

describe('createLoginTerminal', () => {
  it('uses fresh real pi discovery even when a stub is configured', async () => {
    vi.stubEnv('PHOSPHOR_PI_STUB', '/stub.cjs')
    state.health.mockResolvedValueOnce({ ok: true, binaryPath: '/node', prefixArgs: ['/pi.js'] })
    const env = { PATH: '/shell/bin', CUSTOM: 'kept' }
    state.env.mockResolvedValueOnce(env)
    expect(await createLoginTerminal(120, 42)).toEqual({ ptyId: 'pty' })
    expect(state.create).toHaveBeenNthCalledWith(1, '/sign-in', 120, 42, undefined, {
      file: '/node',
      args: ['/pi.js', '--no-session', '--no-approve'],
      env,
    })
    expect(state.create.mock.calls[0]![4].env).toBe(env)
    await createLoginTerminal(80, 24)
    expect(state.health).toHaveBeenCalledTimes(2)
    expect(state.create).toHaveBeenNthCalledWith(2, '/sign-in', 80, 24, undefined, {
      file: '/bin/pi',
      args: ['--no-session', '--no-approve'],
      env: { PATH: '/shell/bin' },
    })
    expect(state.cachedHealth).not.toHaveBeenCalled()
  })

  it.each([{ ok: false, message: 'upgrade required' }, { ok: false }, { ok: true }])(
    'rejects unavailable real pi without using a stub: %j',
    async (health) => {
      state.health.mockResolvedValue(health)
      await expect(createLoginTerminal(80, 24)).rejects.toThrow(
        'message' in health ? health.message : 'pi is not available',
      )
      expect(state.cwd).not.toHaveBeenCalled()
      expect(state.env).not.toHaveBeenCalled()
      expect(state.create).not.toHaveBeenCalled()
    },
  )

  it.each(['health', 'cwd', 'env', 'create'] as const)(
    'propagates %s failure unchanged',
    async (stage) => {
      const error = new Error(`${stage} failed`)
      state[stage].mockImplementationOnce(() => {
        throw error
      })
      await expect(createLoginTerminal(80, 24)).rejects.toBe(error)
    },
  )
})
