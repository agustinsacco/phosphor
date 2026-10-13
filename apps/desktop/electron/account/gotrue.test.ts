import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { AuthRefused, AuthUnavailable, createGoTrue, pkcePair } from './gotrue'

const target = { url: 'https://p.supabase.co', key: 'sb_publishable_test' }
const NOW = 1_000_000

const answer = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  expires_in: 3600,
  expires_at: 1, // ignored: the local clock decides
  token_type: 'bearer',
  provider_token: 'gh-secret',
  provider_refresh_token: 'gh-refresh-secret',
  user: {
    id: 'u-1',
    email: 'octo@example.com',
    user_metadata: { user_name: 'octo', full_name: 'Octo Cat', avatar_url: 'https://a/x.png' },
  },
}

function fetchReturning(status: number, body: unknown) {
  return vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    return new Response(status === 204 ? null : text, { status })
  })
}

describe('pkcePair', () => {
  it('derives an S256 challenge from 32 random bytes', () => {
    const { verifier, challenge } = pkcePair()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
    expect(pkcePair().verifier).not.toBe(verifier)
  })
})

describe('createGoTrue', () => {
  it('sends the browser to GitHub through Supabase with the PKCE challenge', () => {
    const url = new URL(createGoTrue(target).authorizeUrl('http://127.0.0.1:5/auth/callback', 'ch'))
    expect(url.origin + url.pathname).toBe('https://p.supabase.co/auth/v1/authorize')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      provider: 'github',
      redirect_to: 'http://127.0.0.1:5/auth/callback',
      code_challenge: 'ch',
      code_challenge_method: 's256',
    })
  })

  it('exchanges a code with its verifier and keeps only what Phosphor needs', async () => {
    const fetchImpl = fetchReturning(200, answer)
    const session = await createGoTrue(target, fetchImpl, () => NOW).exchange('code-1', 'ver-1')
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(String(url)).toBe('https://p.supabase.co/auth/v1/token?grant_type=pkce')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' })
    expect(init?.headers).toEqual({
      apikey: 'sb_publishable_test',
      accept: 'application/json',
      'content-type': 'application/json',
    })
    expect(JSON.parse(String(init?.body))).toEqual({ auth_code: 'code-1', code_verifier: 'ver-1' })
    expect(session).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: NOW + 3_600_000,
      user: { id: 'u-1', login: 'octo', name: 'Octo Cat', email: 'octo@example.com' },
    })
    expect(JSON.stringify(session)).not.toMatch(/gh-/)
  })

  it('falls back to preferred_username, name and the metadata email', async () => {
    const user = {
      id: 'u-2',
      user_metadata: { preferred_username: 'cat', name: 'C', email: 'c@x' },
    }
    const session = await createGoTrue(target, fetchReturning(200, { ...answer, user })).refresh(
      'r',
    )
    expect(session.user).toEqual({ id: 'u-2', login: 'cat', name: 'C', email: 'c@x' })
  })

  it('refreshes with the refresh grant and revokes with the access token', async () => {
    const fetchImpl = fetchReturning(200, answer)
    const auth = createGoTrue(target, fetchImpl)
    await auth.refresh('refresh-0')
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(String(url)).toBe('https://p.supabase.co/auth/v1/token?grant_type=refresh_token')
    expect(JSON.parse(String(init?.body))).toEqual({ refresh_token: 'refresh-0' })

    const logout = fetchReturning(204, '')
    await createGoTrue(target, logout).revoke('access-9')
    const [logoutUrl, logoutInit] = logout.mock.calls[0]!
    expect(String(logoutUrl)).toBe('https://p.supabase.co/auth/v1/logout?scope=local')
    expect(logoutInit?.body).toBeUndefined()
    expect(logoutInit?.headers).toEqual({
      apikey: 'sb_publishable_test',
      accept: 'application/json',
      authorization: 'Bearer access-9',
    })
  })

  it("reports a refusal with Supabase's code and message", async () => {
    const coded = {
      code: 400,
      error_code: 'bad_code_verifier',
      msg: 'code challenge does not match',
    }
    const refused = createGoTrue(target, fetchReturning(400, coded)).exchange('c', 'v')
    await expect(refused).rejects.toEqual(
      new AuthRefused(400, 'bad_code_verifier', 'code challenge does not match'),
    )
    const oauth = { error: 'invalid_grant', error_description: 'Invalid Refresh Token' }
    const grant = createGoTrue(target, fetchReturning(400, oauth)).refresh('r')
    await expect(grant).rejects.toMatchObject({ status: 400, code: 'invalid_grant' })
    const html = createGoTrue(target, fetchReturning(404, '<html>')).refresh('r')
    await expect(html).rejects.toMatchObject({
      name: 'AuthRefused',
      code: null,
      message: 'HTTP 404',
    })
  })

  it('treats outages, rate limits and junk as unavailable, not as a refusal', async () => {
    for (const status of [429, 500, 503]) {
      const call = createGoTrue(target, fetchReturning(status, {})).refresh('r')
      await expect(call).rejects.toBeInstanceOf(AuthUnavailable)
    }
    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    await expect(createGoTrue(target, offline).refresh('r')).rejects.toThrow(/did not answer/)
    const partial = { ...answer, refresh_token: undefined }
    const incomplete = createGoTrue(target, fetchReturning(200, partial)).exchange('c', 'v')
    await expect(incomplete).rejects.toThrow(/incomplete session/)
  })

  it("rejects with the caller's abort reason when the caller gives up", async () => {
    const hanging = vi.fn(
      (_url: URL | RequestInfo, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
        ),
    )
    const abort = new AbortController()
    const call = createGoTrue(target, hanging).exchange('c', 'v', abort.signal)
    const reason = new Error('cancelled by the user')
    abort.abort(reason)
    await expect(call).rejects.toBe(reason)
  })
})

it('keeps only an allowlisted GitHub avatar address from user metadata', async () => {
  const avatar = 'https://avatars.githubusercontent.com/u/1'
  const session = await createGoTrue(
    target,
    fetchReturning(200, {
      ...answer,
      user: { ...answer.user, user_metadata: { ...answer.user.user_metadata, avatar_url: avatar } },
    }),
  ).refresh('r')
  expect(session.user.avatarUrl).toBe(avatar)
})
