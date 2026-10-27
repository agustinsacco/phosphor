import { effectiveAuthorization } from '../web/effective-token'
import type { Context, Handler } from 'hono'
import { account, type createUserAuth } from '../auth/user'
import type { TraceEvents } from '../events'
import type { Env } from '../http'
import type { Supabase } from '../supabase'
import { outcome, record } from './shared'
export function me(auth: ReturnType<typeof createUserAuth>, supabase: Supabase): Handler<Env> {
  return async (c) => {
    const user = await auth(effectiveAuthorization(c), c.get('ip'))
    c.set('actor', `user:${user.userId}`)
    return c.json(await account(supabase, user))
  }
}
/**
 * Deletes the caller's own account. Every directory row references the user with
 * `on delete cascade`, so their Hosts, clients, enrollments, grants and audit
 * events go with it, as do Supabase's identities and sessions: each Host's next
 * heartbeat hears `gone` and stops. The anonymous usage counters hold no user and
 * are untouched. A suspended account may still delete itself. Like every DELETE,
 * it carries no body: the client asks the person to confirm before it calls.
 */
export function deleteMe(
  auth: ReturnType<typeof createUserAuth>,
  supabase: Supabase,
  events: TraceEvents,
  signedOut: (c: Context<Env>) => void,
): Handler<Env> {
  return async (c) => {
    const user = await auth(effectiveAuthorization(c), c.get('ip'))
    c.set('actor', `user:${user.userId}`)
    outcome(
      record(await supabase.rpc('control_account_delete', { p_user_id: user.userId })),
      'deleted',
    )
    events.emit(c, 'account.deleted', { userId: user.userId })
    signedOut(c)
    return c.body(null, 204)
  }
}
