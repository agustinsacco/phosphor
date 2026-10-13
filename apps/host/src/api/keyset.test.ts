import { generateKeyPairSync } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createKeyset, KEYSET_LIMITS } from './keyset'

const publicKey = () => generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x
let cache: ReturnType<typeof createKeyset> | undefined
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cache?.stop()
  vi.useRealTimers()
})
it('caches, refreshes hourly and single-flights unknown ids at most once a minute', async () => {
  const transport = vi.fn(async () =>
    Response.json({ keys: [{ kid: 'one', publicKey: publicKey() }] }),
  )
  cache = createKeyset('http://localhost:12345', transport)
  expect(await cache.get('one')).toBeDefined()
  expect(transport).toHaveBeenCalledOnce()
  expect(transport.mock.calls[0]).toEqual([
    'http://localhost:12345/api/v1/grant-keys',
    expect.objectContaining({ redirect: 'error' }),
  ])
  await Promise.all([cache.get('missing'), cache.get('missing')])
  expect(transport).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(KEYSET_LIMITS.missMs - 1)
  await cache.get('missing')
  expect(transport).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1)
  await Promise.all([cache.get('missing'), cache.get('missing')])
  expect(transport).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(KEYSET_LIMITS.refreshMs - KEYSET_LIMITS.missMs)
  expect(transport).toHaveBeenCalledTimes(3)
})
it.each(['status', 'json', 'keys', 'size', 'timeout'] as const)(
  'retains old keys after %s failure',
  async (kind) => {
    let fails = false
    let cancelled = false
    const transport: typeof fetch = async (_url, init) => {
      if (!fails) return Response.json({ keys: [{ kid: 'one', publicKey: publicKey() }] })
      if (kind === 'status') return new Response('', { status: 500 })
      if (kind === 'json') return new Response('{')
      if (kind === 'keys') return Response.json({ keys: [{ kid: 'one', publicKey: 'invalid' }] })
      if (kind === 'timeout')
        return new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new Error('timeout'))),
        )
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(KEYSET_LIMITS.bytes + 1))
          },
          cancel() {
            cancelled = true
          },
        }),
      )
    }
    cache = createKeyset('http://localhost:12345', transport)
    const original = await cache.get('one')
    fails = true
    await vi.advanceTimersByTimeAsync(KEYSET_LIMITS.missMs)
    const work = cache.get('missing')
    await vi.advanceTimersByTimeAsync(KEYSET_LIMITS.timeoutMs)
    expect(await work).toBeUndefined()
    expect(await cache.get('one')).toBe(original)
    if (kind === 'size') expect(cancelled).toBe(true)
  },
)
it('accepts exactly 64 KiB and stop aborts an in-flight fetch', async () => {
  const json = JSON.stringify({ keys: [{ kid: 'one', publicKey: publicKey() }] })
  let signal: AbortSignal | null | undefined
  let pending = false
  const transport: typeof fetch = async (_url, init) => {
    if (!pending) return new Response(json.padEnd(KEYSET_LIMITS.bytes, ' '))
    signal = init?.signal
    return new Promise((_resolve, reject) =>
      signal?.addEventListener('abort', () => reject(new Error('aborted'))),
    )
  }
  cache = createKeyset('http://localhost:12345', transport)
  expect(await cache.get('one')).toBeDefined()
  await vi.advanceTimersByTimeAsync(KEYSET_LIMITS.missMs)
  pending = true
  const work = cache.get('missing')
  cache.stop()
  expect(signal?.aborted).toBe(true)
  expect(await work).toBeUndefined()
})

it('single-flights an hourly refresh racing an unknown kid', async () => {
  let calls = 0
  const transport: typeof fetch = async () => {
    if (++calls > 1) await new Promise((resolve) => setTimeout(resolve, 100))
    return Response.json({ keys: [{ kid: 'one', publicKey: publicKey() }] })
  }
  cache = createKeyset('http://localhost:12345', transport)
  await cache.get('one')
  await vi.advanceTimersByTimeAsync(KEYSET_LIMITS.refreshMs)
  const work = cache.get('unknown')
  expect(calls).toBe(2)
  await vi.advanceTimersByTimeAsync(100)
  expect(await work).toBeUndefined()
})
