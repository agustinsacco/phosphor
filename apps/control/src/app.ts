import { browserAuth, isWebHost } from './web/auth'
import { WEB_AUTH_ROUTES } from '@phosphor/shared/web-auth'
import { Hono } from 'hono'
import { CONTROL_LIMITS, CONTROL_ROUTES, type ControlErrorBody } from '@phosphor/shared/control-api'
import { TraceEvents, type EventLog } from './events'
import type { Config } from './config'
import {
  apiHeaders,
  clientIp,
  refuseBody,
  ControlFailure,
  readBytes,
  rawTarget,
  unsafeRawTarget,
  requestMiddleware,
  type Env,
  type RequestLog,
} from './http'
import { createUserAuth } from './auth/user'
import type { NonceCache, RateLimiter } from './limits'
import type { Supabase } from './supabase'
import { serveStatic } from './static'
import { health } from './routes/health'
import { deleteMe, me } from './routes/me'
import { enrollments } from './routes/enrollments'
import { machines } from './routes/machines'
import { hosts, hostAuthentication } from './routes/hosts'
import { grants } from './routes/grants'
import { usage } from './routes/usage'
import { admin } from './routes/admin'

export interface AppDeps {
  config: Config
  clock: () => number
  random: (size: number) => Uint8Array
  fetch: typeof fetch
  log: (entry: RequestLog | EventLog) => void
  supabase: Supabase
  limits: RateLimiter
  nonces: { key: NonceCache; host: NonceCache }
  version: string
}
const routeMethods: Record<string, readonly string[]> = {
  [CONTROL_ROUTES.health]: ['GET'],
  [CONTROL_ROUTES.me]: ['GET', 'DELETE'],
  [CONTROL_ROUTES.enrollments]: ['POST'],
  [CONTROL_ROUTES.enrollmentPoll]: ['POST'],
  [CONTROL_ROUTES.enrollmentLookup]: ['POST'],
  [CONTROL_ROUTES.enrollmentApprove]: ['POST'],
  [CONTROL_ROUTES.machines]: ['GET'],
  [CONTROL_ROUTES.clients]: ['GET', 'POST'],
  [WEB_AUTH_ROUTES.start]: ['GET'],
  [WEB_AUTH_ROUTES.callback]: ['GET'],
  [WEB_AUTH_ROUTES.session]: ['GET'],
  [WEB_AUTH_ROUTES.signout]: ['POST'],
  [CONTROL_ROUTES.grants]: ['POST'],
  [CONTROL_ROUTES.grantKeys]: ['GET'],
  [CONTROL_ROUTES.hostSelf]: ['GET'],
  [CONTROL_ROUTES.hostHeartbeat]: ['POST'],
  [CONTROL_ROUTES.hostRevoke]: ['POST'],
  [CONTROL_ROUTES.usagePing]: ['POST'],
  [CONTROL_ROUTES.adminStats]: ['GET'],
}
/** The methods a registered API path takes; undefined for a path no route owns. */
function allowedMethods(path: string): readonly string[] | undefined {
  const child = (parent: string) =>
    path.startsWith(parent + '/') && path.slice(parent.length + 1).split('/').length === 1
  if (child(CONTROL_ROUTES.machines)) return ['PATCH', 'DELETE']
  if (child(CONTROL_ROUTES.clients)) return ['DELETE']
  return routeMethods[path]
}
export function createApp(deps: AppDeps) {
  const app = new Hono<Env>()
  const events = new TraceEvents(deps.clock, deps.log)
  app.use('*', requestMiddleware(deps.clock, deps.random, deps.log))
  app.use('*', apiHeaders)
  app.use('*', async (c, next) => {
    const target = rawTarget(c.req.raw, c.env)
    if (unsafeRawTarget(target)) {
      if (target.startsWith('/api/')) throw new ControlFailure('bad-request')
      return serveStatic(
        c.req.raw,
        isWebHost(c, deps) ? deps.config.web!.dir : deps.config.siteDir,
        true,
        isWebHost(c, deps),
      )
    }
    await next()
  })
  app.onError((error, c) => {
    const failure = error instanceof ControlFailure ? error : new ControlFailure('internal')
    c.set('error', failure.code)
    const body: ControlErrorBody = { error: { code: failure.code, message: failure.code } }
    return c.newResponse(JSON.stringify(body), failure.status, {
      'Content-Type': 'application/json; charset=utf-8',
    })
  })
  app.use('/api/*', async (c, next) => {
    c.set(
      'ip',
      clientIp(c.req.raw, c.env?.incoming?.socket?.remoteAddress ?? 'unknown', deps.config),
    )
    refuseBody(c.req.raw, c.env)
    const rawBody = await readBytes(c.req.raw.body, CONTROL_LIMITS.bodyBytes)
    c.set('rawBody', rawBody)
    if (rawBody.length || ['POST', 'PATCH', 'PUT'].includes(c.req.method)) {
      if (!/^application\/json(?:\s*;.*)?$/i.test(c.req.header('content-type') ?? ''))
        throw new ControlFailure('unsupported-media-type')
      try {
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody))
      } catch {
        throw new ControlFailure('bad-request')
      }
    }
    if (!deps.config.configured && c.req.path !== CONTROL_ROUTES.health)
      throw new ControlFailure('unavailable')
    const allowed = allowedMethods(c.req.path)
    if (c.req.method === 'OPTIONS' || (allowed && !allowed.includes(c.req.method))) {
      c.header('Allow', (allowed ?? ['GET']).join(', '))
      throw new ControlFailure('bad-request', 405)
    }
    await next()
  })
  app.get('/healthz', (c) => c.json({ ok: true }))
  app.get(CONTROL_ROUTES.health, (c) => c.json(health(deps.config.configured, deps.version)))
  const auth = createUserAuth(deps.supabase, deps.clock, deps.limits)
  const browser = browserAuth(deps, auth)
  if (browser) {
    app.use('/api/*', browser.adapter)
    browser.routes(app)
  }
  const hostAuth = hostAuthentication(deps)
  app.get(CONTROL_ROUTES.me, me(auth, deps.supabase))
  app.delete(
    CONTROL_ROUTES.me,
    deleteMe(auth, deps.supabase, events, (c) => browser?.signedOut(c)),
  )
  enrollments(app, deps, auth, hostAuth, events)
  machines(app, deps, auth, events)
  hosts(app, deps, hostAuth, events)
  grants(app, deps, auth, events)
  usage(app, deps, events)
  admin(app, deps, auth, events)
  app.all('/*', (c) => {
    if (c.req.path.startsWith('/api/')) throw new ControlFailure('not-found')
    return serveStatic(
      c.req.raw,
      isWebHost(c, deps) ? deps.config.web!.dir : deps.config.siteDir,
      false,
      isWebHost(c, deps),
    )
  })
  return app
}
