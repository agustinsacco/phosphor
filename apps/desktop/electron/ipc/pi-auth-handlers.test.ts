import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcInvokeChannel, IpcInvokeMap } from '@shared/ipc'
import type { LoginFlowState, LoginProviderId } from '@shared/models'
import type * as Health from '../pi/health'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  open: vi.fn(),
  send: vi.fn(),
  destroyedSend: vi.fn(),
  start: vi.fn<(id: LoginProviderId, emit: (state: LoginFlowState) => void) => Promise<void>>(),
  cancel: vi.fn(),
  auth: vi.fn(),
  usage: vi.fn(),
  health: vi.fn(),
  invalidateHealth: vi.fn(),
  invalidateModels: vi.fn(),
  invalidateCommands: vi.fn(),
  cwd: vi.fn(),
  env: vi.fn(),
  create: vi.fn(),
}))
vi.mock('electron', () => ({
  shell: { openExternal: state.open },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: state.send } },
      { isDestroyed: () => true, webContents: { send: state.destroyedSend } },
    ],
  },
}))
vi.mock('./handle', () => ({
  handle: (name: string, cb: (...args: unknown[]) => unknown) => state.handlers.set(name, cb),
}))
vi.mock('../pi/auth-status', () => ({ checkSubscriptionAuth: state.auth }))
vi.mock('../pi/codex-usage', () => ({ fetchCodexUsage: state.usage }))
vi.mock('../pi/login-flow', () => ({
  startLogin: state.start,
  cancelLogin: state.cancel,
  signInCwd: state.cwd,
  LOGIN_TERMINAL_ARGS: ['--no-session', '--no-approve'],
}))
vi.mock('../pi/health', async (original) => ({
  ...(await original<typeof Health>()),
  checkPiHealth: state.health,
  invalidatePiHealth: state.invalidateHealth,
}))
vi.mock('../pi/catalogue', () => ({
  invalidateCatalogueModels: state.invalidateModels,
  invalidatePiCommands: state.invalidateCommands,
}))
vi.mock('../pi/shell-env', () => ({ piProcessEnv: state.env }))
vi.mock('../pty/pty-manager', () => ({ ptyManager: { create: state.create } }))

async function invoke<C extends IpcInvokeChannel>(
  channel: C,
  ...args: IpcInvokeMap[C]['args']
): Promise<IpcInvokeMap[C]['result']> {
  return state.handlers.get(channel)!(null, ...args) as IpcInvokeMap[C]['result']
}

function browser(url: string): LoginFlowState {
  return { providerId: 'anthropic', phase: 'awaiting-browser', url }
}

beforeEach(async () => {
  vi.resetAllMocks()
  state.handlers.clear()
  state.open.mockResolvedValue(undefined)
  state.health.mockResolvedValue({ ok: true, binaryPath: '/node', prefixArgs: ['/pi.js'] })
  state.cwd.mockReturnValue('/user-data/pi-sign-in')
  state.env.mockResolvedValue({ PATH: '/shell/bin', CUSTOM: 'kept' })
  state.create.mockReturnValue({ ptyId: 'login-pty' })
  const { registerPiAuthHandlers } = await import('./pi-auth-handlers')
  registerPiAuthHandlers()
})

describe('pi auth handler characterization', () => {
  it.each(['http://localhost:3000', 'https://EXAMPLE.com'])(
    'opens %s once before broadcasting',
    async (url) => {
      const first = browser(url)
      const next = browser('https://other.example/next')
      state.start.mockImplementation(async (_provider, emit) => {
        emit(first)
        emit(first)
        emit(next)
      })
      await expect(invoke('pi:startLogin', 'anthropic')).resolves.toBeUndefined()
      expect(state.open).toHaveBeenCalledExactlyOnceWith(new URL(url).toString())
      expect(state.open.mock.invocationCallOrder[0]).toBeLessThan(
        state.send.mock.invocationCallOrder[0]!,
      )
      expect(state.send.mock.calls).toEqual([
        ['pi:loginState', first],
        ['pi:loginState', first],
        ['pi:loginState', next],
      ])
      expect(state.destroyedSend).not.toHaveBeenCalled()
      expect(state.invalidateModels).not.toHaveBeenCalled()
    },
  )

  it.each(['not a url', 'file:///etc/passwd', 'custom:handler'])(
    'refuses %s but still broadcasts every state',
    async (url) => {
      const first = browser(url)
      const next = browser('https://valid.example/')
      state.start.mockImplementation(async (_provider, emit) => {
        emit(first)
        emit(next)
      })
      await invoke('pi:startLogin', 'anthropic')
      expect(state.open).not.toHaveBeenCalled()
      expect(state.send.mock.calls).toEqual([
        ['pi:loginState', first],
        ['pi:loginState', next],
      ])
    },
  )

  it('gives each start its own browser-once guard and forwards provider and failures', async () => {
    state.start.mockImplementation(async (providerId, emit) => {
      emit({ providerId, phase: 'awaiting-browser', url: 'https://login.example/' })
    })
    await invoke('pi:startLogin', 'anthropic')
    await invoke('pi:startLogin', 'xai')
    expect(state.start.mock.calls.map(([id]) => id)).toEqual(['anthropic', 'xai'])
    expect(state.open).toHaveBeenCalledTimes(2)
    const error = new Error('already signing in')
    state.start.mockRejectedValueOnce(error)
    await expect(invoke('pi:startLogin', 'anthropic')).rejects.toBe(error)
  })

  it('invalidates models then health then commands before broadcasting signed-in', async () => {
    const starting: LoginFlowState = { providerId: 'anthropic', phase: 'starting' }
    const signedIn: LoginFlowState = { providerId: 'anthropic', phase: 'signed-in' }
    state.start.mockImplementation(async (_provider, emit) => {
      emit(starting)
      emit(signedIn)
    })
    await invoke('pi:startLogin', 'anthropic')
    const order = [
      state.send,
      state.invalidateModels,
      state.invalidateHealth,
      state.invalidateCommands,
    ].map((mock) => mock.mock.invocationCallOrder[0]!)
    order.push(state.send.mock.invocationCallOrder[1]!)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(state.send.mock.calls).toEqual([
      ['pi:loginState', starting],
      ['pi:loginState', signedIn],
    ])
    expect(state.invalidateModels).toHaveBeenCalledTimes(1)
    expect(state.invalidateHealth).toHaveBeenCalledTimes(1)
    expect(state.invalidateCommands).toHaveBeenCalledTimes(1)
  })

  it('forwards subscription status, literal usage force and cancellation', async () => {
    state.auth.mockResolvedValue(['status'])
    state.usage.mockResolvedValue({ usage: 'result' })
    expect(await invoke('pi:subscriptionAuth')).toEqual(['status'])
    expect(await invoke('pi:codexUsage', true)).toEqual({ usage: 'result' })
    await invoke('pi:codexUsage', false)
    await invoke('pi:codexUsage')
    expect(state.usage.mock.calls).toEqual([[true], [false], [false]])
    await invoke('pi:cancelLogin', 'xai')
    expect(state.cancel).toHaveBeenCalledExactlyOnceWith('xai')
  })

  it('launches the interactive terminal with prefixes, isolated cwd and exact environment', async () => {
    expect(await invoke('pi:loginTerminal', 120, 42)).toEqual({ ptyId: 'login-pty' })
    expect(state.create).toHaveBeenCalledExactlyOnceWith(
      '/user-data/pi-sign-in',
      120,
      42,
      undefined,
      {
        file: '/node',
        args: ['/pi.js', '--no-session', '--no-approve'],
        env: { PATH: '/shell/bin', CUSTOM: 'kept' },
      },
    )
    const order = [state.health, state.cwd, state.env, state.create].map(
      (mock) => mock.mock.invocationCallOrder[0]!,
    )
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it.each([{ ok: false, message: 'upgrade pi' }, { ok: false }, { ok: true }])(
    'forwards unavailable pi errors: %j',
    async (health) => {
      state.health.mockResolvedValue(health)
      await expect(invoke('pi:loginTerminal', 80, 24)).rejects.toThrow(
        'message' in health ? health.message : 'pi is not available',
      )
      expect(state.cwd).not.toHaveBeenCalled()
      expect(state.env).not.toHaveBeenCalled()
      expect(state.create).not.toHaveBeenCalled()
    },
  )

  it.each(['health', 'cwd', 'env', 'create'] as const)(
    'preserves %s failure identity',
    async (stage) => {
      const error = new Error(`${stage} failed`)
      state[stage].mockImplementationOnce(() => {
        throw error
      })
      await expect(invoke('pi:loginTerminal', 80, 24)).rejects.toBe(error)
    },
  )
})
