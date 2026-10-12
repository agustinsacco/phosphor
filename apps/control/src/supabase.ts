import type { Config } from './config'
import { ControlFailure, readBytes } from './http'

export interface Supabase {
  getUser(token: string): Promise<unknown>
  rpc(name: string, args: Record<string, unknown>): Promise<unknown>
}
export function createSupabase(config: Config, fetcher: typeof fetch): Supabase {
  async function call(path: string, init: RequestInit, auth = false): Promise<unknown> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new ControlFailure('unavailable'))
      }, 5000)
    })
    try {
      return await Promise.race([
        timeout,
        (async () => {
          const response = await fetcher(`${config.supabaseUrl}${path}`, {
            ...init,
            signal: controller.signal,
            redirect: 'error',
          })
          if (auth && [401, 403].includes(response.status)) {
            void response.body?.cancel().catch(() => {})
            throw new ControlFailure('unauthenticated')
          }
          if (!response.ok) {
            void response.body?.cancel().catch(() => {})
            throw new ControlFailure('unavailable')
          }
          const bytes = await readBytes(response.body, 64 * 1024, controller.signal)
          return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        })(),
      ])
    } catch (error) {
      if (error instanceof ControlFailure && error.code === 'unauthenticated') throw error
      throw new ControlFailure('unavailable')
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  return {
    getUser: (token) =>
      call(
        '/auth/v1/user',
        { headers: { apikey: config.publishableKey, Authorization: `Bearer ${token}` } },
        true,
      ),
    rpc: (name, args) => {
      if (!/^control_[a-z_]{1,64}$/.test(name)) throw new ControlFailure('internal')
      // https://supabase.com/docs/guides/api/api-keys: sb_secret_ keys are not
      // JWTs. The gateway maps apikey to service_role; never use them as Bearer.
      // Local status exposes SECRET_KEY and PUBLISHABLE_KEY (values not logged).
      return call(`/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: {
          apikey: config.secretKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(args),
      })
    },
  }
}
