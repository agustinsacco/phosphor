import type { AccountView } from '@shared/account'
import type { AccountState } from './account'
import type { Storage, Vault } from './vault'

/**
 * The renderer's copy: the user's id stays in main, like every token.
 * Saved mode checks filenames only. Building the view never wakes the keychain.
 */
export function accountView(
  state: AccountState,
  storage: () => Storage,
  savedMode: Vault['savedMode'] = () => null,
): AccountView {
  if (state.status !== 'signed-in') return { account: state }
  const { login, name, email } = state.user
  const account = { status: 'signed-in' as const, user: { login, name, email } }
  if (state.remembered) {
    const storageNote =
      savedMode() === 'file'
        ? 'Saved in a file only your user can read, because no keyring is running.'
        : undefined
    return {
      account: { ...account, remembered: true, ...(storageNote ? { storageNote } : {}) },
    }
  }
  const known = storage()
  const storageNote = known.ok ? 'the sign-in could not be saved' : known.reason
  return { account: { ...account, remembered: false, storageNote } }
}
