import { handle } from './handle'
import { accountSnapshot, cancelSignIn, signIn, signOut } from '../account'
import { setConfigureHosts } from '../store'
import { remoteDiscoveryActive } from '../control/runtime'

/**
 * Desktop's optional Phosphor sign-in. Every answer is an `AccountView`: who
 * is signed in and whether it is remembered, never a token or an id.
 */
export function registerAccountHandlers(): void {
  handle('account:get', () => {
    const view = accountSnapshot()
    return view.account.status === 'signed-in' && remoteDiscoveryActive()
      ? { ...view, remoteDiscoveryActive: true as const }
      : view
  })
  handle('account:signIn', () => signIn())
  handle('account:cancelSignIn', () => cancelSignIn())
  handle('account:signOut', () => {
    // Remembered Host settings access ends with an explicit sign-out, before revocation settles.
    setConfigureHosts({})
    return signOut()
  })
}
