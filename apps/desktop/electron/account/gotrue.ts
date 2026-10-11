import { createHash, randomBytes } from 'node:crypto'

/**
 * The four Supabase Auth (GoTrue) calls Desktop's sign-in needs, and nothing
 * else: no SDK, no storage, no timers. The caller owns the session.
 */

export interface SupabaseTarget {
  readonly url: string
  readonly key: string
}

/** What Phosphor keeps about the signed-in person. Never a GitHub token. */
export interface AccountUser {
  readonly id: string
  readonly login: string | null
  readonly name: string | null
  readonly email: string | null
}

export interface AuthSession {
  readonly accessToken: string
  readonly refreshToken: string
  /** Local clock, ms. Derived from expires_in so clock skew cannot matter. */
  readonly expiresAt: number
  readonly user: AccountUser
}

/** Supabase answered and said no: the code, token or session is not good. */
export class AuthRefused extends Error {
  override readonly name = 'AuthRefused'
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message)
  }
}

/** Supabase could not be asked, or answered with nothing usable: try later. */
export class AuthUnavailable extends Error {
  override readonly name = 'AuthUnavailable'
}

export interface GoTrue {
  authorizeUrl(redirectTo: string, challenge: string): string
  exchange(code: string, verifier: string, signal?: AbortSignal): Promise<AuthSession>
  refresh(refreshToken: string, signal?: AbortSignal): Promise<AuthSession>
  revoke(accessToken: string, signal?: AbortSignal): Promise<void>
}

export const REQUEST_MS = 15_000

/** RFC 7636 S256: 32 random bytes as the verifier, its SHA-256 as the challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null

function parseUser(value: unknown): AccountUser | null {
  if (!isRecord(value) || !text(value.id)) return null
  const meta = isRecord(value.user_metadata) ? value.user_metadata : {}
  return {
    id: value.id as string,
    login: text(meta.user_name) ?? text(meta.preferred_username),
    name: text(meta.full_name) ?? text(meta.name),
    email: text(value.email) ?? text(meta.email),
  }
}

/** Only the fields named here survive; provider_token and friends are dropped. */
function parseSession(body: unknown, now: number): AuthSession {
  const record = isRecord(body) ? body : {}
  const accessToken = text(record.access_token)
  const refreshToken = text(record.refresh_token)
  const expiresIn = typeof record.expires_in === 'number' ? record.expires_in : null
  const user = parseUser(record.user)
  if (!accessToken || !refreshToken || expiresIn === null || !user) {
    throw new AuthUnavailable('Supabase sent an incomplete session')
  }
  return { accessToken, refreshToken, expiresAt: now + expiresIn * 1000, user }
}

export function createGoTrue(
  target: SupabaseTarget,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): GoTrue {
  async function post(
    path: string,
    options: { body?: unknown; bearer?: string; signal?: AbortSignal },
  ): Promise<unknown> {
    const headers: Record<string, string> = { apikey: target.key, accept: 'application/json' }
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    if (options.bearer) headers.authorization = `Bearer ${options.bearer}`
    const signals = [AbortSignal.timeout(REQUEST_MS)]
    if (options.signal) signals.push(options.signal)
    let status: number
    let raw: string
    try {
      const response = await fetchImpl(new URL(path, target.url), {
        method: 'POST',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.any(signals),
      })
      status = response.status
      raw = await response.text()
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason
      throw new AuthUnavailable(`Supabase did not answer: ${(error as Error).message}`)
    }
    let body: unknown = null
    try {
      body = raw ? JSON.parse(raw) : null
    } catch {
      // A proxy's HTML error page; the status decides below.
    }
    if (status >= 200 && status < 300) return body
    if (status === 429 || status >= 500) throw new AuthUnavailable(`Supabase answered ${status}`)
    const record = isRecord(body) ? body : {}
    const code = text(record.error_code) ?? text(record.error)
    const message = text(record.msg) ?? text(record.error_description) ?? `HTTP ${status}`
    throw new AuthRefused(status, code, message.slice(0, 200))
  }

  return {
    authorizeUrl(redirectTo, challenge) {
      const url = new URL('/auth/v1/authorize', target.url)
      url.searchParams.set('provider', 'github')
      url.searchParams.set('redirect_to', redirectTo)
      url.searchParams.set('code_challenge', challenge)
      url.searchParams.set('code_challenge_method', 's256')
      return url.toString()
    },
    async exchange(code, verifier, signal) {
      const body = { auth_code: code, code_verifier: verifier }
      return parseSession(await post('/auth/v1/token?grant_type=pkce', { body, signal }), now())
    },
    async refresh(refreshToken, signal) {
      const body = { refresh_token: refreshToken }
      const answer = await post('/auth/v1/token?grant_type=refresh_token', { body, signal })
      return parseSession(answer, now())
    },
    async revoke(accessToken, signal) {
      await post('/auth/v1/logout?scope=local', { bearer: accessToken, signal })
    },
  }
}
