import { effectiveAuthorization } from '../web/effective-token'
import type { Handler } from 'hono'
import { account, type createUserAuth } from '../auth/user'
import type { Env } from '../http'
import type { Supabase } from '../supabase'
export function me(auth: ReturnType<typeof createUserAuth>, supabase: Supabase): Handler<Env> {
  return async (c) => {
    const user = await auth(effectiveAuthorization(c), c.get('ip'))
    c.set('actor', `user:${user.userId}`)
    return c.json(await account(supabase, user))
  }
}
