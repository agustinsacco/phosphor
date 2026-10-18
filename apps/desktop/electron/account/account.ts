import type { AccountUser, GoTrue } from './gotrue'
import type { Vault } from './vault'
import { createAccountRuntimeState, loadAccount } from './account-state'
import { cancel, signIn } from './sign-in'
import { accessToken, settled, signOut } from './session-refresh'

export { CALLBACK_MS, REVOKE_MS, QUIT_WAIT_MS, EARLY_MS } from './account-state'

/**
 * Desktop's optional Phosphor sign-in: one owner of the session, in main.
 *
 * Every async step captures `generation` before it waits and re-checks it
 * after. Sign-out and cancel bump it, so a late answer (a code exchange or a
 * refresh that lands after the user moved on) can never bring a session back.
 * Such an orphaned session is revoked by whoever receives it. Local work never
 * depends on any of this: load() reads one file and makes no request.
 */

export type AccountState =
  | { readonly status: 'signed-out'; readonly error?: string }
  | { readonly status: 'signing-in' }
  | { readonly status: 'signed-in'; readonly user: AccountUser; readonly remembered: boolean }

export interface AccountPorts {
  readonly auth: GoTrue
  readonly vault: Vault
  openExternal(url: string): Promise<void>
  onChange(state: AccountState): void
  /** Never handed a token: messages only. */
  log(message: string): void
  now?(): number
  readonly callbackMs?: number
  readonly revokeMs?: number
}

export interface Account {
  state(): AccountState
  /** Startup: who is remembered, from the profile alone. No network, no keychain. */
  load(): AccountState
  signIn(): Promise<AccountState>
  cancel(): void
  signOut(): Promise<AccountState>
  /** Null when signed out; rejects with AuthUnavailable when Supabase cannot be reached. */
  accessToken(): Promise<string | null>
  /**
   * Resolves once every request to Supabase already started has finished, and
   * any revocation it led to: quit waits on this, so a sign-out the person just
   * made still reaches Supabase. True when all settled, false at `timeoutMs`.
   */
  settled(timeoutMs?: number): Promise<boolean>
}

export function createAccount(ports: AccountPorts): Account {
  const state = createAccountRuntimeState()
  const now = ports.now ?? Date.now
  return {
    state: () => state.current,
    load: () => loadAccount(state, ports),
    signIn: () => signIn(state, ports),
    cancel: () => cancel(state, ports),
    signOut: () => signOut(state, ports, now),
    accessToken: () => accessToken(state, ports, now),
    settled: (timeoutMs) => settled(state, timeoutMs),
  }
}
