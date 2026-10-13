import { randomBytes } from 'node:crypto'
import { isUuid } from '@shared/control-api'
import {
  AuthUnavailable,
  AuthRefused,
  pkcePair,
  type AccountUser,
  type AuthSession,
  type GoTrue,
} from './gotrue'
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
  /**
   * Resolves once every request to Supabase already started has finished, and
   * any revocation it led to: quit waits on this, so a sign-out the person just
   * made still reaches Supabase. True when all settled, false at `timeoutMs`.
   */
  settled(timeoutMs?: number): Promise<boolean>
}

export const CALLBACK_MS = 5 * 60_000
export const REVOKE_MS = 8_000
/** The most quitting waits on Supabase: a revocation's own bound, and some. */
export const QUIT_WAIT_MS = REVOKE_MS + 2_000
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
  let trace = ''
  const event = (
    name: string,
    fields?: { userId?: string | null; login?: string | null; reason?: string },
    operationTrace = trace,
  ) => ports.log(`${name} ${JSON.stringify({ trace: operationTrace, ...fields })}`)
  const reasonClass = (error: unknown) =>
    error instanceof AuthRefused
      ? 'AuthRefused'
      : error instanceof AuthUnavailable
        ? 'AuthUnavailable'
        : 'Error'
  const userFields = (user: AccountUser) => ({
    userId: isUuid(user.id) ? user.id : null,
    login: user.login && /^[A-Za-z0-9-]{1,39}$/.test(user.login) ? user.login : null,
  })
  let signing: { promise: Promise<AccountState>; abort: AbortController } | null = null
  let refreshing: Promise<AuthSession | null> | null = null
  /** Requests to Supabase in flight, each bounded by REQUEST_MS or REVOKE_MS. */
  const inFlight = new Set<Promise<unknown>>()

  function track<T>(work: Promise<T>): Promise<T> {
    inFlight.add(work)
    const done = (): void => void inFlight.delete(work)
    work.then(done, done)
    return work
  }

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
      event('could not delete the saved sign-in', { reason: reasonClass(problem) })
      const note = `The saved sign-in could not be deleted (${reason(problem)}).`
      return signedOut(error ? `${error} ${note}` : `Signed out, but: ${note}`)
    }
    return signedOut(error)
  }

  function revoke(accessToken: string): Promise<void> {
    const signal = AbortSignal.timeout(ports.revokeMs ?? REVOKE_MS)
    return track(
      ports.auth
        .revoke(accessToken, signal)
        .catch((problem: unknown) =>
          event('could not revoke a session', { reason: reasonClass(problem) }),
        ),
    )
  }

  /** Keep a fresh session; false when it lives in memory only. */
  function keep(fresh: AuthSession): boolean {
    session = fresh
    try {
      return ports.vault.save(fresh.user, fresh.refreshToken)
    } catch (problem) {
      // The token on disk may be the one just consumed; do not leave it behind.
      event('could not save the sign-in', { reason: reasonClass(problem) })
      try {
        ports.vault.clear()
      } catch {
        // Logged above; the next launch's refresh will end the stale session.
      }
      return false
    }
  }

  async function run(
    gen: number,
    signal: AbortSignal,
    operationTrace: string,
  ): Promise<AccountState> {
    const signin: typeof event = (name, fields) => event(name, fields, operationTrace)
    const live = (): boolean => gen === generation
    const { verifier, challenge } = pkcePair()
    let listener: CallbackListener | null = null
    try {
      listener = await listenForCallback(ports.callbackMs ?? CALLBACK_MS, signal)
      if (!live()) return current
      await ports.openExternal(ports.auth.authorizeUrl(listener.url, challenge))
      signin('sign-in.browser-opened')
      const outcome = await listener.outcome
      if (outcome.kind !== 'timeout' && outcome.kind !== 'cancelled')
        signin('sign-in.callback-received')
      if (!live() || outcome.kind === 'cancelled') {
        listener.finish(CANCELLED)
        return current
      }
      if (outcome.kind === 'timeout') {
        signin('sign-in.failed', { reason: 'timeout' })
        return signedOut('Sign-in timed out. Try again.')
      }
      if (outcome.kind === 'denied') {
        signin('sign-in.failed', { reason: 'denied' })
        listener.finish(CANCELLED)
        const why = outcome.description || outcome.errorCode || outcome.error
        return signedOut(`GitHub sign-in did not finish: ${why}`)
      }
      // Never aborted: Supabase may already have issued the session, and only a
      // finished exchange can be revoked below. REQUEST_MS bounds it.
      const fresh = await track(ports.auth.exchange(outcome.code, verifier))
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
      signin('sign-in.finished', userFields(fresh.user))
      return set({ status: 'signed-in', user: fresh.user, remembered })
    } catch (problem) {
      listener?.finish(live() ? FAILED : CANCELLED)
      if (!live()) return current
      signin('sign-in.failed', { reason: reasonClass(problem) })
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
        event('session.refresh.failed', { reason: 'storage' })
        forget(`The saved sign-in could not be read (${reason(problem)}). Sign in again.`)
        return null
      }
      let fresh: AuthSession
      try {
        fresh = await track(ports.auth.refresh(token))
      } catch (problem) {
        if (!live()) return null
        event('session.refresh.failed', { reason: reasonClass(problem) })
        if (problem instanceof AuthRefused) {
          event('session ended', { reason: 'AuthRefused' })
          forget('Your Phosphor session ended. Sign in again.')
          return null
        }
        throw problem
      }
      if (!live()) {
        void revoke(fresh.accessToken)
        return null
      }
      // Landed: no longer in flight. From here the session is held, so a
      // sign-out (even one this set() triggers) revokes it, not this refresh.
      refreshing = null
      const remembered = keep(fresh)
      event('session.refresh.succeeded', userFields(fresh.user))
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
      trace = randomBytes(8).toString('hex')
      event('sign-in.started')
      const gen = ++generation
      const abort = new AbortController()
      set({ status: 'signing-in' })
      const promise = run(gen, abort.signal, trace).finally(() => {
        if (signing?.promise === promise) signing = null
      })
      signing = { promise, abort }
      return promise
    },

    cancel() {
      if (!signing) return
      event('sign-in.cancelled')
      generation++
      signing.abort.abort()
      signing = null
      signedOut()
    },

    async signOut() {
      event('sign-out')
      const was = current
      if (signing) {
        event('sign-in.cancelled')
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
      const refreshInFlight = refreshing !== null
      const result = forget()
      if (was.status !== 'signed-in') return result
      // Someone always revokes. A session this side holds, including one a
      // refresh kept a moment ago, is revoked here: with its access token while
      // that outlives the request, else by refreshing it first. A refresh still
      // waiting on Supabase revokes whatever it gets back, since it lands on a
      // stale generation. Holding nothing usable, this side leaves it to that
      // refresh; when both act, the session is revoked twice, which is harmless.
      const revokeMs = ports.revokeMs ?? REVOKE_MS
      const usable = held && held.expiresAt - now() > revokeMs ? held.accessToken : null
      if (!usable && refreshInFlight) return result
      const signal = AbortSignal.timeout(revokeMs)
      await track(
        (async () => {
          try {
            let access = usable
            if (!access && token) access = (await ports.auth.refresh(token, signal)).accessToken
            if (access) await ports.auth.revoke(access, signal)
          } catch (problem) {
            event('signed out here; the server session was not revoked', {
              reason: reasonClass(problem),
            })
          }
        })(),
      )
      return result
    },

    async accessToken() {
      if (current.status !== 'signed-in') return null
      if (session && session.expiresAt - now() > EARLY_MS) return session.accessToken
      const gen = generation
      const fresh = await refresh()
      return fresh && gen === generation ? fresh.accessToken : null
    },

    async settled(timeoutMs = QUIT_WAIT_MS) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      })
      const drained = (async () => {
        // A request that lands may start a revocation; wait for that one too.
        while (inFlight.size > 0) await Promise.allSettled([...inFlight])
        return true as const
      })()
      try {
        return await Promise.race([drained, deadline])
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
