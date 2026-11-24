import { isUuid } from '@phosphor/shared/control-api'
import type { AppDeps } from '../app'
import { ControlFailure, readBytes } from '../http'
import { record } from '../routes/shared'

/** Who signed in: the exchange's own answer, read straight from Supabase over TLS. */
export interface ProviderIdentity {
  userId: string
  sid: string
  login: string | null
}
function claims(token: unknown) {
  try {
    if (typeof token !== 'string' || token.length > 4096 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token))
      throw new Error()
    return record(JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')))
  } catch {
    throw new ControlFailure('unavailable')
  }
}
/**
 * The browser's one call to Supabase Auth: trade the PKCE code for the identity. Tokens are
 * discarded; the session row, not a refresh token, keeps the browser signed in.
 */
export function webProvider(deps: AppDeps) {
  async function token(body: unknown): Promise<unknown> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(new ControlFailure('unavailable'))
          }, 5000)
        }),
        (async () => {
          const res = await deps.fetch(`${deps.config.supabaseUrl}/auth/v1/token?grant_type=pkce`, {
            method: 'POST',
            redirect: 'error',
            credentials: 'omit',
            signal: controller.signal,
            headers: { apikey: deps.config.publishableKey, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          if (!res.ok) {
            void res.body?.cancel().catch(() => {})
            throw new ControlFailure(
              [400, 401, 403].includes(res.status) ? 'unauthenticated' : 'unavailable',
            )
          }
          const bytes = await readBytes(res.body, 64 * 1024, controller.signal)
          return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        })(),
      ])
    } catch (error) {
      if (error instanceof ControlFailure && error.code === 'unauthenticated') throw error
      throw new ControlFailure('unavailable')
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    async exchange(code: string, verifier: string): Promise<ProviderIdentity> {
      const value = record(await token({ auth_code: code, code_verifier: verifier }))
      const user = record(value.user)
      const access = claims(value.access_token)
      if (
        !isUuid(user.id) ||
        access.sub !== user.id ||
        access.aud !== 'authenticated' ||
        !isUuid(access.session_id)
      )
        throw new ControlFailure('unavailable')
      const meta = user.user_metadata
      const name = meta && typeof meta === 'object' && 'user_name' in meta ? meta.user_name : null
      return {
        userId: user.id,
        sid: access.session_id,
        login: typeof name === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(name) ? name : null,
      }
    },
  }
}
