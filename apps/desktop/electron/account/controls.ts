import type { AccountView } from '@shared/account'
import type { Account, AccountState } from './account'

export interface ControlPorts {
  /** The account, built on first call; a broken configuration throws here. */
  account(): Account
  isBuilt(): boolean
  getPreview(): boolean
  setPreview(enabled: boolean): void
  /** The renderer's copy of a state, with the current preview flag. */
  view(state: AccountState): AccountView
  /** Tell every window. */
  publish(view: AccountView): void
}

export interface AccountControls {
  snapshot(): AccountView
  signIn(): AccountView
  setPreview(enabled: boolean): Promise<AccountView>
}

const SIGNED_OUT: AccountState = { status: 'signed-out' }

/**
 * What the IPC handlers may do with the account, and when. The preview switch
 * is the only control a session has, so it gates sign-in in main, not just in
 * the UI, and every window shares that one gate.
 */
export function createAccountControls(ports: ControlPorts): AccountControls {
  let changes: Promise<unknown> = Promise.resolve()

  // With the preview off and nothing built, there is nothing to read: opening
  // Settings then neither builds the account nor touches its files.
  const snapshot = (): AccountView =>
    ports.view(ports.isBuilt() || ports.getPreview() ? ports.account().state() : SIGNED_OUT)

  return {
    snapshot,

    signIn() {
      if (!ports.getPreview()) {
        throw new Error('Phosphor sign-in is a preview: turn it on in Settings → Advanced.')
      }
      // Resolves when the browser comes back; windows hear the outcome as a push.
      void ports.account().signIn()
      return snapshot()
    },

    // One change at a time, across windows: an enable never lands in the
    // middle of a disable's sign-out.
    setPreview(enabled) {
      const change = changes.then(async () => {
        // A broken configuration fails here, before anything has changed.
        const account = ports.account()
        if (enabled) {
          ports.setPreview(true)
        } else {
          // Closed before the sign-out waits on Supabase, so no window can
          // start a sign-in that would outlive its only control.
          ports.setPreview(false)
          const out = await account.signOut()
          // signOut reports an error only when the saved sign-in could not be
          // deleted; the next launch would load it again. Leave the switch on,
          // where the user can see that and try again.
          if (out.status === 'signed-out' && out.error) {
            ports.setPreview(true)
            ports.publish(ports.view(account.state()))
            throw new Error(`${out.error} The preview stays on so you can try again.`)
          }
        }
        const next = ports.view(account.state())
        ports.publish(next)
        return next
      })
      changes = change.catch(() => undefined)
      return change
    },
  }
}
