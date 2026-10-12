import { randomBytes } from 'node:crypto'
import { vi } from 'vitest'
import { parseConfig } from './config'
import { RateLimiter, NonceCache } from './limits'
import type { AppDeps } from './app'

export const userId = '0b6f7c1e-2f4a-4c8e-9d1b-5a7e3c2f1d00'
export function token(exp: number, aud = 'authenticated') {
  return `e30.${Buffer.from(JSON.stringify({ exp, aud })).toString('base64url')}.c2ln`
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
