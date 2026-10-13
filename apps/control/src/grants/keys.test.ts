import { randomBytes, createPublicKey, verify } from 'node:crypto'
import { expect, it } from 'vitest'
import type { GrantPayload } from '@phosphor/shared/host-grant'
import { parseConfig } from '../config'
import { parseGrantKeys, parseGrantOrigin } from './keys'

function entry(kid = 'one') {
  return `${kid}=${randomBytes(32).toString('base64url')}`
}
it('publishes only raw public keys and retains old verification keys during rotation', () => {
  const first = entry('first')
  const second = entry('second')
  const before = parseGrantKeys(`${second},${first}`)
  const after = parseGrantKeys(`${first},${second}`)
  if (!before || !after) throw new Error('missing keys')
  expect(before.kid).toBe('second')
  expect(after.kid).toBe('first')
  expect(after.keyset).toEqual({ keys: [...before.keyset.keys].reverse() })
  const payload: GrantPayload = {
    v: 1,
    iss: 'https://example.test',
    kid: before.kid,
    sub: '00000000-0000-4000-8000-000000000001',
    sid: '00000000-0000-4000-8000-000000000002',
    hostId: '00000000-0000-4000-8000-000000000003',
    epoch: 1,
    client: { id: '00000000-0000-4000-8000-000000000004', label: 'Desktop' },
    caps: [],
    iat: 1000,
    exp: 1300,
    jti: '0123456789abcdef',
  }
  for (const signer of [before, after]) {
    const claims = { ...payload, kid: signer.kid }
    const grant = signer.sign(claims)
    const [, , encoded, signature] = grant.split('.')
    const key = after.keyset.keys.find((key) => key.kid === signer.kid)
    if (!encoded || !signature || !key) throw new Error('invalid grant')
    expect(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))).toEqual(claims)
    expect(Object.keys(key).sort()).toEqual(['kid', 'publicKey'])
    expect(Buffer.from(key.publicKey, 'base64url')).toHaveLength(32)
    expect(
      verify(
        null,
        Buffer.from(encoded, 'base64url'),
        createPublicKey({
          key: Buffer.concat([
            Buffer.from('302a300506032b6570032100', 'hex'),
            Buffer.from(key.publicKey, 'base64url'),
          ]),
          type: 'spki',
          format: 'der',
        }),
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true)
  }
  expect(JSON.stringify(after)).not.toContain(first.split('=')[1])
})
it('bounds keysets, rejects malformed or noncanonical seeds without echoing values', () => {
  expect(parseGrantKeys(undefined)).toBeNull()
  expect(
    parseGrantKeys(Array.from({ length: 8 }, (_, i) => entry(`k${i}`)).join(','))?.keyset.keys,
  ).toHaveLength(8)
  const canonical = randomBytes(32).toString('base64url')
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const last = alphabet.indexOf(canonical.slice(-1))
  const noncanonical = canonical.slice(0, -1) + alphabet[last + 1]
  const failures = [
    '',
    entry('bad id'),
    entry('x'.repeat(65)),
    `one=${randomBytes(31).toString('base64url')}`,
    `one=${randomBytes(33).toString('base64url')}`,
    `one=${noncanonical}`,
    `one=${canonical},one=${canonical}`,
    `one=${canonical}=`,
    Array.from({ length: 9 }, (_, i) => entry(`k${i}`)).join(','),
    'x'.repeat(4096),
    'x'.repeat(4097),
  ]
  for (const value of failures) {
    let message = ''
    try {
      parseGrantKeys(value)
    } catch (error) {
      if (error instanceof Error) message = error.message
    }
    expect(message).toMatch(/^Invalid CONTROL_GRANT_KEYS: .* at entry \d+$/)
    if (value) expect(message).not.toContain(value)
    expect(message).not.toContain(canonical)
    expect(() => parseConfig({ CONTROL_GRANT_KEYS: value })).toThrow('Invalid CONTROL_GRANT_KEYS')
  }
  // The total-length boundary is reachable, but cannot be a valid <=8-entry keyset.
  expect(() => parseGrantKeys('x'.repeat(4096))).toThrow('key id')
  expect(() => parseGrantKeys('x'.repeat(4097))).toThrow('length')
  for (const bytes of [31, 33])
    expect(() => parseGrantKeys(`one=${randomBytes(bytes).toString('base64url')}`)).toThrow(
      'seed length at entry 1',
    )
  expect(parseGrantKeys(entry('x'.repeat(64)))?.kid).toHaveLength(64)
})
it('accepts only canonical bare HTTPS or loopback HTTP origins without echoing invalid input', () => {
  expect(parseGrantOrigin()).toBe('https://phosphor.saccolabs.com')
  for (const value of [
    'https://example.test',
    'https://example.test:47615',
    'http://localhost:54351',
    'http://127.0.0.1:54351',
  ])
    expect(parseConfig({ CONTROL_PUBLIC_ORIGIN: value }).publicOrigin).toBe(value)
  for (const value of [
    '',
    'http://example.test',
    'http://localhost',
    'http://127.0.0.1',
    'http://localhost:80',
    'http://localhost:0',
    'http://localhost:65536',
    'http://[::1]:54351',
    'https://user:password@example.test',
    'https://example.test/',
    'https://example.test/path',
    'https://example.test?q=private',
    'https://example.test#private',
    'https://EXAMPLE.test',
    'https://example.test:443',
    'file:///private',
  ]) {
    expect(() => parseGrantOrigin(value)).toThrow('Invalid CONTROL_PUBLIC_ORIGIN')
  }
})
