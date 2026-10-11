import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * The one-shot address the browser comes back to after GitHub (RFC 8252
 * section 7.3): loopback only, a port the OS picks, one path, one use.
 *
 * Supabase sends only the authorization code here. It is worthless without
 * the PKCE verifier, which never leaves the main process, so this server needs
 * no state parameter of its own: a forged or replayed code fails the exchange.
 * The Host check refuses a DNS-rebound page that reaches the port by name.
 */

export type CallbackOutcome =
  | { readonly kind: 'code'; readonly code: string }
  | { readonly kind: 'denied'; readonly error: string; readonly description: string }
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

  const server = createServer((req, res) => {
    if (req.headers.host !== `127.0.0.1:${port}`) {
      return reply(res, 421, { title: 'Wrong address', message: 'Use 127.0.0.1.' })
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
      return reply(res, 404, { title: 'Not found', message: 'Nothing here.' })
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
      const description = url.searchParams.get('error_description') ?? ''
      result = {
        kind: 'denied',
        error: error.slice(0, 100),
        description: description.slice(0, 300),
      }
    } else {
      return reply(res, 400, { title: 'Not a sign-in', message: 'This address expects Supabase.' })
    }
    held = res
    holdTimer = setTimeout(() => finish(LEFT_WAITING), holdMs)
    end(result)
  })

  function end(result: CallbackOutcome): void {
    if (settled) return
    settled = true
    clearTimeout(deadline)
    signal?.removeEventListener('abort', onAbort)
    settle(result)
  }

  /** Stop accepting; idle keep-alive sockets go now, the rest within 2 s. */
  function shutdown(): void {
    if (closed) return
    closed = true
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

  // A held tab is still answered by finish(): the flow says "cancelled" there.
  const onAbort = (): void => {
    end({ kind: 'cancelled' })
    if (!held) shutdown()
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
  return { url: `http://127.0.0.1:${port}${CALLBACK_PATH}`, outcome, finish, close }
}
