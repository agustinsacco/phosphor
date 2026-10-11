import { AuthRefused, pkcePair, type AccountUser, type AuthSession, type GoTrue } from './gotrue'
import { listenForCallback, type CallbackListener, type CallbackPage } from './loopback'
import type { Vault } from './vault'

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
}

export const CALLBACK_MS = 5 * 60_000
export const REVOKE_MS = 8_000
/** Refresh this long before the access token expires. */
export const EARLY_MS = 60_000

const CANCELLED: CallbackPage = {
  title: 'Sign-in cancelled',
  message: 'The sign-in was cancelled in Phosphor. You can close this tab.',
}
const FAILED: CallbackPage = {
  title: 'Sign-in failed',
  message: 'Phosphor could not finish the sign-in. Return to Phosphor for details.',
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const label = (user: AccountUser): string => (user.login ? `@${user.login}` : (user.email ?? 'you'))

export function createAccount(ports: AccountPorts): Account {
  const now = ports.now ?? Date.now
  let current: AccountState = { status: 'signed-out' }
  let session: AuthSession | null = null
  let generation = 0
  let signing: { promise: Promise<AccountState>; abort: AbortController } | null = null
  let refreshing: Promise<AuthSession | null> | null = null

  function set(next: AccountState): AccountState {
    current = next
    ports.onChange(next)
    return next
  }

  function signedOut(error?: string): AccountState {
    return set(error ? { status: 'signed-out', error } : { status: 'signed-out' })
  }

  /**
   * Forget the session here; the server copy is the caller's business. A file
   * that could not be deleted is said out loud: a profile left behind would
   * sign the next launch back in.
   */
  function forget(error?: string): AccountState {
    generation++
    session = null
    try {
      ports.vault.clear()
    } catch (problem) {
      ports.log(`could not delete the saved sign-in: ${reason(problem)}`)
      const note = `The saved sign-in could not be deleted (${reason(problem)}).`
      return signedOut(error ? `${error} ${note}` : `Signed out, but: ${note}`)
    }
    return signedOut(error)
  }

  function revoke(accessToken: string): Promise<void> {
    const signal = AbortSignal.timeout(ports.revokeMs ?? REVOKE_MS)
    return ports.auth
      .revoke(accessToken, signal)
      .catch((problem: unknown) => ports.log(`could not revoke a session: ${reason(problem)}`))
  }

  /** Keep a fresh session; false when it lives in memory only. */
  function keep(fresh: AuthSession): boolean {
    session = fresh
    try {
      return ports.vault.save(fresh.user, fresh.refreshToken)
    } catch (problem) {
      // The token on disk may be the one just consumed; do not leave it behind.
      ports.log(`could not save the sign-in: ${reason(problem)}`)
      try {
        ports.vault.clear()
      } catch {
        // Logged above; the next launch's refresh will end the stale session.
      }
      return false
    }
  }

  async function run(gen: number, signal: AbortSignal): Promise<AccountState> {
    const live = (): boolean => gen === generation
    const { verifier, challenge } = pkcePair()
    let listener: CallbackListener | null = null
    try {
      listener = await listenForCallback(ports.callbackMs ?? CALLBACK_MS, signal)
      if (!live()) return current
      await ports.openExternal(ports.auth.authorizeUrl(listener.url, challenge))
      const outcome = await listener.outcome
      if (!live() || outcome.kind === 'cancelled') {
        listener.finish(CANCELLED)
        return current
      }
      if (outcome.kind === 'timeout') return signedOut('Sign-in timed out. Try again.')
      if (outcome.kind === 'denied') {
        listener.finish(CANCELLED)
        const why = outcome.description || outcome.errorCode || outcome.error
        return signedOut(`GitHub sign-in did not finish: ${why}`)
      }
      // Never aborted: Supabase may already have issued the session, and only a
      // finished exchange can be revoked below. REQUEST_MS bounds it.
      const fresh = await ports.auth.exchange(outcome.code, verifier)
      if (!live()) {
        listener.finish(CANCELLED)
        void revoke(fresh.accessToken)
        return current
      }
      const remembered = keep(fresh)
      listener.finish({
        title: 'Signed in to Phosphor',
        message: `Signed in as ${label(fresh.user)}. You can close this tab.`,
      })
      return set({ status: 'signed-in', user: fresh.user, remembered })
    } catch (problem) {
      listener?.finish(live() ? FAILED : CANCELLED)
      if (!live()) return current
      ports.log(`sign-in failed: ${reason(problem)}`)
      return signedOut(`Sign-in failed: ${reason(problem)}`)
    } finally {
      listener?.close()
    }
  }

  function refresh(): Promise<AuthSession | null> {
    if (refreshing) return refreshing
    const gen = generation
    const live = (): boolean => gen === generation
    const attempt = async (): Promise<AuthSession | null> => {
      if (current.status !== 'signed-in') return null
      let token: string
      try {
        token = session?.refreshToken ?? ports.vault.readToken(current.user.id)
      } catch (problem) {
        forget(`The saved sign-in could not be read (${reason(problem)}). Sign in again.`)
        return null
      }
      let fresh: AuthSession
      try {
        fresh = await ports.auth.refresh(token)
      } catch (problem) {
        if (!live()) return null
        if (problem instanceof AuthRefused) {
          ports.log(`session ended: ${problem.code ?? problem.status}`)
          forget('Your Phosphor session ended. Sign in again.')
          return null
        }
        throw problem
      }
      if (!live()) {
        void revoke(fresh.accessToken)
        return null
      }
      const remembered = keep(fresh)
      set({ status: 'signed-in', user: fresh.user, remembered })
      return fresh
    }
    const promise = attempt().finally(() => {
      if (refreshing === promise) refreshing = null
    })
    refreshing = promise
    return promise
  }

  return {
    state: () => current,

    load() {
      const user = ports.vault.readProfile()
      if (!user) return forget()
      return set({ status: 'signed-in', user, remembered: true })
    },

    signIn() {
      if (signing) return signing.promise
      if (current.status === 'signed-in') return Promise.resolve(current)
      const gen = ++generation
      const abort = new AbortController()
      set({ status: 'signing-in' })
      const promise = run(gen, abort.signal).finally(() => {
        if (signing?.promise === promise) signing = null
      })
      signing = { promise, abort }
      return promise
    },

    cancel() {
      if (!signing) return
      generation++
      signing.abort.abort()
      signing = null
      signedOut()
    },

    async signOut() {
      const was = current
      if (signing) {
        signing.abort.abort()
        signing = null
      }
      const held = session
      let token = held?.refreshToken ?? null
      if (was.status === 'signed-in' && !token) {
        try {
          token = ports.vault.readToken(was.user.id)
        } catch {
          // Nothing to revoke with; the local copy goes regardless.
        }
      }
      const inFlight = refreshing !== null
      const result = forget()
      if (was.status !== 'signed-in') return result
      // One owner per session. A session this side holds is revoked here, with
      // its access token while that outlives the request; that includes one a
      // refresh kept a moment ago, whose promise has not settled yet. Holding
      // nothing usable while a refresh is in flight, that refresh owns the
      // revocation: it lands on a stale generation and revokes what it got.
      const revokeMs = ports.revokeMs ?? REVOKE_MS
      const usable = held && held.expiresAt - now() > revokeMs ? held.accessToken : null
      if (!usable && inFlight) return result
      const signal = AbortSignal.timeout(revokeMs)
      try {
        let access = usable
        if (!access && token) access = (await ports.auth.refresh(token, signal)).accessToken
        if (access) await ports.auth.revoke(access, signal)
      } catch (problem) {
        ports.log(`signed out here; the server session was not revoked: ${reason(problem)}`)
      }
      return result
    },

    async accessToken() {
      if (current.status !== 'signed-in') return null
      if (session && session.expiresAt - now() > EARLY_MS) return session.accessToken
      const gen = generation
      const fresh = await refresh()
      return fresh && gen === generation ? fresh.accessToken : null
    },
  }
}
