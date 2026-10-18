import { describe, expect, it, vi } from 'vitest'
import type { AccountPorts, AccountState } from './account'
import {
  createAccountRuntimeState,
  EARLY_MS,
  keep,
  loadAccount,
  REVOKE_MS,
  track,
} from './account-state'
import { AuthRefused, AuthUnavailable, createGoTrue, type AuthSession, type GoTrue } from './gotrue'
import { accessToken, refresh, revoke, settled, signOut } from './session-refresh'
import type { Vault } from './vault'
import { deferred, session, USER } from './__fixtures__/fakes'

function setup() {
  const state = createAccountRuntimeState()
  const auth = {
    ...createGoTrue({ url: 'https://auth.test', key: 'test' }),
    refresh: vi.fn<GoTrue['refresh']>(async () => session(1)),
    revoke: vi.fn<GoTrue['revoke']>(async () => {}),
  }
  const vault: Vault = {
    storage: () => ({ ok: true, kind: 'test' }),
    savedMode: () => 'keyring',
    readProfile: () => USER,
    readToken: vi.fn(() => 'refresh-0'),
    save: vi.fn(() => true),
    clear: vi.fn(),
  }
  const ports: AccountPorts = {
    auth,
    vault,
    openExternal: async () => {},
    onChange: vi.fn(),
    log: vi.fn(),
  }
  const now = () => 1_000_000
  return { state, ports, auth, vault, now }
}

describe('session refresh and revocation', () => {
  it('shares one pending refresh and clears its slot after landing', async () => {
    const { state, ports, auth, vault } = setup()
    loadAccount(state, ports)
    const refreshed = deferred<AuthSession>()
    auth.refresh.mockReturnValueOnce(refreshed.promise)
    const first = refresh(state, ports)
    expect(refresh(state, ports)).toBe(first)
    expect(auth.refresh.mock.calls).toEqual([['refresh-0']])
    const fresh = session(1)
    refreshed.resolve(fresh)
    expect(await first).toBe(fresh)
    expect(state.refreshing).toBeNull()
    expect(state.session).toBe(fresh)
    expect(vault.save).toHaveBeenCalledWith(USER, 'refresh-1')
  })

  it('revokes a late refresh and includes that new revoke in the bounded drain', async () => {
    const { state, ports, auth, vault, now } = setup()
    const refreshed = deferred<AuthSession>()
    const revoked = deferred<void>()
    auth.refresh.mockReturnValueOnce(refreshed.promise)
    auth.revoke.mockReturnValueOnce(revoked.promise)
    loadAccount(state, ports)
    const token = accessToken(state, ports, now)
    expect(await signOut(state, ports, now)).toEqual({ status: 'signed-out' })
    const drain = settled(state, 2_000)
    expect(await settled(state, 5)).toBe(false)
    refreshed.resolve(session(1))
    expect(await token).toBeNull()
    expect(state.session).toBeNull()
    expect(vault.save).not.toHaveBeenCalled()
    expect(auth.revoke.mock.calls.map(([value]) => value)).toEqual(['access-1'])
    expect(await settled(state, 5)).toBe(false)
    revoked.resolve()
    expect(await drain).toBe(true)
    expect(state.inFlight.size).toBe(0)
  })

  it('clears the refresh slot before reentrant sign-out refreshes a too-short landed token', async () => {
    const { state, ports, auth, now } = setup()
    loadAccount(state, ports)
    auth.refresh.mockResolvedValueOnce(session(1, now() + REVOKE_MS))
    auth.refresh.mockResolvedValueOnce(session(2))
    let out: Promise<AccountState> | undefined
    const reentrant: AccountPorts = {
      ...ports,
      onChange(next) {
        if (next.status !== 'signed-in') return
        expect(state.refreshing).toBeNull()
        expect(state.session?.refreshToken).toBe('refresh-1')
        out = signOut(state, ports, now)
      },
    }
    expect(await accessToken(state, reentrant, now)).toBeNull()
    expect(await out).toEqual({ status: 'signed-out' })
    expect(auth.refresh.mock.calls.map(([token]) => token)).toEqual(['refresh-0', 'refresh-1'])
    expect(auth.revoke.mock.calls.map(([token]) => token)).toEqual(['access-2'])
    expect(state.session).toBeNull()
  })

  it('uses a token only above the early expiry boundary, then refreshes from memory', async () => {
    const { state, ports, auth, vault, now } = setup()
    expect(await accessToken(state, ports, now)).toBeNull()
    loadAccount(state, ports)
    keep(state, ports, session(1, now() + EARLY_MS + 1))
    expect(await accessToken(state, ports, now)).toBe('access-1')
    expect(auth.refresh).not.toHaveBeenCalled()
    keep(state, ports, session(1, now() + EARLY_MS))
    auth.refresh.mockResolvedValueOnce(session(2))
    expect(await accessToken(state, ports, now)).toBe('access-2')
    expect(auth.refresh.mock.calls).toEqual([['refresh-1']])
    expect(vault.readToken).not.toHaveBeenCalled()
  })

  it('revokes a held usable token even while another refresh owns a possible late token', async () => {
    const { state, ports, auth, now } = setup()
    loadAccount(state, ports)
    keep(state, ports, session(1, now() + EARLY_MS / 2))
    const refreshed = deferred<AuthSession>()
    auth.refresh.mockReturnValueOnce(refreshed.promise)
    const token = accessToken(state, ports, now)
    await signOut(state, ports, now)
    expect(auth.revoke.mock.calls.map(([value]) => value)).toEqual(['access-1'])
    refreshed.resolve(session(2))
    expect(await token).toBeNull()
    expect(auth.revoke.mock.calls.map(([value]) => value)).toEqual(['access-1', 'access-2'])
    expect(await settled(state)).toBe(true)
  })

  it('forgets a refused refresh without releasing a token', async () => {
    const { state, ports, auth, vault, now } = setup()
    loadAccount(state, ports)
    auth.refresh.mockRejectedValueOnce(new AuthRefused(400, 'expired', 'refresh-secret'))
    expect(await accessToken(state, ports, now)).toBeNull()
    expect(state.current).toEqual({
      status: 'signed-out',
      error: 'Your Phosphor session ended. Sign in again.',
    })
    expect(state.generation).toBe(1)
    expect(state.refreshing).toBeNull()
    expect(vault.clear).toHaveBeenCalledOnce()
    expect(ports.log).not.toHaveBeenCalledWith(expect.stringContaining('refresh-secret'))
  })

  it('preserves remembered state on unavailable refresh and allows a later retry', async () => {
    const { state, ports, auth, vault, now } = setup()
    loadAccount(state, ports)
    auth.refresh.mockRejectedValueOnce(new AuthUnavailable('offline'))
    await expect(accessToken(state, ports, now)).rejects.toThrow(AuthUnavailable)
    expect(state.refreshing).toBeNull()
    expect(state.current.status).toBe('signed-in')
    expect(vault.clear).not.toHaveBeenCalled()
    expect(await accessToken(state, ports, now)).toBe('access-1')
    expect(auth.refresh).toHaveBeenCalledTimes(2)
  })

  it('refreshes a remembered session for sign-out with one bounded signal and never saves it', async () => {
    const { state, ports, auth, vault, now } = setup()
    loadAccount(state, ports)
    expect(await signOut(state, ports, now)).toEqual({ status: 'signed-out' })
    const [token, signal] = auth.refresh.mock.calls[0]!
    expect(token).toBe('refresh-0')
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(auth.revoke).toHaveBeenCalledWith('access-1', signal)
    expect(vault.save).not.toHaveBeenCalled()
    expect(vault.clear).toHaveBeenCalledOnce()
    expect(state.inFlight.size).toBe(0)
  })

  it('drains rejected tracked work and catches revoke failures without logging exception text', async () => {
    const { state, ports, auth } = setup()
    expect(await settled(state)).toBe(true)
    const request = deferred<void>()
    void track(state, request.promise)
    const drain = settled(state)
    request.reject(new Error('offline'))
    expect(await drain).toBe(true)
    auth.revoke.mockRejectedValueOnce(new Error('access-secret'))
    await revoke(state, ports, 'access-1')
    expect(await settled(state)).toBe(true)
    expect(ports.log).toHaveBeenCalledExactlyOnceWith(
      'could not revoke a session {"trace":"","reason":"Error"}',
    )
  })
})
