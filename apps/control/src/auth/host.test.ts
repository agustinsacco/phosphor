import { describe, expect, it } from 'vitest'
import { createHash, createPrivateKey, randomBytes, sign } from 'node:crypto'
import { Hono } from 'hono'
import { hostSigningString } from '@phosphor/shared/control-api'
import vector from '../../../../libs/shared/src/__fixtures__/control-signing-vector.json'
import { authenticateHost, hostGuard } from './host'
import { NonceCache } from '../limits'
import { ControlFailure, type Env } from '../http'
import { userId } from '../test-support'

function request(overrides: RequestInit = {}, url = vector.input.path): Request {
  return new Request(`http://localhost${url}`, {
    method: 'POST',
    body: vector.body,
    ...overrides,
    headers: {
      'x-phosphor-key': vector.publicKey,
      'x-phosphor-timestamp': vector.input.timestamp,
      'x-phosphor-nonce': vector.input.nonce,
      'x-phosphor-signature': vector.signature,
      ...overrides.headers,
    },
  })
}
function deps(offset = 0) {
  const clock = () => Number(vector.input.timestamp) * 1000 + offset
  return { clock, nonces: new NonceCache(clock), hostKey: async () => vector.publicKey }
}
const bytes = Buffer.from(vector.body)
describe('Host signature verifier', () => {
  it('accepts the shared signing vector on a test-only guarded route', async () => {
    const app = new Hono<Env>()
    app.use('*', async (c, next) => {
      c.set('rawBody', new Uint8Array(await c.req.raw.arrayBuffer()))
      await next()
    })
    app.post(vector.input.path, hostGuard(deps(), 'key'), (c) => c.json({ ok: true }))
    expect((await app.request(request())).status).toBe(200)
  })
  it('binds each field, exact body bytes, signature, identity, method and path', async () => {
    const replacements = [
      request({ method: 'PUT' }),
      request({}, '/api/v1/enrollments'),
      request({ headers: { 'x-phosphor-key': randomBytes(32).toString('base64url') } }),
      request({ headers: { 'x-phosphor-timestamp': String(Number(vector.input.timestamp) + 1) } }),
      request({ headers: { 'x-phosphor-nonce': randomBytes(16).toString('base64url') } }),
      request({
        headers: {
          'x-phosphor-signature': Buffer.from(
            Buffer.from(vector.signature, 'base64url').map((b, i) => (i === 0 ? b ^ 1 : b)),
          ).toString('base64url'),
        },
      }),
    ]
    for (const req of replacements)
      await expect(authenticateHost(req, bytes, deps(), 'key')).rejects.toMatchObject({
        code: 'unauthenticated',
      })
    await expect(
      authenticateHost(request(), Buffer.from(vector.body + ' '), deps(), 'key'),
    ).rejects.toMatchObject({ code: 'unauthenticated' })
  })
  it('accepts exactly 60 seconds in either direction, rejects 61; rejects replay for 120 seconds', async () => {
    for (const offset of [-60_000, 60_000])
      expect(await authenticateHost(request(), bytes, deps(offset), 'key')).toBe(vector.publicKey)
    for (const offset of [-61_000, 61_000])
      await expect(authenticateHost(request(), bytes, deps(offset), 'key')).rejects.toMatchObject({
        code: 'unauthenticated',
      })
    const ports = deps()
    await authenticateHost(request(), bytes, ports, 'key')
    await expect(authenticateHost(request(), bytes, ports, 'key')).rejects.toMatchObject({
      code: 'unauthenticated',
    })
  })
  it('rejects missing, malformed and conflicting headers, wrong mode and queries', async () => {
    for (const header of [
      'x-phosphor-key',
      'x-phosphor-timestamp',
      'x-phosphor-nonce',
      'x-phosphor-signature',
    ]) {
      for (const value of ['', 'garbage'])
        await expect(
          authenticateHost(request({ headers: { [header]: value } }), bytes, deps(), 'key'),
        ).rejects.toMatchObject({ code: 'unauthenticated' })
      const req = request()
      req.headers.delete(header)
      await expect(authenticateHost(req, bytes, deps(), 'key')).rejects.toMatchObject({
        code: 'unauthenticated',
      })
    }
    await expect(
      authenticateHost(request({ headers: { 'x-phosphor-host': userId } }), bytes, deps(), 'key'),
    ).rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(authenticateHost(request(), bytes, deps(), 'host')).rejects.toMatchObject({
      code: 'unauthenticated',
    })
    await expect(
      authenticateHost(request({}, vector.input.path + '?x=1'), bytes, deps(), 'key'),
    ).rejects.toMatchObject({ code: 'unauthenticated' })
    const neither = request()
    neither.headers.delete('x-phosphor-key')
    await expect(authenticateHost(neither, bytes, deps(), 'host')).rejects.toMatchObject({
      code: 'unauthenticated',
    })
  })
  it('uses the enrolled key port, rejects gone identically for unknown/revoked and invalid port output', async () => {
    const req = request()
    req.headers.delete('x-phosphor-key')
    req.headers.set('x-phosphor-host', userId)
    req.headers.set(
      'x-phosphor-signature',
      sign(
        null,
        Buffer.from(
          hostSigningString({
            ...vector.input,
            identity: userId,
            bodySha256: createHash('sha256').update(bytes).digest('hex'),
          }),
        ),
        createPrivateKey({
          key: Buffer.from(vector.pkcs8Hex, 'hex'),
          format: 'der',
          type: 'pkcs8',
        }),
      ).toString('base64url'),
    )
    expect(await authenticateHost(req, bytes, deps(), 'host')).toBe(userId)
    await expect(
      authenticateHost(req, bytes, { ...deps(), hostKey: async () => 'gone' }, 'host'),
    ).rejects.toEqual(new ControlFailure('gone'))
    await expect(
      authenticateHost(req, bytes, { ...deps(), hostKey: async () => 'invalid' }, 'host'),
    ).rejects.toEqual(new ControlFailure('unavailable'))
  })
  it('does not consume a nonce until signature verification succeeds', async () => {
    const ports = deps()
    await expect(
      authenticateHost(request(), Buffer.from('changed'), ports, 'key'),
    ).rejects.toThrow()
    expect(await authenticateHost(request(), bytes, ports, 'key')).toBe(vector.publicKey)
  })
})

it('never verifies a valid signature against a normalized or query-bearing raw target', async () => {
  for (const target of [
    '/api/v1/./enrollments/poll',
    vector.input.path + '?x=1',
    '/api//v1/enrollments/poll',
  ]) {
    const req = request({}, target)
    req.headers.set(
      'x-phosphor-signature',
      sign(
        null,
        Buffer.from(
          hostSigningString({
            ...vector.input,
            path: target,
          }),
        ),
        createPrivateKey({
          key: Buffer.from(vector.pkcs8Hex, 'hex'),
          format: 'der',
          type: 'pkcs8',
        }),
      ).toString('base64url'),
    )
    await expect(authenticateHost(req, bytes, deps(), 'key', target)).rejects.toMatchObject({
      code: 'unauthenticated',
    })
  }
})

it('rejects malformed nonces even when the request has a valid signature', async () => {
  const req = request()
  const nonce = 'A'.repeat(21)
  req.headers.set('x-phosphor-nonce', nonce)
  req.headers.set(
    'x-phosphor-signature',
    sign(
      null,
      Buffer.from(
        hostSigningString({
          ...vector.input,
          nonce,
        }),
      ),
      createPrivateKey({ key: Buffer.from(vector.pkcs8Hex, 'hex'), format: 'der', type: 'pkcs8' }),
    ).toString('base64url'),
  )
  await expect(authenticateHost(req, bytes, deps(), 'key')).rejects.toMatchObject({
    code: 'unauthenticated',
  })
})
