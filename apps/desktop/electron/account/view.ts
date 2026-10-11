import type { AccountView } from '@shared/account'
import type { AccountState } from './account'
import type { Storage } from './vault'

/**
 * The renderer's copy: the user's id stays in main, like every token.
 * `storage` is asked only for a sign-in that was not remembered, so opening
 * Settings never wakes the keychain.
 */
export function accountView(
  state: AccountState,
  preview: boolean,
  storage: () => Storage,
): AccountView {
  if (state.status !== 'signed-in') return { preview, account: state }
  const { login, name, email } = state.user
  const account = { status: 'signed-in' as const, user: { login, name, email } }
  if (state.remembered) return { preview, account: { ...account, remembered: true } }
  const known = storage()
  const storageNote = known.ok ? 'the sign-in could not be saved' : known.reason
  return { preview, account: { ...account, remembered: false, storageNote } }
}
