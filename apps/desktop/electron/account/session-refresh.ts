import type { AccountPorts, AccountState } from './account'
import {
  EARLY_MS,
  QUIT_WAIT_MS,
  REVOKE_MS,
  event,
  forget,
  keep,
  reason,
  reasonClass,
  setAccountState,
  track,
  userFields,
  type AccountRuntimeState,
} from './account-state'
import { AuthRefused, type AuthSession } from './gotrue'

export function revoke(
  state: AccountRuntimeState,
  ports: AccountPorts,
  accessToken: string,
): Promise<void> {
  const signal = AbortSignal.timeout(ports.revokeMs ?? REVOKE_MS)
  return track(
    state,
    ports.auth
      .revoke(accessToken, signal)
      .catch((problem: unknown) =>
        event(state, ports, 'could not revoke a session', { reason: reasonClass(problem) }),
      ),
  )
}

async function attemptRefresh(
  state: AccountRuntimeState,
  ports: AccountPorts,
  gen: number,
): Promise<AuthSession | null> {
  if (state.current.status !== 'signed-in') return null
  let token: string
  try {
    // The vault read can wait on a Keychain prompt; a sign-out may land meanwhile.
    token = state.session?.refreshToken ?? (await ports.vault.readToken(state.current.user.id))
  } catch (problem) {
    if (gen !== state.generation) return null
    event(state, ports, 'session.refresh.failed', { reason: 'storage' })
    forget(state, ports, `The saved sign-in could not be read (${reason(problem)}). Sign in again.`)
    return null
  }
  if (gen !== state.generation) return null
  let fresh: AuthSession
  state.refreshesAtSupabase++
  try {
    fresh = await track(state, ports.auth.refresh(token))
  } catch (problem) {
    if (gen !== state.generation) return null
    event(state, ports, 'session.refresh.failed', { reason: reasonClass(problem) })
    if (problem instanceof AuthRefused) {
      event(state, ports, 'session ended', { reason: 'AuthRefused' })
      forget(state, ports, 'Your Phosphor session ended. Sign in again.')
      return null
    }
    throw problem
  } finally {
    state.refreshesAtSupabase--
  }
  if (gen !== state.generation) {
    void revoke(state, ports, fresh.accessToken)
    return null
  }
  // Landed: no longer in flight. From here the session is held, so a
  // sign-out (even one this set() triggers) revokes it, not this refresh.
  state.refreshing = null
  const remembered = await keep(state, ports, fresh, gen)
  // A sign-out during the save held this session and revoked it.
  if (gen !== state.generation) return null
  event(state, ports, 'session.refresh.succeeded', userFields(fresh.user))
  setAccountState(state, ports, { status: 'signed-in', user: fresh.user, remembered })
  return fresh
}

export function refresh(
  state: AccountRuntimeState,
  ports: AccountPorts,
): Promise<AuthSession | null> {
  if (state.refreshing) return state.refreshing
  const promise = attemptRefresh(state, ports, state.generation).finally(() => {
    if (state.refreshing === promise) state.refreshing = null
  })
  state.refreshing = promise
  return promise
}

export async function signOut(
  state: AccountRuntimeState,
  ports: AccountPorts,
  now: () => number,
): Promise<AccountState> {
  event(state, ports, 'sign-out')
  const was = state.current
  if (state.signing) {
    event(state, ports, 'sign-in.cancelled')
    state.signing.abort.abort()
    state.signing = null
  }
  const held = state.session
  const token = held?.refreshToken ?? null
  // Started before forget() deletes the files: readToken reads them before it
  // first yields, and only the decrypt (maybe a Keychain prompt) runs later.
  // Nothing to revoke with when it fails; the local copy goes regardless.
  let saved: Promise<string | null> = Promise.resolve(token)
  if (was.status === 'signed-in' && !token) {
    try {
      saved = ports.vault.readToken(was.user.id).catch(() => null)
    } catch {
      saved = Promise.resolve(null)
    }
  }
  // Only a refresh already at Supabase revokes for us. One still reading the
  // vault sees the new generation and stops, so this side revokes then.
  const refreshInFlight = state.refreshesAtSupabase > 0
  const result = forget(state, ports)
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
  await track(
    state,
    (async () => {
      try {
        let access = usable
        const refreshToken = access ? null : await saved
        // Bounded from here: time spent on a Keychain prompt is not Supabase's.
        const signal = AbortSignal.timeout(revokeMs)
        if (!access && refreshToken)
          access = (await ports.auth.refresh(refreshToken, signal)).accessToken
        if (access) await ports.auth.revoke(access, signal)
      } catch (problem) {
        event(state, ports, 'signed out here; the server session was not revoked', {
          reason: reasonClass(problem),
        })
      }
    })(),
  )
  return result
}

export async function accessToken(
  state: AccountRuntimeState,
  ports: AccountPorts,
  now: () => number,
): Promise<string | null> {
  if (state.current.status !== 'signed-in') return null
  if (state.session && state.session.expiresAt - now() > EARLY_MS) return state.session.accessToken
  const gen = state.generation
  const fresh = await refresh(state, ports)
  return fresh && gen === state.generation ? fresh.accessToken : null
}

export async function settled(
  state: AccountRuntimeState,
  timeoutMs = QUIT_WAIT_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  const drained = (async () => {
    // A request that lands may start a revocation; wait for that one too.
    while (state.inFlight.size > 0) await Promise.allSettled([...state.inFlight])
    return true as const
  })()
  try {
    return await Promise.race([drained, deadline])
  } finally {
    clearTimeout(timer)
  }
}
