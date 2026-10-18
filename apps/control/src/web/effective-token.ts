import type { Context } from 'hono'
import type { Env } from '../http'

/** The only token source after the browser adapter has admitted a bound session. */
export function effectiveAuthorization(c: Context<Env>): string | undefined {
  return c.get('effectiveAuthorization') ?? c.req.header('authorization')
}
