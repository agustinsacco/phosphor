import { handle } from './handle'
import { accountSnapshot, cancelSignIn, setPreview, signIn, signOut } from '../account'

/**
 * Desktop's optional Phosphor sign-in. Every answer is an `AccountView`: who
 * is signed in and whether it is remembered, never a token or an id.
 */
export function registerAccountHandlers(): void {
  handle('account:get', () => accountSnapshot())
  handle('account:signIn', () => signIn())
  handle('account:cancelSignIn', () => cancelSignIn())
  handle('account:signOut', () => signOut())
  handle('account:setPreview', (_event, enabled) => {
    if (typeof enabled !== 'boolean') throw new Error('Invalid preview flag.')
    return setPreview(enabled)
  })
}
