import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createPublicKey, verify } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isP256PublicKey } from '@phosphor/shared/host-protocol-web-push'
import { createVapidSigner, loadVapidKey, VAPID_KEY_FILE } from './vapid'

const uid = process.getuid?.()
let root: string
let dir: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'host-vapid-'))
  dir = join(root, 'identity')
  await mkdir(dir, { mode: 0o700 })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))

describe('the Host VAPID key', () => {
  it('is created once, owner-only, beside the identity, and reused after', async () => {
    const first = await loadVapidKey(dir, uid)
    expect(isP256PublicKey(first.publicKey)).toBe(true)
    expect((await stat(join(dir, VAPID_KEY_FILE))).mode & 0o777).toBe(0o600)
    expect(await readdir(dir)).toStrictEqual([VAPID_KEY_FILE])
    const again = await loadVapidKey(dir, uid)
    expect(again.publicKey).toBe(first.publicKey)
  })
  it('refuses an unsafe key file rather than replacing it', async () => {
    const first = await loadVapidKey(dir, uid)
    await chmod(join(dir, VAPID_KEY_FILE), 0o644)
    await expect(loadVapidKey(dir, uid)).rejects.toThrow('Web Push key unavailable')
    await chmod(join(dir, VAPID_KEY_FILE), 0o600)
    expect((await loadVapidKey(dir, uid)).publicKey).toBe(first.publicKey)
  })
  it('refuses a key that is not P-256', async () => {
    await writeFile(join(dir, VAPID_KEY_FILE), 'not a key', { mode: 0o600 })
    await expect(loadVapidKey(dir, uid)).rejects.toThrow('Web Push key unavailable')
  })
})

describe('the RFC 8292 authorization', () => {
  const endpoint = 'https://fcm.googleapis.com/fcm/send/token'
  it('signs an ES256 JWT for the push service origin, at most 24 hours long', async () => {
    const key = await loadVapidKey(dir, uid)
    const now = Date.UTC(2026, 10, 15)
    const header = createVapidSigner(key, 'https://control.example', () => now)(endpoint)
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^.,]+), k=(.+)$/.exec(header)
    expect(match).not.toBeNull()
    const [, head, claims, signature, k] = match!
    expect(decode(head!)).toStrictEqual({ typ: 'JWT', alg: 'ES256' })
    const payload = decode(claims!)
    expect(payload).toStrictEqual({
      aud: 'https://fcm.googleapis.com',
      exp: now / 1000 + 12 * 3600,
      sub: 'https://control.example',
    })
    expect(payload.exp - now / 1000).toBeLessThanOrEqual(24 * 3600)
    expect(k).toBe(key.publicKey)
    const point = Buffer.from(key.publicKey, 'base64url')
    const publicKey = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: point.subarray(1, 33).toString('base64url'),
        y: point.subarray(33).toString('base64url'),
      },
      format: 'jwk',
    })
    const bytes = Buffer.from(signature!, 'base64url')
    expect(bytes).toHaveLength(64)
    expect(
      verify(
        'sha256',
        Buffer.from(`${head}.${claims}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        bytes,
      ),
    ).toBe(true)
  })
  it('reuses a token per origin until an hour before it expires, and never names an email', async () => {
    const key = await loadVapidKey(dir, uid)
    let now = 1_000_000_000_000
    const signer = createVapidSigner(key, 'http://127.0.0.1:8787', () => now)
    const first = signer(endpoint)
    expect(decode(first.split(/[ .]/)[2]!).sub).toBe('https://phosphor.saccolabs.com')
    expect(signer(`${endpoint}/other`)).toBe(first)
    expect(signer('https://web.push.apple.com/x')).not.toBe(first)
    now += 10 * 3600 * 1000
    expect(signer(endpoint)).toBe(first)
    now += 2 * 3600 * 1000
    expect(signer(endpoint)).not.toBe(first)
  })
})
