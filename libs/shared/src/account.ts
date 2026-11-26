/**
 * Desktop's optional Phosphor sign-in, as the renderer sees it. Main owns
 * the session (`apps/desktop/electron/account/`); this carries no token and
 * no account id, only what the account controls show.
 */

export interface AccountProfileView {
  /** GitHub login, shown as @login. */
  readonly login: string | null
  readonly name: string | null
  readonly email: string | null
  /** Main-fetched GitHub avatar. Never a remote renderer URL. */
  readonly avatarDataUrl?: string
}

export type AccountStatusView =
  | {
      readonly status: 'signed-out'
      readonly error?: string
      /**
       * Browser only. `unreachable`: Control could not be asked, so the session is unknown
       * and the page keeps checking. `sign-out-unconfirmed`: an explicit sign-out's cleanup
       * is not confirmed, so the screen offers to retry it.
       */
      readonly notice?: 'unreachable' | 'sign-out-unconfirmed'
    }
  | { readonly status: 'signing-in' }
  | {
      readonly status: 'signed-in'
      readonly user: AccountProfileView
      /** True when a refresh token is saved for the next launch. */
      readonly remembered: boolean
      /** Storage disclosure for a plain file, or why the sign-in is not remembered. */
      readonly storageNote?: string
    }

export interface AccountView {
  readonly account: AccountStatusView
  /** Desktop snapshot only: this process already started remote discovery. Reads no credentials. */
  readonly remoteDiscoveryActive?: true
}
