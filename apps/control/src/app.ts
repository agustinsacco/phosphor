import { Hono } from 'hono'
import { CONTROL_LIMITS, CONTROL_ROUTES, type ControlErrorBody } from '@phosphor/shared/control-api'
import type { Config } from './config'
import {
  apiHeaders,
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
import { me } from './routes/me'

export interface AppDeps {
  config: Config
  clock: () => number
  random: (size: number) => Uint8Array
  fetch: typeof fetch
  log: (entry: RequestLog) => void
  supabase: Supabase
  limits: RateLimiter
  nonces: NonceCache
  version: string
}
export function createApp(deps: AppDeps) {
  const app = new Hono<Env>()
  app.use('*', requestMiddleware(deps.clock, deps.random, deps.log))
  app.use('*', apiHeaders)
  app.use('*', async (c, next) => {
    const target = rawTarget(c.req.raw, c.env)
    if (unsafeRawTarget(target)) {
      if (target.startsWith('/api/')) throw new ControlFailure('bad-request')
      return serveStatic(c.req.raw, deps.config.siteDir, true)
    }
    await next()
  })
  app.onError((error, c) => {
    const failure = error instanceof ControlFailure ? error : new ControlFailure('internal')
    const body: ControlErrorBody = { error: { code: failure.code, message: failure.code } }
    return c.newResponse(JSON.stringify(body), failure.status, {
      'Content-Type': 'application/json; charset=utf-8',
    })
  })
  app.use('/api/*', async (c, next) => {
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
    if (
      c.req.method === 'OPTIONS' ||
      ([CONTROL_ROUTES.health, CONTROL_ROUTES.me].some((path) => path === c.req.path) &&
        c.req.method !== 'GET')
    ) {
      c.header('Allow', 'GET')
      throw new ControlFailure('bad-request', 405)
    }
    await next()
  })
  app.get('/healthz', (c) => c.json({ ok: true }))
  app.get(CONTROL_ROUTES.health, (c) => c.json(health(deps.config.configured, deps.version)))
  app.get(CONTROL_ROUTES.me, me(createUserAuth(deps.supabase, deps.clock), deps.supabase))
  app.all('/*', (c) => {
    if (c.req.path.startsWith('/api/')) throw new ControlFailure('not-found')
    return serveStatic(c.req.raw, deps.config.siteDir)
  })
  return app
}
