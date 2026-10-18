import { randomBytes } from 'node:crypto'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  handleCallbackRequest,
  NOT_OURS,
  reply,
  type CallbackRequestState,
} from './loopback-request'

/**
 * The one-shot address the browser comes back to after GitHub (RFC 8252
 * section 7.3): loopback only, a port the OS picks, one use.
 *
 * Supabase sends only the authorization code here, with no state of ours, so
 * the path carries a random per-flow nonce instead: a request without it never
 * reaches the flow, so a local process that finds the port cannot end a
 * sign-in with a forged denial. A code is still worthless without the PKCE
 * verifier, which never leaves the main process. The Host check refuses a
 * DNS-rebound page that reaches the port by name.
 */

export type CallbackOutcome =
  | { readonly kind: 'code'; readonly code: string }
  | {
      readonly kind: 'denied'
      readonly error: string
      /** Supabase's reason, e.g. signup_disabled; GitHub's own denial has none. */
      readonly errorCode: string | null
      readonly description: string
    }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'cancelled' }

export interface CallbackPage {
  readonly title: string
  readonly message: string
}

export interface CallbackListener {
  readonly url: string
  /** Settles once: the first callback, the deadline, or the abort signal. */
  readonly outcome: Promise<CallbackOutcome>
  /** Answer the tab that delivered the callback, then stop listening. */
  finish(page: CallbackPage): void
  close(): void
}

export const CALLBACK_PATH = '/auth/callback'
const LEFT_WAITING: CallbackPage = {
  title: 'Return to Phosphor',
  message: 'Phosphor has the sign-in. You can close this tab.',
}
const CANCELLED: CallbackPage = {
  title: 'Sign-in cancelled',
  message: 'The sign-in was cancelled in Phosphor. You can close this tab.',
}
interface CallbackState extends CallbackRequestState {
  port: number
  settled: boolean
  closed: boolean
  held: ServerResponse | null
  holdTimer: NodeJS.Timeout | undefined
  deadline: NodeJS.Timeout | undefined
  readonly server: Server
  readonly signal: AbortSignal | undefined
  readonly onAbort: () => void
  readonly settle: (outcome: CallbackOutcome) => void
}

function end(state: CallbackState, result: CallbackOutcome): void {
  if (state.settled) return
  state.settled = true
  clearTimeout(state.deadline)
  state.settle(result)
}

/** Stop accepting; idle keep-alive sockets go now, the rest within 2 s. */
function shutdown(state: CallbackState): void {
  if (state.closed) return
  state.closed = true
  state.signal?.removeEventListener('abort', state.onAbort)
  state.server.close()
  state.server.closeIdleConnections()
  setTimeout(() => state.server.closeAllConnections(), 2_000).unref()
}

function finish(state: CallbackState, page: CallbackPage): void {
  clearTimeout(state.holdTimer)
  if (state.held) reply(state.held, 200, page)
  state.held = null
  end(state, { kind: 'cancelled' })
  shutdown(state)
}

export async function listenForCallback(
  timeoutMs: number,
  signal?: AbortSignal,
  holdMs = 30_000,
): Promise<CallbackListener> {
  let settle!: (outcome: CallbackOutcome) => void
  const outcome = new Promise<CallbackOutcome>((resolve) => (settle = resolve))
  const path = `${CALLBACK_PATH}/${randomBytes(16).toString('base64url')}`
  // A request that breaks the parser must never become an uncaught exception
  // in the main process, and must never settle the flow.
  const server = createServer((req, res) => {
    try {
      const result = handleCallbackRequest(req, res, state)
      if (!result) return
      state.held = res
      state.holdTimer = setTimeout(() => finish(state, LEFT_WAITING), holdMs)
      end(state, result)
    } catch {
      if (res.headersSent) res.destroy()
      else reply(res, 400, NOT_OURS)
    }
  })
  // An abort answers a held tab at once, even while the flow is still busy
  // with the code it brought; the flow's own later finish() is then a no-op.
  const onAbort = (): void => {
    end(state, { kind: 'cancelled' })
    finish(state, CANCELLED)
  }
  const state: CallbackState = {
    port: 0,
    path,
    settled: false,
    closed: false,
    held: null,
    holdTimer: undefined,
    deadline: undefined,
    server,
    signal,
    onAbort,
    settle,
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  state.port = (server.address() as AddressInfo).port
  state.deadline = setTimeout(() => {
    end(state, { kind: 'timeout' })
    shutdown(state)
  }, timeoutMs)
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })

  return {
    url: `http://127.0.0.1:${state.port}${path}`,
    outcome,
    finish: (page) => finish(state, page),
    close: () => finish(state, LEFT_WAITING),
  }
}
