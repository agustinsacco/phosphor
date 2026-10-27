import { effectiveAuthorization } from './effective-token'
import { createHash } from 'node:crypto'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import { CONTROL_ROUTES, parseClientRegisterResponse } from '@phosphor/shared/control-api'
import {
  WEB_AUTH_ROUTES as ROUTES,
  WEB_CSRF_HEADER,
  type WebSessionResponse,
} from '@phosphor/shared/web-auth'
import type { AppDeps } from '../app'
import { account, type createUserAuth } from '../auth/user'
import { ControlFailure, type Env } from '../http'
import { RateLimiter } from '../limits'
import { outcome, parsed, record } from '../routes/shared'
import { BrowserSessions } from './session'

export function isWebHost(c: Context<Env>, deps: AppDeps): boolean {
  const configured = deps.config.web
  if (!configured) return false
  // Never use Forwarded/X-Forwarded-Host or request-derived redirect origins.
  const host = c.env?.incoming?.headers.host ?? c.req.header('host') ?? new URL(c.req.url).host
  return host === configured.host
}
function csrf(c: Context<Env>, expected: string, deps: AppDeps) {
  if (
    c.req.header('origin') !== deps.config.web!.origin ||
    c.req.header(WEB_CSRF_HEADER) !== expected
  )
    throw new ControlFailure('forbidden')
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
export function browserAuth(deps: AppDeps, auth: ReturnType<typeof createUserAuth>) {
  if (!deps.config.web) return null
  const config = deps.config.web
  const sessions = new BrowserSessions(deps, auth)
  const used = new Map<string, number>()
  const starts = new RateLimiter(deps.clock, 10_000)
  const random = () => Buffer.from(deps.random(32)).toString('base64url')
  const adapter: MiddlewareHandler<Env> = async (c, next) => {
    if (!isWebHost(c, deps)) {
      if (c.req.path.startsWith('/api/auth/')) throw new ControlFailure('not-found')
      await next()
      return
    }
    if (c.req.path === ROUTES.start || c.req.path === ROUTES.callback) {
      await next()
      return
    }
    if (c.req.header('origin') && c.req.header('origin') !== config.origin)
      throw new ControlFailure('forbidden')
    if (c.req.header('authorization')) {
      // The app surface is cookie-only. The site/native API remains bearer-only.
      throw new ControlFailure('bad-request')
    }
    // Public keys must never carry a session Set-Cookie on their cacheable response.
    if (c.req.path === CONTROL_ROUTES.grantKeys) {
      await next()
      return
    }
    const session = sessions.read(c)
    if (c.req.path === ROUTES.signout) {
      await next()
      return
    }
    if (session) {
      if (!['GET', 'HEAD'].includes(c.req.method)) csrf(c, session.csrf, deps)
      try {
        const resolved = await sessions.resolve(c, session)
        c.set('effectiveAuthorization', `Bearer ${resolved.accessToken}`)
        c.set('webClientId', resolved.clientId)
        c.set('webCsrf', resolved.csrf)
      } catch (error) {
        if (error instanceof ControlFailure && error.code === 'unauthenticated')
          sessions.cookies.clear(c, 'session')
        throw error
      }
    }
    await next()
  }
  function routes(app: Hono<Env>) {
    app.get(ROUTES.start, async (c) => {
      if (c.req.header('authorization')) throw new ControlFailure('bad-request')
      // Refuse cross-site navigation initiation; ordinary top-level address-bar navigation is allowed.
      const origin = c.req.header('origin')
      if (
        (origin && origin !== config.origin) ||
        ['cross-site', 'same-site'].includes(c.req.header('sec-fetch-site') ?? '')
      )
        throw new ControlFailure('forbidden')
      if (sessions.read(c)) throw new ControlFailure('conflict')
      if (!starts.consume(c.get('ip'), 10, 600_000)) throw new ControlFailure('too-many-requests')
      const state = random(),
        verifier = random()
      sessions.cookies.write(c, 'transaction', {
        state,
        verifier,
        path: returnPath(c.req.query('returnTo')),
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
    })
    app.get(ROUTES.callback, async (c) => {
      sessions.cookies.clear(c, 'transaction')
      if (c.req.header('authorization') || sessions.read(c)) throw new ControlFailure('bad-request')
      const transaction = sessions.cookies.read(c, 'transaction')
      const query = new URL(c.req.url).searchParams
      const code = query.get('code'),
        state = query.get('state')
      if (
        !transaction ||
        !state ||
        !/^[\w-]{43}$/.test(state) ||
        state !== transaction.state ||
        typeof transaction.verifier !== 'string' ||
        !/^[\w-]{43}$/.test(transaction.verifier) ||
        !code ||
        !/^[\w-]{1,512}$/.test(code) ||
        query.getAll('code').length !== 1 ||
        query.getAll('state').length !== 1 ||
        [...query.keys()].some((key) => !['code', 'state'].includes(key))
      )
        throw new ControlFailure('unauthenticated')
      for (const [id, until] of used) if (until <= deps.clock()) used.delete(id)
      if (used.has(state)) throw new ControlFailure('unauthenticated')
      if (used.size >= 10_000) throw new ControlFailure('too-many-requests')
      used.set(state, Number(transaction.until))
      const tokens = await sessions.provider.exchange(code, transaction.verifier)
      const user = await auth(`Bearer ${tokens.accessToken}`, c.get('ip'))
      if (user.userId !== tokens.userId) throw new ControlFailure('unauthenticated')
      if (!(await account(deps.supabase, user)).enabled) throw new ControlFailure('forbidden')
      if (!deps.limits.consume('client-register:' + user.userId, 10, 3_600_000))
        throw new ControlFailure('too-many-requests')
      const value = record(
        await deps.supabase.rpc('control_client_register', {
          p_user: user.userId,
          p_kind: 'web',
          p_label: 'Web browser',
        }),
      )
      outcome(value, 'registered')
      const client = parsed(parseClientRegisterResponse(value)).client
      sessions.cookies.write(c, 'session', {
        ...tokens,
        clientId: client.id,
        csrf: random(),
        until: deps.clock() + 86_400_000,
      })
      return c.redirect(
        returnPath(typeof transaction.path === 'string' ? transaction.path : undefined),
        303,
      )
    })
    app.get(ROUTES.session, async (c) => {
      if (!c.get('webClientId')) throw new ControlFailure('unauthenticated')
      const user = await auth(effectiveAuthorization(c), c.get('ip'))
      if (!(await account(deps.supabase, user)).enabled) throw new ControlFailure('forbidden')
      return c.json({
        user: { id: user.userId, login: user.login },
        clientId: c.get('webClientId'),
        csrfToken: c.get('webCsrf'),
      } satisfies WebSessionResponse)
    })
    app.post(ROUTES.signout, async (c) => {
      const session = sessions.read(c)
      if (!session) throw new ControlFailure('unauthenticated')
      csrf(c, session.csrf, deps)
      return c.json(await sessions.logout(c, session))
    })
  }
  return { adapter, routes, signedOut: signedOut(sessions) }
}
/**
 * After the account itself is gone, the browser only needs to forget it. The
 * adapter re-sealed the session on admission; drop that so only the clear is sent.
 */
function signedOut(sessions: BrowserSessions) {
  return (c: Context<Env>) => {
    c.header('Set-Cookie', undefined)
    sessions.cookies.clear(c, 'session')
  }
}
