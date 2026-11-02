import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createVault } from './vault'
import { fakeCipher } from './__fixtures__/fakes'
import { describe, expect, it, vi } from 'vitest'
import { accountView } from './view'
import { USER } from './__fixtures__/fakes'

describe('accountView', () => {
  it('passes a signed-out or signing-in state through without a token', () => {
    const storage = vi.fn()
    expect(accountView({ status: 'signed-out', error: 'x' }, storage)).toEqual({
      account: { status: 'signed-out', error: 'x' },
    })
    expect(accountView({ status: 'signing-in' }, storage)).toEqual({
      account: { status: 'signing-in' },
    })
    expect(storage).not.toHaveBeenCalled()
  })

  it('hands the renderer who is signed in, never the account id', () => {
    const storage = vi.fn()
    const view = accountView({ status: 'signed-in', user: USER, remembered: true }, storage)
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
    const none = accountView(state, () => ({ ok: false, reason: 'no keyring is running' }))
    expect(none.account).toMatchObject({ remembered: false, storageNote: 'no keyring is running' })
    const failed = accountView(state, () => ({ ok: true, kind: 'keychain' }))
    expect(failed.account).toMatchObject({ storageNote: 'the sign-in could not be saved' })
  })
})

it('discloses plain files and never touches the cipher while building any view', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phx-view-'))
  try {
    for (const kind of ['keychain', 'file']) {
      const { cipher } = fakeCipher({ ok: true, kind })
      const vault = createVault(join(root, kind), cipher, 'linux')
      await vault.save(USER, randomBytes(32).toString('base64url'))
      const storage = vi.spyOn(cipher, 'storage')
      const encrypt = vi.spyOn(cipher, 'encrypt')
      const decrypt = vi.spyOn(cipher, 'decrypt')
      const out = accountView({ status: 'signed-out' }, vault.storage, vault.savedMode)
      expect(out.account.status).toBe('signed-out')
      const view = accountView(
        { status: 'signed-in', user: USER, remembered: true },
        vault.storage,
        vault.savedMode,
      )
      expect(view.account).toMatchObject({ remembered: true })
      if (view.account.status !== 'signed-in') throw new Error('not signed in')
      expect(view.account.storageNote).toBe(
        kind === 'file'
          ? 'Saved in a file only your user can read, because no keyring is running.'
          : undefined,
      )
      expect(storage).not.toHaveBeenCalled()
      expect(encrypt).not.toHaveBeenCalled()
      expect(decrypt).not.toHaveBeenCalled()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
