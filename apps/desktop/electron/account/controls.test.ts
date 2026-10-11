import { describe, expect, it, vi } from 'vitest'
import type { AccountView } from '@shared/account'
import type { Account, AccountState } from './account'
import { createAccountControls } from './controls'
import { deferred, USER } from './__fixtures__/fakes'

const SIGNED_IN: AccountState = { status: 'signed-in', user: USER, remembered: true }

function harness(options: { preview?: boolean; built?: boolean } = {}) {
  const prefs = { preview: options.preview ?? true }
  let state: AccountState = SIGNED_IN
  let built = options.built ?? false
  let broken: Error | null = null
  const signOut = deferred<AccountState>()
  const account: Account = {
    state: () => state,
    load: () => state,
    signIn: vi.fn(async () => state),
    cancel: vi.fn(),
    // Like the real one: local first, then it waits on Supabase.
    signOut: vi.fn(() => {
      state = { status: 'signed-out' }
      return signOut.promise.then((out) => (state = out))
    }),
    accessToken: async () => null,
    settled: async () => true,
  }
  const build = vi.fn(() => {
    if (broken) throw broken
    built = true
    return account
  })
  const published: AccountView[] = []
  const controls = createAccountControls({
    account: build,
    isBuilt: () => built,
    getPreview: () => prefs.preview,
    setPreview: (on) => (prefs.preview = on),
    view: (s) => ({ preview: prefs.preview, account: s as AccountView['account'] }),
    publish: (view) => published.push(view),
  })
  return {
    controls,
    account,
    build,
    prefs,
    published,
    signOut,
    breakConfig: (error: Error | null) => (broken = error),
  }
}

describe('account controls', () => {
  it('reads nothing while the preview is off and nothing is built', () => {
    const h = harness({ preview: false })
    expect(h.controls.snapshot()).toEqual({ preview: false, account: { status: 'signed-out' } })
    expect(h.build).not.toHaveBeenCalled()
    // Once built, its state is the truth even with the preview off.
    expect(harness({ preview: false, built: true }).controls.snapshot().account).toBe(SIGNED_IN)
    expect(harness().controls.snapshot()).toEqual({ preview: true, account: SIGNED_IN })
  })

  it('refuses a sign-in while the preview is off, without building anything', () => {
    const off = harness({ preview: false })
    expect(() => off.controls.signIn()).toThrow(/turn it on in Settings/)
    expect(off.build).not.toHaveBeenCalled()
    const on = harness()
    expect(on.controls.signIn()).toEqual({ preview: true, account: SIGNED_IN })
    expect(on.account.signIn).toHaveBeenCalledOnce()
  })

  it('closes sign-in before the sign-out waits on Supabase, and queues a change behind it', async () => {
    const h = harness()
    const disable = h.controls.setPreview(false)
    await vi.waitFor(() => expect(h.account.signOut).toHaveBeenCalledOnce())
    // Revocation still pending: another window cannot start a sign-in.
    expect(h.prefs.preview).toBe(false)
    expect(() => h.controls.signIn()).toThrow(/turn it on in Settings/)
    expect(h.account.signIn).not.toHaveBeenCalled()
    // Nor can it turn the preview back on underneath the sign-out.
    const enable = h.controls.setPreview(true)
    await Promise.resolve()
    expect(h.prefs.preview).toBe(false)

    h.signOut.resolve({ status: 'signed-out' })
    expect(await disable).toEqual({ preview: false, account: { status: 'signed-out' } })
    expect(await enable).toEqual({ preview: true, account: { status: 'signed-out' } })
    expect(h.published.map((view) => view.preview)).toEqual([false, true])
  })

  it('keeps the preview on when the saved sign-in could not be deleted', async () => {
    const h = harness()
    const error = 'Signed out, but: The saved sign-in could not be deleted (EACCES).'
    h.signOut.resolve({ status: 'signed-out', error })
    await expect(h.controls.setPreview(false)).rejects.toThrow(
      `${error} The preview stays on so you can try again.`,
    )
    expect(h.prefs.preview).toBe(true)
    expect(h.published).toEqual([{ preview: true, account: { status: 'signed-out', error } }])
  })

  it('changes nothing when the account cannot be built, and takes the next change', async () => {
    const h = harness({ preview: false })
    h.breakConfig(new Error('PHOSPHOR_SUPABASE_URL needs PHOSPHOR_SUPABASE_KEY'))
    await expect(h.controls.setPreview(true)).rejects.toThrow(/needs PHOSPHOR_SUPABASE_KEY/)
    expect(h.prefs.preview).toBe(false)
    expect(h.published).toEqual([])
    h.breakConfig(null)
    expect(await h.controls.setPreview(true)).toEqual({ preview: true, account: SIGNED_IN })
    expect(h.published).toEqual([{ preview: true, account: SIGNED_IN }])
  })
})
