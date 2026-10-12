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
      /** True when a refresh token is saved for the next launch. */
      readonly remembered: boolean
      /** Storage disclosure for a plain file, or why the sign-in is not remembered. */
      readonly storageNote?: string
    }

export interface AccountView {
  /** Settings → Advanced → Phosphor account (preview). Off by default. */
  readonly preview: boolean
  readonly account: AccountStatusView
}
