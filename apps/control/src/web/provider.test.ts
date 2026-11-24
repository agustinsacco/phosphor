import { describe, expect, it, vi } from 'vitest'
import { dependencies, userId } from '../test-support'
import { webProvider } from './provider'

describe('bounded browser Supabase port', () => {
  it('refuses provider redirects and malformed/oversize sessions without exposing diagnostics', async () => {
    for (const response of [
      new Response('sensitive', { status: 401 }),
      new Response('sensitive', { status: 503 }),
      new Response('secret', { status: 302 }),
      Response.json({ access_token: 'invalid', refresh_token: 'secret', user: { id: userId } }),
      new Response('x'.repeat(65537)),
    ]) {
      const deps = dependencies()
      deps.fetch = vi.fn(async () => response)
      await expect(webProvider(deps).exchange('code', 'verifier')).rejects.toMatchObject({
        code: expect.stringMatching(/^(unavailable|unauthenticated)$/),
      })
      expect(deps.fetch).toHaveBeenCalledWith(
        expect.stringContaining('grant_type=pkce'),
        expect.objectContaining({ redirect: 'error', credentials: 'omit' }),
      )
    }
  })
  it('reads who signed in from the exchange, and drops a login GitHub could not have issued', async () => {
    const sid = '00000000-0000-4000-8000-000000000013'
    const access = (claims: object) =>
      `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.c2ln`
    const answer = (user: object, claims = { sub: userId, aud: 'authenticated', session_id: sid }) =>
      Response.json({ access_token: access(claims), refresh_token: 'discarded', user })
    const exchange = async (response: Response) => {
      const deps = dependencies()
      deps.fetch = vi.fn(async () => response)
      return webProvider(deps).exchange('code', 'verifier')
    }
    await expect(
      exchange(answer({ id: userId, user_metadata: { user_name: 'octo-cat' } })),
    ).resolves.toEqual({ userId, sid, login: 'octo-cat' })
    await expect(exchange(answer({ id: userId }))).resolves.toEqual({ userId, sid, login: null })
    await expect(
      exchange(answer({ id: userId, user_metadata: { user_name: 'not a login' } })),
    ).resolves.toMatchObject({ login: null })
    for (const claims of [
      { sub: sid, aud: 'authenticated', session_id: sid },
      { sub: userId, aud: 'anon', session_id: sid },
      { sub: userId, aud: 'authenticated' },
    ])
      await expect(exchange(answer({ id: userId }, claims as never))).rejects.toMatchObject({
        code: 'unavailable',
      })
  })
  it('bounds even a fetch implementation that ignores abort', async () => {
    vi.useFakeTimers()
    try {
      const deps = dependencies()
      deps.fetch = vi.fn(() => new Promise<Response>(() => {}))
      const result = webProvider(deps)
        .exchange('code', 'verifier')
        .catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(5001)
      expect(await result).toMatchObject({ code: 'unavailable' })
    } finally {
      vi.useRealTimers()
    }
  })
})
