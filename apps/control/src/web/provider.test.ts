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
  it('bounds even a fetch implementation that ignores abort', async () => {
    vi.useFakeTimers()
    try {
      const deps = dependencies()
      deps.fetch = vi.fn(() => new Promise<Response>(() => {}))
      const result = webProvider(deps)
        .refresh('secret')
        .catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(5001)
      expect(await result).toMatchObject({ code: 'unavailable' })
    } finally {
      vi.useRealTimers()
    }
  })
})
