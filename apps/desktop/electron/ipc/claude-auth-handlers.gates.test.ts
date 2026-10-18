import type { ClaudeLoginState } from '@shared/models'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  app: { isPackaged: false },
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  send: vi.fn(),
  destroyedSend: vi.fn(),
  startClaudeLogin: vi.fn(),
  cancelClaudeLogin: vi.fn(),
  logoutClaude: vi.fn(),
  submitClaudeLoginCode: vi.fn(),
  fetchUsageSnapshot: vi.fn(),
  accountUsageEnv: vi.fn(),
  accountViews: vi.fn(),
  beginAddAccount: vi.fn(),
  bindSession: vi.fn(),
  claudeAccountEnv: vi.fn(),
  finishAddAccount: vi.fn(),
  loadAccounts: vi.fn(),
  refreshCooldowns: vi.fn(),
  removeAccount: vi.fn(),
  reorderAccounts: vi.fn(),
  sessionAccount: vi.fn(),
  setRouting: vi.fn(),
  spawnAccountFor: vi.fn(),
  spawnAccountSessions: vi.fn(),
}))
vi.mock('electron', () => ({
  app: state.app,
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: state.send } },
      { isDestroyed: () => true, webContents: { send: state.destroyedSend } },
    ],
  },
}))
vi.mock('./handle', () => ({
  handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
    state.handlers.set(channel, handler),
}))
vi.mock('../pi/claude-login', () => ({
  startClaudeLogin: state.startClaudeLogin,
  cancelClaudeLogin: state.cancelClaudeLogin,
  logoutClaude: state.logoutClaude,
  submitClaudeLoginCode: state.submitClaudeLoginCode,
}))
vi.mock('../claude/usage', () => ({ fetchUsageSnapshot: state.fetchUsageSnapshot }))
vi.mock('../claude/accounts', () => ({
  accountUsageEnv: state.accountUsageEnv,
  accountViews: state.accountViews,
  beginAddAccount: state.beginAddAccount,
  bindSession: state.bindSession,
  claudeAccountEnv: state.claudeAccountEnv,
  finishAddAccount: state.finishAddAccount,
  loadAccounts: state.loadAccounts,
  refreshCooldowns: state.refreshCooldowns,
  removeAccount: state.removeAccount,
  reorderAccounts: state.reorderAccounts,
  sessionAccount: state.sessionAccount,
  setRouting: state.setRouting,
}))
vi.mock('../pi/session-accounts', () => ({
  spawnAccountFor: state.spawnAccountFor,
  spawnAccountSessions: state.spawnAccountSessions,
}))
import { registerClaudeAuthHandlers } from './claude-auth-handlers'

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = state.handlers.get(channel)
  if (!handler) throw new Error(`missing handler: ${channel}`)
  return handler({}, ...args)
}

const account = { id: 'stored', credentialDir: '/credentials/stored' }
const credentialEnv = { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/credentials/stored' }
const usageEnv = { CLAUDE_CONFIG_DIR: '/usage/stored' }

beforeEach(() => {
  vi.resetAllMocks()
  state.app.isPackaged = false
  state.handlers.clear()
  vi.stubEnv('PHOSPHOR_CLAUDE_BIN', '/test/claude')
  state.loadAccounts.mockResolvedValue({ accounts: [account] })
  state.claudeAccountEnv.mockReturnValue(credentialEnv)
  state.accountUsageEnv.mockReturnValue(usageEnv)
  state.beginAddAccount.mockResolvedValue({ id: 'new', env: credentialEnv })
  state.finishAddAccount.mockResolvedValue(undefined)
  registerClaudeAuthHandlers()
})
afterEach(() => vi.unstubAllEnvs())

describe('Claude auth handler executable gate', () => {
  it.each([
    { packaged: true, env: '/test/override', expected: undefined },
    { packaged: false, env: '/test/override', expected: '/test/override' },
    { packaged: false, env: '', expected: undefined },
    { packaged: false, env: undefined, expected: undefined },
  ])('gates every binary consumer for $packaged / $env', async ({ packaged, env, expected }) => {
    state.app.isPackaged = packaged
    vi.stubEnv('PHOSPHOR_CLAUDE_BIN', env)
    await invoke('claude:startLogin')
    expect(state.beginAddAccount).toHaveBeenCalledWith(expected)
    expect(state.startClaudeLogin).toHaveBeenCalledWith(
      expect.any(Function),
      expected,
      credentialEnv,
    )
    await invoke('claude:logout')
    expect(state.logoutClaude).toHaveBeenCalledWith(expected)
    await invoke('claude:accounts')
    expect(state.accountViews).toHaveBeenCalledWith(expected)
    await invoke('claude:removeAccount', 'stored')
    expect(state.removeAccount).toHaveBeenCalledWith('stored', expected)
    await invoke('claude:reorderAccounts', ['stored'])
    expect(state.reorderAccounts).toHaveBeenCalledWith(['stored'], expected)
    await invoke('claude:setRouting', 'specific', 'stored')
    expect(state.setRouting).toHaveBeenCalledWith('specific', 'stored', expected)
    await invoke('claude:refreshAccountUsage')
    expect(state.refreshCooldowns).toHaveBeenCalledWith(expected)
    await invoke('claude:sessionAccount', 'live', '/session.jsonl')
    expect(state.sessionAccount).toHaveBeenCalledWith({
      accountId: undefined,
      sessionPath: '/session.jsonl',
      claudeOverride: expected,
    })
    await invoke('claude:usageSnapshot', 'stored', true)
    expect(state.loadAccounts).toHaveBeenCalledWith(expected)
    expect(state.fetchUsageSnapshot).toHaveBeenCalledWith({
      ...(expected ? { claudeOverride: expected } : {}),
      cacheKey: 'stored',
      extraEnv: usageEnv,
      force: true,
    })
    await invoke('claude:startLogin', 'stored')
    expect(state.startClaudeLogin).toHaveBeenLastCalledWith(
      expect.any(Function),
      expected,
      credentialEnv,
    )
  })

  it('reads the override and packaging anew after registration', async () => {
    await invoke('claude:logout')
    expect(state.logoutClaude).toHaveBeenLastCalledWith('/test/claude')
    vi.stubEnv('PHOSPHOR_CLAUDE_BIN', '/test/changed')
    await invoke('claude:logout')
    expect(state.logoutClaude).toHaveBeenLastCalledWith('/test/changed')
    state.app.isPackaged = true
    await invoke('claude:logout')
    expect(state.logoutClaude).toHaveBeenLastCalledWith(undefined)
  })

  it('keeps credential and usage environments scoped to the selected account', async () => {
    await invoke('claude:startLogin', 'stored')
    expect(state.beginAddAccount).not.toHaveBeenCalled()
    expect(state.claudeAccountEnv).toHaveBeenCalledWith(account)
    expect(state.startClaudeLogin).toHaveBeenCalledWith(
      expect.any(Function),
      '/test/claude',
      credentialEnv,
    )
    await invoke('claude:usageSnapshot', 'stored', true)
    expect(state.accountUsageEnv).toHaveBeenCalledWith(account)
    expect(state.fetchUsageSnapshot).toHaveBeenCalledWith({
      claudeOverride: '/test/claude',
      cacheKey: 'stored',
      extraEnv: usageEnv,
      force: true,
    })
    await invoke('claude:usageSnapshot', 'unknown')
    expect(state.fetchUsageSnapshot).toHaveBeenLastCalledWith({
      claudeOverride: '/test/claude',
      cacheKey: 'unknown',
      extraEnv: {},
    })
    await invoke('claude:startLogin', 'unknown')
    expect(state.claudeAccountEnv).toHaveBeenLastCalledWith(null)
    await invoke('claude:usageSnapshot')
    expect(state.fetchUsageSnapshot).toHaveBeenLastCalledWith({ claudeOverride: '/test/claude' })
  })

  it.each([true, false])(
    'finishes the new account before broadcasting signed-in (packaged: %s)',
    async (packaged) => {
      state.app.isPackaged = packaged
      let finish: (() => void) | undefined
      state.finishAddAccount.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          }),
      )
      await invoke('claude:startLogin')
      const onState: unknown = state.startClaudeLogin.mock.calls[0]?.[0]
      if (typeof onState !== 'function') throw new Error('missing login callback')
      const starting: ClaudeLoginState = { phase: 'starting' }
      onState(starting)
      expect(state.send).toHaveBeenCalledWith('claude:loginState', starting)
      expect(state.finishAddAccount).not.toHaveBeenCalled()
      state.send.mockClear()
      const signedIn: ClaudeLoginState = { phase: 'signed-in', email: 'a@example.test' }
      onState(signedIn)
      expect(state.finishAddAccount).toHaveBeenCalledWith(
        'new',
        packaged ? undefined : '/test/claude',
      )
      expect(state.send).not.toHaveBeenCalled()
      finish?.()
      await vi.waitFor(() => expect(state.send).toHaveBeenCalledWith('claude:loginState', signedIn))
      expect(state.destroyedSend).not.toHaveBeenCalled()
    },
  )

  it('forwards login controls and preserves login and usage errors', async () => {
    await invoke('claude:submitCode', 'code')
    expect(state.submitClaudeLoginCode).toHaveBeenCalledWith('code')
    await invoke('claude:cancelLogin')
    expect(state.cancelClaudeLogin).toHaveBeenCalledOnce()
    const error = new Error('CLI unavailable')
    state.startClaudeLogin.mockRejectedValueOnce(error)
    await expect(invoke('claude:startLogin')).rejects.toBe(error)
    state.fetchUsageSnapshot.mockRejectedValueOnce(error)
    await expect(invoke('claude:usageSnapshot', 'stored')).rejects.toBe(error)
    state.loadAccounts.mockRejectedValueOnce(error)
    await expect(invoke('claude:startLogin', 'stored')).rejects.toBe(error)
    state.logoutClaude.mockRejectedValueOnce(error)
    await expect(invoke('claude:logout')).rejects.toBe(error)
  })

  it('preserves account results and refresh ordering', async () => {
    const result = { prefs: { accounts: [] }, views: [] }
    state.accountViews.mockReturnValue(result)
    expect(await invoke('claude:accounts')).toBe(result)
    expect(await invoke('claude:refreshAccountUsage')).toBe(result)
    expect(state.refreshCooldowns.mock.invocationCallOrder[0]).toBeLessThan(
      state.accountViews.mock.invocationCallOrder[1]!,
    )
    const snapshot = { fetchedAt: 123 }
    state.fetchUsageSnapshot.mockResolvedValue(snapshot)
    expect(await invoke('claude:usageSnapshot')).toBe(snapshot)
    const error = new Error('refresh failed')
    state.refreshCooldowns.mockRejectedValueOnce(error)
    await expect(invoke('claude:refreshAccountUsage')).rejects.toBe(error)
    expect(state.accountViews).toHaveBeenCalledTimes(2)
  })
})
