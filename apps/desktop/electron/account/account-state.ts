import { isUuid } from '@shared/control-api'
import type { AccountPorts, AccountState } from './account'
import { AuthRefused, AuthUnavailable, type AccountUser, type AuthSession } from './gotrue'

export const CALLBACK_MS = 5 * 60_000
export const REVOKE_MS = 8_000
/** The most quitting waits on Supabase: a revocation's own bound, and some. */
export const QUIT_WAIT_MS = REVOKE_MS + 2_000
/** Refresh this long before the access token expires. */
export const EARLY_MS = 60_000

export interface AccountRuntimeState {
  current: AccountState
  session: AuthSession | null
  generation: number
  trace: string
  signing: { promise: Promise<AccountState>; abort: AbortController } | null
  refreshing: Promise<AuthSession | null> | null
  /** Requests to Supabase in flight, each bounded by REQUEST_MS or REVOKE_MS. */
  readonly inFlight: Set<Promise<unknown>>
}

export function createAccountRuntimeState(): AccountRuntimeState {
  return {
    current: { status: 'signed-out' },
    session: null,
    generation: 0,
    trace: '',
    signing: null,
    refreshing: null,
    inFlight: new Set(),
  }
}

interface AccountEventFields {
  userId?: string | null
  login?: string | null
  reason?: string
}

export function event(
  state: AccountRuntimeState,
  ports: AccountPorts,
  name: string,
  fields?: AccountEventFields,
  operationTrace = state.trace,
): void {
  ports.log(`${name} ${JSON.stringify({ trace: operationTrace, ...fields })}`)
}

export const reason = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const reasonClass = (error: unknown): string =>
  error instanceof AuthRefused
    ? 'AuthRefused'
    : error instanceof AuthUnavailable
      ? 'AuthUnavailable'
      : 'Error'

export const userFields = (user: AccountUser): AccountEventFields => ({
  userId: isUuid(user.id) ? user.id : null,
  login: user.login && /^[A-Za-z0-9-]{1,39}$/.test(user.login) ? user.login : null,
})

export function track<T>(state: AccountRuntimeState, work: Promise<T>): Promise<T> {
  state.inFlight.add(work)
  const done = (): void => void state.inFlight.delete(work)
  work.then(done, done)
  return work
}

export function setAccountState(
  state: AccountRuntimeState,
  ports: AccountPorts,
  next: AccountState,
): AccountState {
  state.current = next
  ports.onChange(next)
  return next
}

export function signedOut(
  state: AccountRuntimeState,
  ports: AccountPorts,
  error?: string,
): AccountState {
  return setAccountState(
    state,
    ports,
    error ? { status: 'signed-out', error } : { status: 'signed-out' },
  )
}

/** Forget locally; the caller owns revocation, including any late result. */
export function forget(
  state: AccountRuntimeState,
  ports: AccountPorts,
  error?: string,
): AccountState {
  state.generation++
  state.session = null
  try {
    ports.vault.clear()
  } catch (problem) {
    event(state, ports, 'could not delete the saved sign-in', { reason: reasonClass(problem) })
    const note = `The saved sign-in could not be deleted (${reason(problem)}).`
    return signedOut(state, ports, error ? `${error} ${note}` : `Signed out, but: ${note}`)
  }
  return signedOut(state, ports, error)
}

/** Keep a fresh session; false when it lives in memory only. */
export function keep(state: AccountRuntimeState, ports: AccountPorts, fresh: AuthSession): boolean {
  state.session = fresh
  try {
    return ports.vault.save(fresh.user, fresh.refreshToken)
  } catch (problem) {
    // The token on disk may be the one just consumed; do not leave it behind.
    event(state, ports, 'could not save the sign-in', { reason: reasonClass(problem) })
    try {
      ports.vault.clear()
    } catch {
      // Logged above; the next launch's refresh will end the stale session.
    }
    return false
  }
}

export function loadAccount(state: AccountRuntimeState, ports: AccountPorts): AccountState {
  const user = ports.vault.readProfile()
  if (!user) return forget(state, ports)
  return setAccountState(state, ports, { status: 'signed-in', user, remembered: true })
}
