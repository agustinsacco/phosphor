import { describe, expect, it, vi } from 'vitest'
import type { AccountPorts } from './account'
import {
  createAccountRuntimeState,
  event,
  forget,
  keep,
  loadAccount,
  reasonClass,
  setAccountState,
  track,
  userFields,
} from './account-state'
import { AuthRefused, AuthUnavailable, createGoTrue } from './gotrue'
import type { Vault } from './vault'
import { deferred, session, USER } from './__fixtures__/fakes'

function setup() {
  const state = createAccountRuntimeState()
  const vault = {
    storage: vi.fn<Vault['storage']>(() => ({ ok: true, kind: 'test' })),
    savedMode: vi.fn<Vault['savedMode']>(() => 'keyring'),
    readProfile: vi.fn<Vault['readProfile']>(() => USER),
    readToken: vi.fn<Vault['readToken']>(async () => 'refresh-0'),
    save: vi.fn<Vault['save']>(async () => true),
    clear: vi.fn<Vault['clear']>(),
  }
  const ports: AccountPorts = {
    auth: createGoTrue({ url: 'https://auth.test', key: 'test' }),
    vault,
    openExternal: async () => {},
    onChange: vi.fn(),
    log: vi.fn(),
  }
  return { state, ports, vault }
}

describe('AccountRuntimeState', () => {
  it('keeps each account independent and publishes state before invoking onChange', () => {
    const { state, ports } = setup()
    const other = createAccountRuntimeState()
    const next = { status: 'signing-in' } as const
    const onChange = vi.fn(() => expect(state.current).toBe(next))
    expect(setAccountState(state, { ...ports, onChange }, next)).toBe(next)
    expect(onChange).toHaveBeenCalledOnce()
    expect(other.current).toEqual({ status: 'signed-out' })
    expect(other.inFlight).not.toBe(state.inFlight)
  })

  it('increments generation and discards the held session before clearing or notifying', async () => {
    const { state, ports, vault } = setup()
    await keep(state, ports, session(1), state.generation)
    vault.clear.mockImplementation(() => {
      expect(state.generation).toBe(1)
      expect(state.session).toBeNull()
    })
    expect(forget(state, ports)).toEqual({ status: 'signed-out' })
    vault.clear.mockReset()
    expect(forget(state, ports)).toEqual({ status: 'signed-out' })
    expect(state.generation).toBe(2)
    expect(ports.onChange).toHaveBeenCalledTimes(2)
  })

  it('reports clear failures while still invalidating the session', async () => {
    const { state, ports, vault } = setup()
    await keep(state, ports, session(1), state.generation)
    vault.clear.mockImplementation(() => {
      throw new Error('profile busy')
    })
    expect(forget(state, ports, 'Session ended.')).toEqual({
      status: 'signed-out',
      error: 'Session ended. The saved sign-in could not be deleted (profile busy).',
    })
    expect(state.session).toBeNull()
    expect(state.generation).toBe(1)
    expect(ports.log).toHaveBeenCalledWith(
      'could not delete the saved sign-in {"trace":"","reason":"Error"}',
    )
  })

  it('retains memory-only sessions when storage is disabled or saving and clearing both fail', async () => {
    const { state, ports, vault } = setup()
    vault.save.mockResolvedValueOnce(false)
    const first = session(1)
    expect(await keep(state, ports, first, state.generation)).toBe(false)
    expect(state.session).toBe(first)
    expect(vault.clear).not.toHaveBeenCalled()
    vault.save.mockRejectedValue(new Error('refresh-secret'))
    vault.clear.mockImplementation(() => {
      throw new Error('access-secret')
    })
    const second = session(2)
    expect(await keep(state, ports, second, state.generation)).toBe(false)
    expect(state.session).toBe(second)
    expect(vault.clear).toHaveBeenCalledOnce()
    expect(ports.log).toHaveBeenCalledExactlyOnceWith(
      'could not save the sign-in {"trace":"","reason":"Error"}',
    )
  })

  it('writes nothing and reports nothing when a sign-out lands while the keychain is busy', async () => {
    const { state, ports, vault } = setup()
    const answer = deferred<boolean>()
    let current: (() => boolean) | undefined
    vault.save.mockImplementation((_user, _token, stillCurrent) => {
      current = stillCurrent
      return answer.promise
    })
    const fresh = session(1)
    const kept = keep(state, ports, fresh, state.generation)
    // Held at once, so a sign-out during the prompt finds it and revokes it.
    expect(state.session).toBe(fresh)
    expect(current?.()).toBe(true)
    forget(state, ports)
    expect(current?.()).toBe(false)
    answer.reject(new Error('keychain denied'))
    expect(await kept).toBe(false)
    expect(vault.clear).toHaveBeenCalledOnce()
    expect(ports.log).not.toHaveBeenCalled()
  })

  it('loads a profile without reading credentials, and forgets when there is no profile', () => {
    const { state, ports, vault } = setup()
    expect(loadAccount(state, ports)).toEqual({ status: 'signed-in', user: USER, remembered: true })
    expect(vault.readToken).not.toHaveBeenCalled()
    expect(state.session).toBeNull()
    vault.readProfile.mockReturnValueOnce(null)
    expect(loadAccount(state, ports)).toEqual({ status: 'signed-out' })
    expect(state.generation).toBe(1)
    expect(vault.clear).toHaveBeenCalledOnce()
  })

  it('tracks original promises and removes both fulfilled and rejected work', async () => {
    const { state } = setup()
    const success = deferred<string>()
    const failure = deferred<void>()
    expect(track(state, success.promise)).toBe(success.promise)
    expect(track(state, failure.promise)).toBe(failure.promise)
    expect(state.inFlight.size).toBe(2)
    success.resolve('done')
    expect(await success.promise).toBe('done')
    expect(state.inFlight.size).toBe(1)
    failure.reject(new Error('failed'))
    await expect(failure.promise).rejects.toThrow('failed')
    expect(state.inFlight.size).toBe(0)
  })

  it('logs only sanitized user fields and error classes with the operation trace', () => {
    const { state, ports } = setup()
    state.trace = 'current'
    event(
      state,
      ports,
      'finished',
      userFields({ ...USER, id: 'access-secret', login: 'refresh-secret!' }),
      'original',
    )
    expect(ports.log).toHaveBeenLastCalledWith(
      'finished {"trace":"original","userId":null,"login":null}',
    )
    expect(userFields(USER)).toEqual({ userId: USER.id, login: 'octo' })
    expect(reasonClass(new AuthRefused(400, 'denied', 'secret'))).toBe('AuthRefused')
    expect(reasonClass(new AuthUnavailable('secret'))).toBe('AuthUnavailable')
    expect(reasonClass('secret')).toBe('Error')
  })
})
