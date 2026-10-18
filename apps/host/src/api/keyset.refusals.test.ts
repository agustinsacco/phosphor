import { generateKeyPairSync } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONTROL_ROUTES } from '@phosphor/shared/control-api'
import { createKeyset, KEYSET_LIMITS } from './keyset'

const ORIGIN = 'http://localhost:12345'
const publicKey = (): string => {
  const x = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x
  if (typeof x !== 'string') throw new Error('Missing key bytes')
  return x
}
const keySet = (...kids: string[]) => ({
  keys: kids.map((kid) => ({ kid, publicKey: publicKey() })),
})
type Reply = (init: RequestInit | undefined) => Response | Promise<Response>
const deferred = <T>() => {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
/** A body stream that never ends by itself and fails, as fetch's does, when the request aborts. */
function stalledBody(init: RequestInit | undefined, first: string) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(first))
      init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason))
    },
  })
}

let cache: ReturnType<typeof createKeyset> | undefined
afterEach(() => {
  cache?.stop()
  cache = undefined
  vi.useRealTimers()
})
/** A keyset whose first refresh installed `one`, and whose later replies come from `reply`. */
async function primed() {
  vi.useFakeTimers()
  let reply: Reply = () => Response.json(keySet('one'))
  const transport = vi.fn<typeof fetch>(async (_url, init) => reply(init))
  const keyset = createKeyset(ORIGIN, transport)
  cache = keyset
  const original = await keyset.get('one')
  expect(original).toBeDefined()
  return {
    keyset,
    transport,
    original,
    reply: (next: Reply) => {
      reply = next
    },
    /** Starts the rate-limited refresh an unknown kid triggers. */
    miss: async (kid = 'two') => {
      await vi.advanceTimersByTimeAsync(KEYSET_LIMITS.missMs)
      return keyset.get(kid)
    },
  }
}

describe('refused grant-key responses keep the last verified keyset', () => {
  it.each([300, 302, 307, 400, 401, 403, 404, 410, 429, 500, 503])(
    'refuses a valid key body under status %i',
    async (status) => {
      const { keyset, transport, original, reply, miss } = await primed()
      reply(() => Response.json(keySet('one', 'two'), { status }))
      expect(await miss()).toBeUndefined()
      expect(transport).toHaveBeenCalledTimes(2)
      expect(await keyset.get('one')).toBe(original)
    },
  )

  it.each([
    ['no body', () => new Response(null, { status: 200 })],
    ['204 No Content', () => new Response(null, { status: 204 })],
  ])('refuses a response with %s', async (_kind, make) => {
    const { keyset, original, reply, miss } = await primed()
    reply(make)
    expect(await miss()).toBeUndefined()
    expect(await keyset.get('one')).toBe(original)
  })

  it.each(['', '{', 'not json', '{"keys":[]', `\uFEFF${JSON.stringify({ keys: [] })}`])(
    'refuses the unparseable body %j',
    async (body) => {
      const { keyset, original, reply, miss } = await primed()
      reply(() => new Response(body))
      expect(await miss()).toBeUndefined()
      expect(await keyset.get('one')).toBe(original)
    },
  )

  it('refuses a transport failure such as a refused redirect', async () => {
    const { keyset, original, reply, miss } = await primed()
    reply(() => Promise.reject(new TypeError('fetch failed: unexpected redirect')))
    expect(await miss()).toBeUndefined()
    expect(await keyset.get('one')).toBe(original)
  })
})

describe('grant-key set validation is all or nothing', () => {
  const valid = () => ({ kid: 'two', publicKey: publicKey() })
  it.each<[string, () => unknown]>([
    ['null', () => null],
    ['an array', () => [valid()]],
    ['a string', () => 'keys'],
    ['no keys field', () => ({})],
    ['keys as an object', () => ({ keys: { two: valid() } })],
    ['nine keys', () => keySet('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'two')],
    ['a null entry', () => ({ keys: [valid(), null] })],
    ['an array entry', () => ({ keys: [valid(), ['three', publicKey()]] })],
    ['an empty kid', () => ({ keys: [valid(), { kid: '', publicKey: publicKey() }] })],
    [
      'a 65-character kid',
      () => ({ keys: [valid(), { kid: 'k'.repeat(65), publicKey: publicKey() }] }),
    ],
    [
      'a kid with a slash',
      () => ({ keys: [valid(), { kid: '../three', publicKey: publicKey() }] }),
    ],
    ['a numeric kid', () => ({ keys: [valid(), { kid: 3, publicKey: publicKey() }] })],
    ['a duplicate kid', () => ({ keys: [valid(), valid()] })],
    ['a missing public key', () => ({ keys: [valid(), { kid: 'three' }] })],
    ['a numeric public key', () => ({ keys: [valid(), { kid: 'three', publicKey: 7 }] })],
    [
      'a 42-character key',
      () => ({ keys: [valid(), { kid: 'three', publicKey: 'A'.repeat(42) }] }),
    ],
    [
      'a 44-character key',
      () => ({ keys: [valid(), { kid: 'three', publicKey: 'A'.repeat(44) }] }),
    ],
    [
      'a padded key',
      () => ({ keys: [valid(), { kid: 'three', publicKey: `${'A'.repeat(42)}=` }] }),
    ],
    [
      'a base64 key',
      () => ({ keys: [valid(), { kid: 'three', publicKey: `${'A'.repeat(42)}+` }] }),
    ],
    [
      'a non-canonical key',
      () => ({ keys: [valid(), { kid: 'three', publicKey: `${'A'.repeat(42)}B` }] }),
    ],
  ])('refuses the whole set for %s', async (_kind, body) => {
    const { keyset, original, reply, miss } = await primed()
    reply(() => Response.json(body()))
    expect(await miss('two')).toBeUndefined()
    expect(await keyset.get('three')).toBeUndefined()
    expect(await keyset.get('one')).toBe(original)
  })

  it('installs exactly eight keys, replacing the previous set', async () => {
    const { keyset, reply, miss } = await primed()
    const kids = ['two', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    reply(() => Response.json(keySet(...kids)))
    expect(await miss('two')).toBeDefined()
    for (const kid of kids) expect(await keyset.get(kid)).toBeDefined()
    expect(await keyset.get('one')).toBeUndefined()
  })
})

describe('grant-key body size cap', () => {
  /** `sizes` chunks of `text`; an open body could still send more after them. */
  const chunked = (text: string, sizes: number[], open: boolean, onCancel = () => {}) => {
    const bytes = new TextEncoder().encode(text)
    return new ReadableStream<Uint8Array>({
      start(controller) {
        let at = 0
        for (const size of sizes) {
          controller.enqueue(bytes.subarray(at, at + size))
          at += size
        }
        if (!open) controller.close()
      },
      cancel: onCancel,
    })
  }
  const padded = (length: number) => JSON.stringify(keySet('two')).padEnd(length, ' ')

  it('accepts exactly the cap delivered in several chunks', async () => {
    const { reply, miss } = await primed()
    const third = Math.floor(KEYSET_LIMITS.bytes / 3)
    const sizes = [third, third, KEYSET_LIMITS.bytes - 2 * third]
    reply(() => new Response(chunked(padded(KEYSET_LIMITS.bytes), sizes, false)))
    expect(await miss('two')).toBeDefined()
  })

  it('refuses one byte over the cap in a later chunk and cancels the body', async () => {
    const { keyset, original, reply, miss } = await primed()
    let cancelled = false
    const sizes = [KEYSET_LIMITS.bytes, 1]
    const body = () =>
      chunked(padded(KEYSET_LIMITS.bytes + 1), sizes, true, () => (cancelled = true))
    reply(() => new Response(body()))
    expect(await miss('two')).toBeUndefined()
    expect(cancelled).toBe(true)
    expect(await keyset.get('one')).toBe(original)
  })

  it('stops pulling an endless body soon after the cap', async () => {
    const { keyset, original, reply, miss } = await primed()
    let pulls = 0
    let cancelled = false
    reply(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls++
              controller.enqueue(new Uint8Array(16 * 1024).fill(32))
            },
            cancel() {
              cancelled = true
            },
          }),
        ),
    )
    expect(await miss('two')).toBeUndefined()
    expect(cancelled).toBe(true)
    // Four 16 KiB chunks fill the cap; the fifth crosses it, and a stream reads at most one ahead.
    expect(pulls).toBeGreaterThanOrEqual(5)
    expect(pulls).toBeLessThanOrEqual(6)
    expect(await keyset.get('one')).toBe(original)
  })
})

describe('cancellation and stop', () => {
  it('times out a stalled body read, keeps the old keys and can refresh again', async () => {
    const { keyset, transport, original, reply } = await primed()
    let signal: AbortSignal | null | undefined
    reply((init) => {
      signal = init?.signal
      return new Response(stalledBody(init, '{"keys":'))
    })
    await vi.advanceTimersByTimeAsync(KEYSET_LIMITS.missMs)
    const work = keyset.get('two')
    await vi.advanceTimersByTimeAsync(KEYSET_LIMITS.timeoutMs - 1)
    expect(signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(signal?.aborted).toBe(true)
    expect(await work).toBeUndefined()
    expect(await keyset.get('one')).toBe(original)
    reply(() => Response.json(keySet('two')))
    await vi.advanceTimersByTimeAsync(KEYSET_LIMITS.missMs)
    expect(await keyset.get('two')).toBeDefined()
    expect(transport).toHaveBeenCalledTimes(3)
  })

  it('stop aborts a body read in progress and installs nothing', async () => {
    const { keyset, original, reply } = await primed()
    let signal: AbortSignal | null | undefined
    reply((init) => {
      signal = init?.signal
      return new Response(stalledBody(init, JSON.stringify(keySet('two')).slice(0, 20)))
    })
    await vi.advanceTimersByTimeAsync(KEYSET_LIMITS.missMs)
    const work = keyset.get('two')
    await vi.advanceTimersByTimeAsync(0)
    keyset.stop()
    expect(signal?.aborted).toBe(true)
    expect(await work).toBeUndefined()
    expect(await keyset.get('one')).toBe(original)
  })

  it('never installs a reply that arrives after stop, even when the transport ignored the abort', async () => {
    const { keyset, transport, original, reply } = await primed()
    const late = deferred<Response>()
    reply(() => late.promise)
    await vi.advanceTimersByTimeAsync(KEYSET_LIMITS.missMs)
    const work = keyset.get('two')
    keyset.stop()
    late.resolve(Response.json(keySet('one', 'two')))
    expect(await work).toBeUndefined()
    expect(await keyset.get('two')).toBeUndefined()
    expect(await keyset.get('one')).toBe(original)
    expect(transport).toHaveBeenCalledTimes(2)
  })

  it('makes no request after stop, hourly or on a miss', async () => {
    const { keyset, transport, original } = await primed()
    keyset.stop()
    await vi.advanceTimersByTimeAsync(2 * KEYSET_LIMITS.refreshMs)
    expect(await keyset.get('two')).toBeUndefined()
    expect(await keyset.get('one')).toBe(original)
    expect(transport).toHaveBeenCalledOnce()
  })

  it('makes no request when stopped before the first lookup', async () => {
    vi.useFakeTimers()
    const transport = vi.fn<typeof fetch>(async () => Response.json(keySet('one')))
    cache = createKeyset(ORIGIN, transport)
    cache.stop()
    expect(await cache.get('one')).toBeUndefined()
    expect(transport).not.toHaveBeenCalled()
  })
})

describe('single flight', () => {
  it('a known kid waits for the refresh in flight and loses a key it rotated out', async () => {
    const { keyset, transport, reply } = await primed()
    const rotation = deferred<Response>()
    reply(() => rotation.promise)
    await vi.advanceTimersByTimeAsync(KEYSET_LIMITS.missMs)
    const unknown = keyset.get('two')
    const known = keyset.get('one')
    rotation.resolve(Response.json(keySet('two')))
    expect(await known).toBeUndefined()
    expect(await unknown).toBeDefined()
    expect(transport).toHaveBeenCalledTimes(2)
  })

  it('a failed refresh still spends the miss window', async () => {
    const { keyset, transport, reply, miss } = await primed()
    reply(() => new Response('', { status: 500 }))
    expect(await miss('two')).toBeUndefined()
    reply(() => Response.json(keySet('two')))
    await vi.advanceTimersByTimeAsync(KEYSET_LIMITS.missMs - 1)
    expect(await keyset.get('two')).toBeUndefined()
    expect(transport).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(await keyset.get('two')).toBeDefined()
    expect(transport).toHaveBeenCalledTimes(3)
  })

  it('every refresh asks for the grant-key route with redirects refused and a signal', async () => {
    const { transport, reply, miss } = await primed()
    reply(() => new Response('', { status: 500 }))
    await miss('two')
    await vi.advanceTimersByTimeAsync(KEYSET_LIMITS.refreshMs)
    expect(transport).toHaveBeenCalledTimes(3)
    for (const [url, init] of transport.mock.calls) {
      expect(url).toBe(ORIGIN + CONTROL_ROUTES.grantKeys)
      expect(init).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) })
    }
  })
})

describe('over real fetch', () => {
  it.each([301, 302, 303, 307, 308])(
    'refuses a %i redirect without contacting its target',
    async (status) => {
      let followed = 0
      const server = createServer((request, response) => {
        if (request.url === CONTROL_ROUTES.grantKeys) {
          response.writeHead(status, { location: '/elsewhere' }).end()
          return
        }
        followed++
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(keySet('one')))
      })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      try {
        const { port } = server.address() as AddressInfo
        cache = createKeyset(`http://127.0.0.1:${port}`)
        expect(await cache.get('one')).toBeUndefined()
        expect(followed).toBe(0)
      } finally {
        server.closeAllConnections()
        server.close()
      }
    },
  )
})
