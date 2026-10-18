import { randomBytes } from 'node:crypto'
import type { AccountPorts, AccountState } from './account'
import {
  CALLBACK_MS,
  event,
  keep,
  reason,
  reasonClass,
  setAccountState,
  signedOut,
  track,
  userFields,
  type AccountRuntimeState,
} from './account-state'
import { pkcePair, type AccountUser } from './gotrue'
import { listenForCallback, type CallbackListener, type CallbackPage } from './loopback'
import { revoke } from './session-refresh'

const CANCELLED: CallbackPage = {
  title: 'Sign-in cancelled',
  message: 'The sign-in was cancelled in Phosphor. You can close this tab.',
}
const FAILED: CallbackPage = {
  title: 'Sign-in failed',
  message: 'Phosphor could not finish the sign-in. Return to Phosphor for details.',
}

const label = (user: AccountUser): string => (user.login ? `@${user.login}` : (user.email ?? 'you'))

async function run(
  state: AccountRuntimeState,
  ports: AccountPorts,
  gen: number,
  signal: AbortSignal,
  operationTrace: string,
): Promise<AccountState> {
  const signin = (name: string, fields?: Parameters<typeof event>[3]): void =>
    event(state, ports, name, fields, operationTrace)
  const live = (): boolean => gen === state.generation
  const { verifier, challenge } = pkcePair()
  let listener: CallbackListener | null = null
  try {
    listener = await listenForCallback(ports.callbackMs ?? CALLBACK_MS, signal)
    if (!live()) return state.current
    await ports.openExternal(ports.auth.authorizeUrl(listener.url, challenge))
    signin('sign-in.browser-opened')
    const outcome = await listener.outcome
    if (outcome.kind !== 'timeout' && outcome.kind !== 'cancelled')
      signin('sign-in.callback-received')
    if (!live() || outcome.kind === 'cancelled') {
      listener.finish(CANCELLED)
      return state.current
    }
    if (outcome.kind === 'timeout') {
      signin('sign-in.failed', { reason: 'timeout' })
      return signedOut(state, ports, 'Sign-in timed out. Try again.')
    }
    if (outcome.kind === 'denied') {
      signin('sign-in.failed', { reason: 'denied' })
      listener.finish(CANCELLED)
      const why = outcome.description || outcome.errorCode || outcome.error
      return signedOut(state, ports, `GitHub sign-in did not finish: ${why}`)
    }
    // Never aborted: Supabase may already have issued the session, and only a
    // finished exchange can be revoked below. REQUEST_MS bounds it.
    const fresh = await track(state, ports.auth.exchange(outcome.code, verifier))
    if (!live()) {
      listener.finish(CANCELLED)
      void revoke(state, ports, fresh.accessToken)
      return state.current
    }
    const remembered = keep(state, ports, fresh)
    listener.finish({
      title: 'Signed in to Phosphor',
      message: `Signed in as ${label(fresh.user)}. You can close this tab.`,
    })
    signin('sign-in.finished', userFields(fresh.user))
    return setAccountState(state, ports, { status: 'signed-in', user: fresh.user, remembered })
  } catch (problem) {
    listener?.finish(live() ? FAILED : CANCELLED)
    if (!live()) return state.current
    signin('sign-in.failed', { reason: reasonClass(problem) })
    return signedOut(state, ports, `Sign-in failed: ${reason(problem)}`)
  } finally {
    listener?.close()
  }
}

export function signIn(state: AccountRuntimeState, ports: AccountPorts): Promise<AccountState> {
  if (state.signing) return state.signing.promise
  if (state.current.status === 'signed-in') return Promise.resolve(state.current)
  state.trace = randomBytes(8).toString('hex')
  event(state, ports, 'sign-in.started')
  const gen = ++state.generation
  const abort = new AbortController()
  setAccountState(state, ports, { status: 'signing-in' })
  const promise = run(state, ports, gen, abort.signal, state.trace).finally(() => {
    if (state.signing?.promise === promise) state.signing = null
  })
  state.signing = { promise, abort }
  return promise
}

export function cancel(state: AccountRuntimeState, ports: AccountPorts): void {
  if (!state.signing) return
  event(state, ports, 'sign-in.cancelled')
  state.generation++
  state.signing.abort.abort()
  state.signing = null
  signedOut(state, ports)
}
