/**
 * Desktop's optional Phosphor sign-in, as the renderer sees it. Main owns
 * the session (`apps/desktop/electron/account/`); this carries no token and
 * no account id, only what the Settings section shows.
 */

export interface AccountProfileView {
  /** GitHub login, shown as @login. */
  readonly login: string | null
  readonly name: string | null
  readonly email: string | null
}

export type AccountStatusView =
  | { readonly status: 'signed-out'; readonly error?: string }
  | { readonly status: 'signing-in' }
  | {
      readonly status: 'signed-in'
      readonly user: AccountProfileView
      /** False when the OS offers no secure storage: the sign-in ends when Phosphor quits. */
      readonly remembered: boolean
      /** Why it is not remembered, when it is not. */
      readonly storageNote?: string
    }

export interface AccountView {
  /** Settings → Advanced → Phosphor account (preview). Off by default. */
  readonly preview: boolean
  readonly account: AccountStatusView
}
