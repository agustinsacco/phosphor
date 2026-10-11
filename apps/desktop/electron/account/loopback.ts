import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

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
const CODE = /^[A-Za-z0-9._~-]{8,512}$/
const LEFT_WAITING: CallbackPage = {
  title: 'Return to Phosphor',
  message: 'Phosphor has the sign-in. You can close this tab.',
}
const CANCELLED: CallbackPage = {
  title: 'Sign-in cancelled',
  message: 'The sign-in was cancelled in Phosphor. You can close this tab.',
}
const NOT_OURS: CallbackPage = { title: 'Not found', message: 'Nothing here.' }

const escape = (value: string): string => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function reply(res: ServerResponse, status: number, page: CallbackPage): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    connection: 'close',
  })
  res.end(
    `<!doctype html><meta charset="utf-8"><title>${escape(page.title)}</title>` +
      '<body style="font:16px system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem">' +
      `<h1 style="font-size:1.4rem">${escape(page.title)}</h1><p>${escape(page.message)}</p>`,
  )
}

export async function listenForCallback(
  timeoutMs: number,
  signal?: AbortSignal,
  holdMs = 30_000,
): Promise<CallbackListener> {
  let settle!: (outcome: CallbackOutcome) => void
  const outcome = new Promise<CallbackOutcome>((resolve) => (settle = resolve))
  let settled = false
  let closed = false
  let held: ServerResponse | null = null
  let holdTimer: NodeJS.Timeout | undefined
  let port = 0
  const path = `${CALLBACK_PATH}/${randomBytes(16).toString('base64url')}`

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const origin = `http://127.0.0.1:${port}`
    if (req.headers.host !== `127.0.0.1:${port}`) {
      return reply(res, 421, { title: 'Wrong address', message: 'Use 127.0.0.1.' })
    }
    // Throws on "//" and friends; absolute-form or "/\host" parse to another origin.
    const url = new URL(req.url ?? '', origin)
    if (req.method !== 'GET' || url.origin !== origin || url.pathname !== path) {
      return reply(res, 404, NOT_OURS)
    }
    if (settled) {
      const page = { title: 'Link already used', message: 'Return to Phosphor and try again.' }
      return reply(res, 410, page)
    }
    const code = url.searchParams.get('code')
    const error = url.searchParams.get('error')
    let result: CallbackOutcome
    if (code && CODE.test(code)) result = { kind: 'code', code }
    else if (error) {
      result = {
        kind: 'denied',
        error: error.slice(0, 100),
        errorCode: url.searchParams.get('error_code')?.slice(0, 100) ?? null,
        description: (url.searchParams.get('error_description') ?? '').slice(0, 300),
      }
    } else {
      return reply(res, 400, { title: 'Not a sign-in', message: 'This address expects Supabase.' })
    }
    held = res
    holdTimer = setTimeout(() => finish(LEFT_WAITING), holdMs)
    end(result)
  }

  // A request that breaks the parser above must never become an uncaught
  // exception in the main process, and must never settle the flow.
  const server = createServer((req, res) => {
    try {
      handle(req, res)
    } catch {
      if (res.headersSent) res.destroy()
      else reply(res, 400, NOT_OURS)
    }
  })

  function end(result: CallbackOutcome): void {
    if (settled) return
    settled = true
    clearTimeout(deadline)
    settle(result)
  }

  /** Stop accepting; idle keep-alive sockets go now, the rest within 2 s. */
  function shutdown(): void {
    if (closed) return
    closed = true
    signal?.removeEventListener('abort', onAbort)
    server.close()
    server.closeIdleConnections()
    setTimeout(() => server.closeAllConnections(), 2_000).unref()
  }

  function finish(page: CallbackPage): void {
    clearTimeout(holdTimer)
    if (held) reply(held, 200, page)
    held = null
    end({ kind: 'cancelled' })
    shutdown()
  }

  // An abort answers a held tab at once, even while the flow is still busy
  // with the code it brought; the flow's own later finish() is then a no-op.
  const onAbort = (): void => {
    end({ kind: 'cancelled' })
    finish(CANCELLED)
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  port = (server.address() as AddressInfo).port
  const deadline = setTimeout(() => {
    end({ kind: 'timeout' })
    shutdown()
  }, timeoutMs)
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })

  const close = (): void => finish(LEFT_WAITING)
  return { url: `http://127.0.0.1:${port}${path}`, outcome, finish, close }
}
