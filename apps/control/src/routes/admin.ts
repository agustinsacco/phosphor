/**
 * The owner-only summary. Exactly one person may read it: the GitHub account
 * whose numeric id is ADMIN_GITHUB_ID. Three locks, all required on every request:
 *
 *  1. This constant, which only a reviewed change can alter.
 *  2. The database's control_private.admins table. Its check constraint admits
 *     this id alone, no API role can read or write it, and it ships empty: an
 *     operator adds the row by hand, and deleting the row revokes access at once.
 *  3. Supabase's record that the signed-in user holds that GitHub identity,
 *     written only by a completed GitHub sign-in.
 *
 * A login is never trusted: users can edit their own metadata, and GitHub reuses
 * names. The PWA is the only client, over its cookie session, and the response
 * holds aggregate counts only: no user, login, address, label or hostname.
 */
import type { Hono } from 'hono'
import { CONTROL_ROUTES, parseAdminStats } from '@phosphor/shared/control-api'
import type { AppDeps } from '../app'
import { userGuard, type createUserAuth } from '../auth/user'
import type { TraceEvents } from '../events'
import { ControlFailure, type Env } from '../http'
import { isWebHost } from '../web/auth'
import { parsed } from './shared'

/** github.com/agustinsacco. `gh api users/agustinsacco --jq .id` */
export const ADMIN_GITHUB_ID = '5874561'
export const ADMIN_READS_PER_MINUTE = 60

export function admin(
  app: Hono<Env>,
  deps: AppDeps,
  auth: ReturnType<typeof createUserAuth>,
  events: TraceEvents,
) {
  const guard = userGuard(auth, deps.supabase)
  app.get(
    CONTROL_ROUTES.adminStats,
    async (c, next) => {
      // A browser session on the app origin, never a native bearer token.
      if (!isWebHost(c, deps) || !c.get('webClientId')) throw new ControlFailure('not-found')
      await next()
    },
    guard,
    async (c) => {
      const { userId } = c.get('user')
      if (!deps.limits.consume(`admin-read:${userId}`, ADMIN_READS_PER_MINUTE, 60_000))
        throw new ControlFailure('too-many-requests')
      const admitted = await deps.supabase.rpc('control_admin_check', {
        p_user_id: userId,
        p_github_id: ADMIN_GITHUB_ID,
      })
      // Anyone else learns only that there is nothing here.
      if (admitted !== true) throw new ControlFailure('not-found')
      const stats = parsed(parseAdminStats(await deps.supabase.rpc('control_admin_stats', {})))
      events.emit(c, 'admin.read', { userId })
      return c.json(stats)
    },
  )
}
