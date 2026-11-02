import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAccount, type AccountPorts, type AccountState } from './account'
import { AuthUnavailable, type AuthSession, type GoTrue } from './gotrue'
import type { CallbackListener } from './loopback'
import type { Vault } from './vault'
import { deferred, flush, session, USER } from './__fixtures__/fakes'

const { listen } = vi.hoisted(() => ({ listen: vi.fn() }))
vi.mock('./loopback', () => ({ listenForCallback: listen }))

function callback(): CallbackListener {
  return {
    url: 'http://127.0.0.1:1234/auth/callback/nonce',
    outcome: Promise.resolve({ kind: 'code', code: 'valid-code-1' }),
    finish: vi.fn(),
    close: vi.fn(),
  }
}

function setup(overrides: Partial<AccountPorts> = {}) {
  const auth = {
    authorizeUrl: vi.fn<GoTrue['authorizeUrl']>(() => 'https://auth.test/authorize'),
    exchange: vi.fn<GoTrue['exchange']>(async () => session(1)),
    refresh: vi.fn<GoTrue['refresh']>(async () => session(2)),
    revoke: vi.fn<GoTrue['revoke']>(async () => {}),
  }
  const vault = {
    storage: vi.fn<Vault['storage']>(() => ({ ok: true, kind: 'test' })),
    savedMode: vi.fn<Vault['savedMode']>(() => 'keyring'),
    readProfile: vi.fn<Vault['readProfile']>(() => USER),
    readToken: vi.fn<Vault['readToken']>(async () => 'refresh-0'),
    save: vi.fn<Vault['save']>(async () => true),
    clear: vi.fn<Vault['clear']>(),
  }
  const onChange = vi.fn<AccountPorts['onChange']>()
  const log = vi.fn<AccountPorts['log']>()
  const openExternal = vi.fn<AccountPorts['openExternal']>(async () => {})
  const account = createAccount({ auth, vault, onChange, log, openExternal, ...overrides })
  return { account, auth, vault, onChange, log, openExternal }
}

beforeEach(() => {
  listen.mockReset()
  listen.mockImplementation(async () => callback())
})

describe('account lifecycle characterization through createAccount', () => {
  it('cancels before listen completes without opening a browser or exchanging', async () => {
    const listening = deferred<CallbackListener>()
    listen.mockReturnValueOnce(listening.promise)
    const { account, openExternal, auth, onChange } = setup()
    const flow = account.signIn()
    account.cancel()
    const listener = callback()
    listening.resolve(listener)
    expect(await flow).toEqual({ status: 'signed-out' })
    expect(openExternal).not.toHaveBeenCalled()
    expect(auth.exchange).not.toHaveBeenCalled()
    expect(listener.close).toHaveBeenCalledOnce()
    expect(onChange.mock.calls.map(([state]) => state.status)).toEqual(['signing-in', 'signed-out'])
  })

  it('cancels before exchange while browser opening is still pending', async () => {
    const opening = deferred<void>()
    const openExternal = vi.fn(() => opening.promise)
    const { account, auth } = setup({ openExternal })
    const flow = account.signIn()
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledOnce())
    account.cancel()
    opening.resolve()
    expect(await flow).toEqual({ status: 'signed-out' })
    expect(auth.exchange).not.toHaveBeenCalled()
    expect(openExternal).toHaveBeenCalledOnce()
  })

  it('revokes a stale exchange instead of saving or restoring it', async () => {
    const exchanged = deferred<AuthSession>()
    const { account, auth, vault } = setup()
    auth.exchange.mockReturnValueOnce(exchanged.promise)
    const flow = account.signIn()
    await vi.waitFor(() => expect(auth.exchange).toHaveBeenCalledOnce())
    expect(auth.exchange.mock.calls[0]).toHaveLength(2)
    account.cancel()
    exchanged.resolve(session(1))
    expect(await flow).toEqual({ status: 'signed-out' })
    expect(auth.revoke).toHaveBeenCalledWith('access-1', expect.any(AbortSignal))
    expect(vault.save).not.toHaveBeenCalled()
    expect(account.state()).toEqual({ status: 'signed-out' })
    expect(await account.settled()).toBe(true)
  })

  it('shares one refresh between concurrent callers and saves the rotated token', async () => {
    const refreshed = deferred<AuthSession>()
    const { account, auth, vault } = setup()
    auth.refresh.mockReturnValueOnce(refreshed.promise)
    account.load()
    const tokens = [account.accessToken(), account.accessToken(), account.accessToken()]
    // The saved token is decrypted asynchronously (a Keychain prompt never blocks main).
    await flush()
    expect(auth.refresh.mock.calls).toEqual([['refresh-0']])
    refreshed.resolve(session(2))
    expect(await Promise.all(tokens)).toEqual(['access-2', 'access-2', 'access-2'])
    expect(vault.save.mock.calls).toEqual([[USER, 'refresh-2', expect.any(Function)]])
    expect(account.state()).toEqual({ status: 'signed-in', user: USER, remembered: true })
  })

  it('revokes the landed refresh during reentrant onChange without releasing its access token', async () => {
    let loaded = false
    let out: Promise<AccountState> | undefined
    const made = setup({
      onChange(state) {
        if (loaded && state.status === 'signed-in') out = made.account.signOut()
      },
    })
    made.account.load()
    loaded = true
    expect(await made.account.accessToken()).toBeNull()
    expect(await out).toEqual({ status: 'signed-out' })
    expect(made.auth.refresh.mock.calls).toEqual([['refresh-0']])
    expect(made.auth.revoke.mock.calls.map(([token]) => token)).toEqual(['access-2'])
    expect(made.vault.clear).toHaveBeenCalledOnce()
    expect(made.account.state()).toEqual({ status: 'signed-out' })
  })

  it('keeps a session in memory after a save failure and attempts to clear stale storage', async () => {
    const { account, auth, vault, log } = setup()
    vault.save.mockImplementation(() => {
      throw new Error('refresh-secret save failed')
    })
    vault.clear.mockImplementation(() => {
      throw new Error('refresh-secret clear failed')
    })
    expect(await account.signIn()).toEqual({ status: 'signed-in', user: USER, remembered: false })
    expect(await account.accessToken()).toBe('access-1')
    expect(auth.refresh).not.toHaveBeenCalled()
    expect(vault.clear).toHaveBeenCalledOnce()
    expect(log.mock.calls.flat().join('\n')).toContain('could not save the sign-in')
    expect(log.mock.calls.flat().join('\n')).not.toContain('refresh-secret')
    expect(await account.signOut()).toEqual({
      status: 'signed-out',
      error:
        'Signed out, but: The saved sign-in could not be deleted (refresh-secret clear failed).',
    })
    expect(auth.revoke.mock.calls.map(([token]) => token)).toEqual(['access-1'])
  })

  it('forgets unreadable storage without starting a refresh', async () => {
    const { account, auth, vault } = setup()
    account.load()
    vault.readToken.mockImplementation(() => {
      throw new Error('keyring locked')
    })
    expect(await account.accessToken()).toBeNull()
    expect(auth.refresh).not.toHaveBeenCalled()
    expect(vault.clear).toHaveBeenCalledOnce()
    expect(account.state()).toEqual({
      status: 'signed-out',
      error: 'The saved sign-in could not be read (keyring locked). Sign in again.',
    })
  })

  it('bounds quit and drains a revoke newly started by a stale refresh', async () => {
    const refreshed = deferred<AuthSession>()
    const revoked = deferred<void>()
    const { account, auth } = setup()
    auth.refresh.mockReturnValueOnce(refreshed.promise)
    auth.revoke.mockReturnValueOnce(revoked.promise)
    account.load()
    const token = account.accessToken()
    await flush() // until the refresh reaches Supabase
    await account.signOut()
    const drain = account.settled(2_000)
    expect(await account.settled(5)).toBe(false)
    refreshed.resolve(session(2))
    expect(await token).toBeNull()
    expect(auth.revoke.mock.calls.map(([value]) => value)).toEqual(['access-2'])
    expect(await account.settled(5)).toBe(false)
    revoked.resolve()
    expect(await drain).toBe(true)
  })

  it('logs only trace, sanitized user fields and failure classes, never credentials or exception text', async () => {
    const { account, auth, log, onChange } = setup({ now: () => Date.now() + 3_600_000 })
    await account.signIn()
    auth.refresh.mockRejectedValueOnce(new AuthUnavailable('refresh-secret valid-code-secret'))
    await expect(account.accessToken()).rejects.toBeInstanceOf(AuthUnavailable)
    await account.signOut()
    const text = log.mock.calls.flat().join('\n')
    expect(text).toContain('sign-in.started')
    expect(text).toContain('sign-in.finished')
    expect(text).toContain('"reason":"AuthUnavailable"')
    expect(text).toContain(USER.id)
    expect(text).toContain('"login":"octo"')
    const traces = log.mock.calls.map(
      ([line]) => JSON.parse(line.slice(line.indexOf('{'))) as { trace: string },
    )
    expect(traces.every(({ trace }) => /^[0-9a-f]{16}$/.test(trace))).toBe(true)
    expect(new Set(traces.map(({ trace }) => trace)).size).toBe(1)
    expect(text).not.toMatch(/access-|refresh-|valid-code-|octo@example/)
    expect(JSON.stringify(onChange.mock.calls)).not.toMatch(/access-|refresh-/)
  })
})
