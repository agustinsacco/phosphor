import { handle } from './handle'
import { accountSnapshot, cancelSignIn, signIn, signOut } from '../account'
import { setConfigureHosts } from '../store'

/**
 * Desktop's optional Phosphor sign-in. Every answer is an `AccountView`: who
 * is signed in and whether it is remembered, never a token or an id.
 */
export function registerAccountHandlers(): void {
  handle('account:get', () => accountSnapshot())
  handle('account:signIn', () => signIn())
  handle('account:cancelSignIn', () => cancelSignIn())
  handle('account:signOut', () => {
    // Remembered Host settings access ends with an explicit sign-out, before revocation settles.
    setConfigureHosts({})
    return signOut()
  })
}
