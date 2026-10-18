import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CallbackOutcome, CallbackPage } from './loopback'

const CODE = /^[A-Za-z0-9._~-]{8,512}$/
export const NOT_OURS: CallbackPage = { title: 'Not found', message: 'Nothing here.' }

const escape = (value: string): string => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export function reply(res: ServerResponse, status: number, page: CallbackPage): void {
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

export interface CallbackRequestState {
  readonly port: number
  readonly path: string
  readonly settled: boolean
}

/** Validate the request before the listener spends its one use or holds the tab. */
export function handleCallbackRequest(
  req: IncomingMessage,
  res: ServerResponse,
  state: CallbackRequestState,
): CallbackOutcome | null {
  const origin = `http://127.0.0.1:${state.port}`
  if (req.headers.host !== `127.0.0.1:${state.port}`) {
    reply(res, 421, { title: 'Wrong address', message: 'Use 127.0.0.1.' })
    return null
  }
  // Throws on "//" and friends; absolute-form or "/\host" parse to another origin.
  const url = new URL(req.url ?? '', origin)
  if (req.method !== 'GET' || url.origin !== origin || url.pathname !== state.path) {
    reply(res, 404, NOT_OURS)
    return null
  }
  if (state.settled) {
    const page = { title: 'Link already used', message: 'Return to Phosphor and try again.' }
    reply(res, 410, page)
    return null
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
    reply(res, 400, { title: 'Not a sign-in', message: 'This address expects Supabase.' })
    return null
  }
  return result
}
