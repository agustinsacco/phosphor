import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { AccountPorts } from './account'
import { createAccountRuntimeState } from './account-state'
import { createGoTrue, type AuthSession, type GoTrue } from './gotrue'
import { cancel, signIn } from './sign-in'
import type { Vault } from './vault'
import { deferred, fakeBrowser, session, USER } from './__fixtures__/fakes'

function setup(browser = fakeBrowser()) {
  const state = createAccountRuntimeState()
  const auth = {
    ...createGoTrue({ url: 'https://auth.test', key: 'test' }),
    exchange: vi.fn<GoTrue['exchange']>(async () => session(1)),
    revoke: vi.fn<GoTrue['revoke']>(async () => {}),
  }
  const vault: Vault = {
    storage: () => ({ ok: true, kind: 'test' }),
    savedMode: () => null,
    readProfile: () => null,
    readToken: async () => {
      throw new Error('no token')
    },
    save: vi.fn(async () => true),
    clear: vi.fn(),
  }
  const ports: AccountPorts = {
    auth,
    vault,
    openExternal: browser.open,
    onChange: vi.fn(),
    log: vi.fn(),
  }
  return { state, ports, auth, browser, vault }
}

describe('signIn', () => {
  it('uses PKCE and holds the callback page until the exchange completes', async () => {
    const { state, ports, auth, browser, vault } = setup()
    const exchanged = deferred<AuthSession>()
    auth.exchange.mockReturnValueOnce(exchanged.promise)
    const flow = signIn(state, ports)
    expect(signIn(state, ports)).toBe(flow)
    await vi.waitFor(() => expect(auth.exchange).toHaveBeenCalledOnce())
    const [code, verifier, signal] = auth.exchange.mock.calls[0]!
    expect(code).toBe('valid-code-1')
    expect(signal).toBeUndefined()
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
      browser.opened[0]!.searchParams.get('code_challenge'),
    )
    let answered = false
    void browser.pages[0]!.then(() => {
      answered = true
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(answered).toBe(false)
    expect(state.current).toEqual({ status: 'signing-in' })
    exchanged.resolve(session(1))
    expect(await flow).toEqual({ status: 'signed-in', user: USER, remembered: true })
    expect((await browser.pages[0]!).body).toContain('Signed in as @octo')
    expect(vault.save).toHaveBeenCalledWith(USER, 'refresh-1', expect.any(Function))
    expect(state.signing).toBeNull()
    expect(browser.opened).toHaveLength(1)
    expect(await signIn(state, ports)).toBe(state.current)
  })

  it('answers a held callback immediately on cancel and revokes a late exchange', async () => {
    const { state, ports, auth, browser, vault } = setup()
    const exchanged = deferred<AuthSession>()
    auth.exchange.mockReturnValueOnce(exchanged.promise)
    const flow = signIn(state, ports)
    await vi.waitFor(() => expect(auth.exchange).toHaveBeenCalledOnce())
    cancel(state, ports)
    expect(state.generation).toBe(2)
    expect(state.signing).toBeNull()
    expect((await browser.pages[0]!).body).toContain('Sign-in cancelled')
    exchanged.resolve(session(1))
    expect(await flow).toEqual({ status: 'signed-out' })
    expect(auth.revoke).toHaveBeenCalledWith('access-1', expect.any(AbortSignal))
    expect(vault.save).not.toHaveBeenCalled()
  })

  it('revokes, and never shows signed in, when cancelled while the save waits on the keychain', async () => {
    const { state, ports, auth, browser, vault } = setup()
    const saving = deferred<boolean>()
    vi.mocked(vault.save).mockReturnValueOnce(saving.promise)
    const flow = signIn(state, ports)
    await vi.waitFor(() => expect(vault.save).toHaveBeenCalledOnce())
    const current = vi.mocked(vault.save).mock.calls[0]![2]!
    expect(current()).toBe(true)
    cancel(state, ports)
    expect(current()).toBe(false)
    saving.resolve(false)
    expect(await flow).toEqual({ status: 'signed-out' })
    expect(state.session).toBeNull()
    expect((await browser.pages[0]!).body).toContain('Sign-in cancelled')
    expect(auth.revoke).toHaveBeenCalledWith('access-1', expect.any(AbortSignal))
    expect(ports.onChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'signed-in' }),
    )
  })

  it('does not let an old cancelled flow clear the next sign-in or borrow its trace', async () => {
    const { state, ports, auth, browser } = setup()
    const exchanged = deferred<AuthSession>()
    auth.exchange.mockReturnValueOnce(exchanged.promise)
    const first = signIn(state, ports)
    await vi.waitFor(() => expect(auth.exchange).toHaveBeenCalledOnce())
    const oldTrace = state.trace
    cancel(state, ports)
    await browser.pages[0]
    const opening = deferred<void>()
    const second = signIn(state, { ...ports, openExternal: () => opening.promise })
    const newTrace = state.trace
    expect(newTrace).not.toBe(oldTrace)
    exchanged.resolve(session(1))
    await first
    expect(state.signing?.promise).toBe(second)
    cancel(state, ports)
    opening.resolve()
    expect(await second).toEqual({ status: 'signed-out' })
    expect(ports.log).toHaveBeenCalledWith(`sign-in.started {"trace":"${oldTrace}"}`)
    expect(ports.log).toHaveBeenCalledWith(`sign-in.started {"trace":"${newTrace}"}`)
    expect(state.signing).toBeNull()
  })

  it('reports a denied callback without exchanging or persisting a session', async () => {
    const { state, ports, auth, browser, vault } = setup(
      fakeBrowser(() => 'error=access_denied&error_code=signup_disabled'),
    )
    expect(await signIn(state, ports)).toEqual({
      status: 'signed-out',
      error: 'GitHub sign-in did not finish: signup_disabled',
    })
    expect((await browser.pages[0]!).body).toContain('Sign-in cancelled')
    expect(auth.exchange).not.toHaveBeenCalled()
    expect(vault.save).not.toHaveBeenCalled()
    expect(state.signing).toBeNull()
  })

  it('reports browser failures and leaves cancel idle when no flow is running', async () => {
    const { state, ports, auth } = setup()
    expect(
      await signIn(state, {
        ...ports,
        openExternal: async () => {
          throw new Error('browser unavailable')
        },
      }),
    ).toEqual({ status: 'signed-out', error: 'Sign-in failed: browser unavailable' })
    expect(auth.exchange).not.toHaveBeenCalled()
    const generation = state.generation
    cancel(state, ports)
    expect(state.generation).toBe(generation)
  })
})
