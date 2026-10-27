/**
 * Anonymous usage counts: the daily ping from Desktop and the Host, and the
 * counted download links on the site. Each adds one to a per-day counter. No
 * address, user agent, account or identifier is stored, logged or passed on.
 *
 * The rate limits key on an HMAC of the caller's address under a key that lives
 * only in this process, so even the in-memory limiter never holds an address.
 */
import { createHmac } from 'node:crypto'
import type { Hono } from 'hono'
import {
  CONTROL_ROUTES,
  DOWNLOAD_ARTIFACTS,
  DOWNLOAD_PATH_PREFIX,
  parseUsagePing,
  type DownloadArtifact,
} from '@phosphor/shared/control-api'
import type { AppDeps } from '../app'
import type { TraceEvents } from '../events'
import { clientIp, ControlFailure, type Env } from '../http'
import { isWebHost } from '../web/auth'
import { body, outcome, parsed, record } from './shared'

const RELEASES = 'https://github.com/agustinsacco/Phosphor/releases'
/** Fixed targets: nothing from the request reaches a redirect. */
export const DOWNLOAD_TARGETS: Readonly<Record<DownloadArtifact, string>> = Object.freeze({
  latest: `${RELEASES}/latest`,
  'install-sh': `${RELEASES}/latest/download/install.sh`,
})
/** Over a limit the caller sees the same answer; it just isn't counted. */
export const USAGE_LIMITS = Object.freeze({
  pingsPerAddressPerDay: 20,
  downloadsPerAddressPerHour: 20,
})
const isArtifact = (value: string): value is DownloadArtifact =>
  (DOWNLOAD_ARTIFACTS as readonly string[]).includes(value)

export function usage(app: Hono<Env>, deps: AppDeps, events: TraceEvents) {
  const key = deps.random(32)
  const subject = (ip: string) =>
    createHmac('sha256', key).update(ip).digest('base64url').slice(0, 22)

  app.post(CONTROL_ROUTES.usagePing, async (c) => {
    // Desktop and the Host send this; a browser page never can, and no account rides along.
    if (isWebHost(c, deps)) throw new ControlFailure('not-found')
    if (c.req.header('origin')) throw new ControlFailure('forbidden')
    if (c.req.header('authorization')) throw new ControlFailure('bad-request')
    const ping = parsed(parseUsagePing(body(c)), 'bad-request')
    const { pingsPerAddressPerDay } = USAGE_LIMITS
    if (
      deps.limits.consume(`usage-ping:${subject(c.get('ip'))}`, pingsPerAddressPerDay, 86_400_000)
    )
      outcome(
        record(
          await deps.supabase.rpc('control_usage_ping', {
            p_product: ping.product,
            p_version: ping.version,
            p_os: ping.os,
            p_arch: ping.arch,
            p_first: ping.first,
            p_new_week: ping.newWeek,
            p_new_month: ping.newMonth,
          }),
        ),
        'counted',
      )
    return c.body(null, 204)
  })

  app.get(`${DOWNLOAD_PATH_PREFIX}:artifact`, async (c, next) => {
    const artifact = c.req.param('artifact')
    // Anything else, and every path on the app origin, is the static site's 404.
    if (isWebHost(c, deps) || !isArtifact(artifact)) return next()
    const ip = clientIp(c.req.raw, c.env?.incoming?.socket?.remoteAddress ?? 'unknown', deps.config)
    const { downloadsPerAddressPerHour } = USAGE_LIMITS
    if (
      c.req.method === 'GET' &&
      deps.limits.consume(`usage-download:${subject(ip)}`, downloadsPerAddressPerHour, 3_600_000)
    )
      // The redirect never waits on the database.
      deps.supabase.rpc('control_usage_download', { p_artifact: artifact }).catch(() => {
        events.emit(c, 'usage.download', { result: 'unrecorded', reason: artifact })
      })
    c.header('Cache-Control', 'no-store')
    c.header('Referrer-Policy', 'no-referrer')
    c.header('X-Robots-Tag', 'noindex, nofollow')
    return c.redirect(DOWNLOAD_TARGETS[artifact], 302)
  })
}
