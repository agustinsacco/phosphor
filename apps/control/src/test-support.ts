import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { HOST_HEADERS, hostSigningString } from '@phosphor/shared/control-api'
import { vi } from 'vitest'
import { parseConfig } from './config'
import { RateLimiter, NonceCache } from './limits'
import type { AppDeps } from './app'

export const userId = '0b6f7c1e-2f4a-4c8e-9d1b-5a7e3c2f1d00'
export function token(exp: number, aud = 'authenticated') {
  return `e30.${Buffer.from(JSON.stringify({ exp, aud })).toString('base64url')}.c2ln`
}
export function signingKey() {
  const pair = generateKeyPairSync('ed25519')
  const publicKey = pair.publicKey
    .export({ format: 'der', type: 'spki' })
    .subarray(-32)
    .toString('base64url')
  return {
    publicKey,
    request(method: string, path: string, value: unknown, now: number, hostId?: string): Request {
      const body = value === undefined ? '' : JSON.stringify(value)
      const identity = hostId ?? publicKey
      const timestamp = String(Math.floor(now / 1000))
      const nonce = randomBytes(16).toString('base64url')
      const signature = sign(
        null,
        Buffer.from(
          hostSigningString({
            method,
            path,
            identity,
            timestamp,
            nonce,
            bodySha256: createHash('sha256').update(body).digest('hex'),
          }),
        ),
        pair.privateKey,
      ).toString('base64url')
      return new Request('http://localhost' + path, {
        method,
        headers: {
          'content-type': 'application/json',
          [hostId ? HOST_HEADERS.host : HOST_HEADERS.key]: identity,
          [HOST_HEADERS.timestamp]: timestamp,
          [HOST_HEADERS.nonce]: nonce,
          [HOST_HEADERS.signature]: signature,
        },
        ...(body ? { body } : {}),
      })
    },
  }
}
export function dependencies(): AppDeps {
  const clock = () => 1_792_000_000_000
  return {
    config: parseConfig({ SUPABASE_SECRET_KEY: randomBytes(32).toString('hex') }),
    clock,
    random: randomBytes,
    fetch,
    log: vi.fn(),
    version: 'test',
    supabase: {
      getUser: vi.fn(async () => ({ id: userId, user_metadata: { user_name: 'tester' } })),
      rpc: vi.fn(async () => ({ enabled: true, maxHosts: 20 })),
    },
    limits: new RateLimiter(clock),
    nonces: { key: new NonceCache(clock), host: new NonceCache(clock) },
  }
}
