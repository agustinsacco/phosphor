import { afterEach, expect, it, vi } from 'vitest'
import { createSupabase } from './supabase'
import { dependencies } from './test-support'
afterEach(() => vi.useRealTimers())
it('uses apikey only for RPC and apikey plus user bearer for Auth', async () => {
  const deps = dependencies()
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'))
  const client = createSupabase(deps.config, fetcher)
  await client.getUser('user-token')
  expect(fetcher).toHaveBeenCalledWith(
    deps.config.supabaseUrl + '/auth/v1/user',
    expect.objectContaining({
      headers: { apikey: deps.config.publishableKey, Authorization: 'Bearer user-token' },
      redirect: 'error',
    }),
  )
  fetcher.mockResolvedValue(new Response('{}'))
  await client.rpc('control_account', {})
  expect(fetcher).toHaveBeenLastCalledWith(
    deps.config.supabaseUrl + '/rest/v1/rpc/control_account',
    expect.objectContaining({
      headers: { apikey: deps.config.secretKey, 'Content-Type': 'application/json' },
      body: '{}',
      method: 'POST',
    }),
  )
  expect(() => client.rpc('../leak', {})).toThrow('internal')
})
it('bounds responses at 64 KB, guards JSON and maps statuses without leaking bodies', async () => {
  const config = dependencies().config
  for (const [response, code] of [
    [new Response(null, { status: 401 }), 'unauthenticated'],
    [new Response(null, { status: 403 }), 'unauthenticated'],
    [new Response('private', { status: 500 }), 'unavailable'],
    [new Response('{'), 'unavailable'],
    [new Response(JSON.stringify('x'.repeat(65535))), 'unavailable'],
    [new Response(new Uint8Array([255])), 'unavailable'],
  ]) {
    if (!(response instanceof Response)) throw new Error('Invalid fixture')
    await expect(
      createSupabase(config, vi.fn<typeof fetch>().mockResolvedValue(response)).getUser(
        'user-token',
      ),
    ).rejects.toMatchObject({ code })
  }
  await expect(
    createSupabase(config, async () => new Response(JSON.stringify('x'.repeat(65534)))).getUser(
      'user-token',
    ),
  ).resolves.toHaveLength(65534)
  await expect(
    createSupabase(config, async () => new Response(null, { status: 401 })).rpc(
      'control_account',
      {},
    ),
  ).rejects.toMatchObject({ code: 'unavailable' })
})
it('times out fetch and body reading after five seconds, aborts transport', async () => {
  vi.useFakeTimers()
  let signal: AbortSignal | null | undefined
  const fetcher = vi.fn<typeof fetch>((_url, init) => {
    signal = init?.signal
    return new Promise(() => {})
  })
  const waiting = createSupabase(dependencies().config, fetcher).getUser('user-token')
  const rejected = expect(waiting).rejects.toMatchObject({ code: 'unavailable' })
  await vi.advanceTimersByTimeAsync(5000)
  await rejected
  expect(signal?.aborted).toBe(true)
  const body = new ReadableStream<Uint8Array>({ start() {} })
  const blocked = createSupabase(dependencies().config, async () => new Response(body)).getUser(
    'user-token',
  )
  const bodyRejected = expect(blocked).rejects.toMatchObject({ code: 'unavailable' })
  await vi.advanceTimersByTimeAsync(5000)
  await bodyRejected
})
