import { createHash } from 'node:crypto'
import type { Context, Handler, Hono, MiddlewareHandler } from 'hono'
import { CONTROL_ROUTES } from '@phosphor/shared/control-api'
import {
  WEB_AUTH_ROUTES as ROUTES,
  WEB_CSRF_HEADER,
  WEB_SIGNIN_ERROR_PARAM,
  type WebSessionResponse,
  type WebSignoutResponse,
} from '@phosphor/shared/web-auth'
import type { AppDeps } from '../app'
import { ControlFailure, type Env } from '../http'
import { webProvider } from './provider'
import { webSessions } from './session'

export function isWebHost(c: Context<Env>, deps: AppDeps): boolean {
  const configured = deps.config.web
  if (!configured) return false
  // Never use Forwarded/X-Forwarded-Host or request-derived redirect origins.
  const host = c.env?.incoming?.headers.host ?? c.req.header('host') ?? new URL(c.req.url).host
  return host === configured.host
}
function returnPath(value: string | undefined) {
  const path = value ?? '/'
  if (
    path.length > 512 ||
    !/^\/(?:[A-Za-z0-9_/-]*)$/.test(path) ||
    path.includes('//') ||
    path === '/api' ||
    path.startsWith('/api/')
  )
    throw new ControlFailure('bad-request')
  return path
}
/** Sign-in is a page navigation: a failure lands on the app with its code, never on JSON. */
function page(handler: Handler<Env>): Handler<Env> {
  return async (c, next) => {
    try {
      return await handler(c, next)
    } catch (error) {
      const code = error instanceof ControlFailure ? error.code : 'internal'
      c.set('error', code)
      return c.redirect(`/?${WEB_SIGNIN_ERROR_PARAM}=${code}`, 303)
    }
  }
}
export function browserAuth(deps: AppDeps) {
  if (!deps.config.web) return null
  const config = deps.config.web
  const sessions = webSessions(deps)
  const provider = webProvider(deps)
  const random = () => Buffer.from(deps.random(32)).toString('base64url')
  const adapter: MiddlewareHandler<Env> = async (c, next) => {
    if (!isWebHost(c, deps)) {
      if (c.req.path.startsWith('/api/auth/')) throw new ControlFailure('not-found')
      return next()
    }
    if (c.req.path === ROUTES.start || c.req.path === ROUTES.callback) return next()
    if (c.req.header('origin') && c.req.header('origin') !== config.origin)
      throw new ControlFailure('forbidden')
    // The app surface is cookie-only. The site/native API remains bearer-only.
    if (c.req.header('authorization')) throw new ControlFailure('bad-request')
    // Public keys must never carry a session Set-Cookie on their cacheable response.
    if (c.req.path === CONTROL_ROUTES.grantKeys) return next()
    const session = await sessions.read(c)
    if (session) {
      if (
        !['GET', 'HEAD'].includes(c.req.method) &&
        (c.req.header('origin') !== config.origin || c.req.header(WEB_CSRF_HEADER) !== session.csrf)
      )
        throw new ControlFailure('forbidden')
      c.set('user', session.user)
      c.set('web', { clientId: session.clientId, csrf: session.csrf })
    }
    return next()
  }
  function routes(app: Hono<Env>) {
    app.get(
      ROUTES.start,
      page(async (c) => {
        if (c.req.header('authorization')) throw new ControlFailure('bad-request')
        // Refuse cross-site initiation; ordinary top-level address-bar navigation is allowed.
        const origin = c.req.header('origin')
        if (
          (origin && origin !== config.origin) ||
          ['cross-site', 'same-site'].includes(c.req.header('sec-fetch-site') ?? '')
        )
          throw new ControlFailure('forbidden')
        const path = returnPath(c.req.query('returnTo'))
        if (await sessions.read(c)) return c.redirect(path, 303)
        const state = random(),
          verifier = random()
        sessions.cookies.writeTransaction(c, {
          state,
          verifier,
          path,
          until: deps.clock() + 600_000,
        })
        const callback = new URL(ROUTES.callback, config.origin)
        callback.searchParams.set('state', state)
        const url = new URL('/auth/v1/authorize', deps.config.supabaseUrl)
        url.searchParams.set('provider', 'github')
        url.searchParams.set('redirect_to', callback.href)
        url.searchParams.set('code_challenge_method', 's256')
        url.searchParams.set(
          'code_challenge',
          createHash('sha256').update(verifier).digest('base64url'),
        )
        return c.redirect(url.href, 302)
      }),
    )
    app.get(
      ROUTES.callback,
      page(async (c) => {
        if (c.req.header('authorization')) throw new ControlFailure('bad-request')
        const transaction = sessions.cookies.readTransaction(c)
        sessions.cookies.clear(c, 'transaction')
        const path = returnPath(typeof transaction?.path === 'string' ? transaction.path : '/')
        // A second tap on the way back: already signed in, nothing to exchange.
        if (await sessions.read(c)) return c.redirect(path, 303)
        // The sealed transaction holds the state and verifier; Supabase's code is single-use.
        const query = new URL(c.req.url).searchParams
        const code = query.get('code')
        if (
          !transaction ||
          query.get('state') !== transaction.state ||
          typeof transaction.verifier !== 'string' ||
          !code ||
          !/^[\w-]{1,512}$/.test(code)
        )
          throw new ControlFailure('unauthenticated')
        await sessions.create(c, await provider.exchange(code, transaction.verifier))
        return c.redirect(path, 303)
      }),
    )
    app.get(ROUTES.session, (c) => {
      const web = c.get('web')
      if (!web) throw new ControlFailure('unauthenticated')
      const user = c.get('user')
      return c.json({
        user: { id: user.userId, login: user.login },
        clientId: web.clientId,
        csrfToken: web.csrf,
      } satisfies WebSessionResponse)
    })
    app.post(ROUTES.signout, async (c) => {
      if (!c.get('web')) throw new ControlFailure('unauthenticated')
      await sessions.end(c)
      return c.json({ signedOut: true, remoteCleanup: 'complete' } satisfies WebSignoutResponse)
    })
  }
  /**
   * After the account itself is gone, the browser only needs to forget it. Drop any
   * renewal the adapter queued so only the clear is sent.
   */
  function signedOut(c: Context<Env>) {
    c.header('Set-Cookie', undefined)
    sessions.cookies.clear(c, 'session')
  }
  return { adapter, routes, signedOut }
}
