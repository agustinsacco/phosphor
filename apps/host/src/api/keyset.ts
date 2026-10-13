import { createPublicKey, type KeyObject } from 'node:crypto'
import { CONTROL_ROUTES } from '@phosphor/shared/control-api'
import { parseGrantKeySet } from '@phosphor/shared/host-grant'

export const KEYSET_LIMITS = {
  bytes: 64 * 1024,
  timeoutMs: 10_000,
  refreshMs: 3600_000,
  missMs: 60_000,
}

export function createKeyset(origin: string, transport = fetch, now = Date.now) {
  let keys = new Map<string, KeyObject>()
  let refreshed = -Infinity
  let missed = -Infinity
  let flight: Promise<void> | undefined
  let stopped = false
  let active: AbortController | undefined
  function refresh(): Promise<void> {
    if (flight) return flight
    if (stopped) return Promise.resolve()
    refreshed = now()
    const controller = new AbortController()
    active = controller
    const timer = setTimeout(() => controller.abort(), KEYSET_LIMITS.timeoutMs)
    flight = (async () => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      try {
        const response = await transport(origin + CONTROL_ROUTES.grantKeys, {
          signal: controller.signal,
          redirect: 'error',
        })
        reader = response.body?.getReader()
        if (!response.ok || !reader) return
        const chunks: Uint8Array[] = []
        let size = 0
        while (true) {
          const part = await reader.read()
          if (part.done) break
          size += part.value.byteLength
          if (size > KEYSET_LIMITS.bytes) return
          chunks.push(part.value)
        }
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const parsed = parseGrantKeySet(value)
        if (!parsed.ok) return
        const next = new Map<string, KeyObject>()
        for (const key of parsed.value.keys)
          next.set(
            key.kid,
            createPublicKey({
              key: { kty: 'OKP', crv: 'Ed25519', x: key.publicKey },
              format: 'jwk',
            }),
          )
        if (!stopped) keys = next
      } catch {
        // A failed refresh retains the last verified keyset.
      } finally {
        await reader?.cancel().catch(() => {})
        clearTimeout(timer)
        active = undefined
        flight = undefined
      }
    })()
    return flight
  }
  const hourly = setInterval(() => {
    void refresh()
  }, KEYSET_LIMITS.refreshMs)
  hourly.unref()
  return {
    async get(kid: string) {
      if (now() - refreshed >= KEYSET_LIMITS.refreshMs) {
        missed = now()
        await refresh()
      }
      if (!keys.has(kid) && now() - missed >= KEYSET_LIMITS.missMs) {
        missed = now()
        await refresh()
      } else if (flight) await flight
      return keys.get(kid)
    },
    stop() {
      stopped = true
      clearInterval(hourly)
      active?.abort()
    },
  }
}
export type Keyset = Pick<ReturnType<typeof createKeyset>, 'get'>
