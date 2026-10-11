import { describe, expect, it, vi } from 'vitest'
import { accountView } from './view'
import { USER } from './__fixtures__/fakes'

describe('accountView', () => {
  it('passes a signed-out or signing-in state through with the preview flag', () => {
    const storage = vi.fn()
    expect(accountView({ status: 'signed-out', error: 'x' }, true, storage)).toEqual({
      preview: true,
      account: { status: 'signed-out', error: 'x' },
    })
    expect(accountView({ status: 'signing-in' }, false, storage)).toEqual({
      preview: false,
      account: { status: 'signing-in' },
    })
    expect(storage).not.toHaveBeenCalled()
  })

  it('hands the renderer who is signed in, never the account id', () => {
    const storage = vi.fn()
    const view = accountView({ status: 'signed-in', user: USER, remembered: true }, true, storage)
    expect(view.account).toEqual({
      status: 'signed-in',
      user: { login: 'octo', name: 'Octo Cat', email: 'octo@example.com' },
      remembered: true,
    })
    expect(JSON.stringify(view)).not.toContain(USER.id)
    // Opening Settings must not wake the keychain.
    expect(storage).not.toHaveBeenCalled()
  })

  it('says why a sign-in is not remembered', () => {
    const state = { status: 'signed-in', user: USER, remembered: false } as const
    const none = accountView(state, true, () => ({ ok: false, reason: 'no keyring is running' }))
    expect(none.account).toMatchObject({ remembered: false, storageNote: 'no keyring is running' })
    const failed = accountView(state, true, () => ({ ok: true, kind: 'keychain' }))
    expect(failed.account).toMatchObject({ storageNote: 'the sign-in could not be saved' })
  })
})
