import { isUuid } from '@phosphor/shared/control-api'
import type { AppDeps } from '../app'
import { ControlFailure, readBytes } from '../http'
import { record } from '../routes/shared'

export function tokenClaims(token: string) {
  try {
    if (token.length > 4096 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) throw new Error()
    const claims = record(
      JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')),
    )
    if (
      !isUuid(claims.sub) ||
      !isUuid(claims.session_id) ||
      claims.aud !== 'authenticated' ||
      !Number.isSafeInteger(claims.exp)
    )
      throw new Error()
    return { userId: claims.sub, sid: claims.session_id, expires: Number(claims.exp) * 1000 }
  } catch {
    throw new ControlFailure('unauthenticated')
  }
}
export function webProvider(deps: AppDeps) {
  async function post(path: string, body?: unknown, token?: string): Promise<unknown> {
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
          const res = await deps.fetch(`${deps.config.supabaseUrl}/auth/v1/${path}`, {
            method: 'POST',
            redirect: 'error',
            credentials: 'omit',
            signal: controller.signal,
            headers: {
              apikey: deps.config.publishableKey,
              'content-type': 'application/json',
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          })
          if (!res.ok) {
            void res.body?.cancel().catch(() => {})
            throw new ControlFailure(
              [400, 401, 403].includes(res.status) ? 'unauthenticated' : 'unavailable',
            )
          }
          const bytes = await readBytes(res.body, 64 * 1024, controller.signal)
          return bytes.length
            ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
            : null
        })(),
      ])
    } catch (error) {
      if (error instanceof ControlFailure && error.code === 'unauthenticated') throw error
      throw new ControlFailure('unavailable')
    } finally {
      clearTimeout(timer)
    }
  }
  async function session(path: string, body: unknown) {
    const value = record(await post(path, body))
    if (
      typeof value.access_token !== 'string' ||
      typeof value.refresh_token !== 'string' ||
      !/^[\w.-]{1,2048}$/.test(value.refresh_token) ||
      typeof value.expires_in !== 'number' ||
      !Number.isSafeInteger(value.expires_in) ||
      value.expires_in < 1 ||
      value.expires_in > 86400
    )
      throw new ControlFailure('unavailable')
    const claims = tokenClaims(value.access_token)
    if (claims.expires <= deps.clock() || record(value.user).id !== claims.userId)
      throw new ControlFailure('unauthenticated')
    return { accessToken: value.access_token, refreshToken: value.refresh_token, ...claims }
  }
  return {
    exchange: (code: string, verifier: string) =>
      session('token?grant_type=pkce', { auth_code: code, code_verifier: verifier }),
    refresh: (refreshToken: string) =>
      session('token?grant_type=refresh_token', { refresh_token: refreshToken }),
    revoke: (token: string) => post('logout?scope=local', undefined, token),
  }
}
export type ProviderSession = Awaited<ReturnType<ReturnType<typeof webProvider>['refresh']>>
