import { createPrivateKey, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  assertReusableOrphan,
  discardsUncommittedKey,
  exportKeyPem,
  IdentityFailure,
  incompleteIdentity,
  isHostKeyFile,
  keyFileName,
  parseIdentity,
  parseIdentityText,
  parsePending,
  pendingKeyMatches,
  saveFailure,
  unsafeIdentity,
} from './identity-records'
import type { HostIdentity, PendingEnrollment } from './identity-types'
import { freshKey, publicIdentity } from './signer'

const INVALID = 'Invalid identity. Run phosphor logout --local, then phosphor setup.'
const hostId = '0b6f7c1e-2f4a-4c8e-9d1b-5a7e3c2f1d00'
const identity: HostIdentity = {
  version: 1,
  controlUrl: 'https://example.com',
  hostId,
  label: 'bee1',
  ownerLogin: 'me',
  savedAt: '2026-10-10T00:00:00.000Z',
}
const key = freshKey()
const pending: PendingEnrollment = {
  version: 1,
  controlUrl: identity.controlUrl,
  savedAt: identity.savedAt,
  enrollmentId: hostId,
  userCode: 'BCDFGHJK',
  keyFingerprint: publicIdentity(key).keyFingerprint,
  expiresAt: '2026-10-10T00:10:00.000Z',
  pollIntervalSec: 5,
}
const refusal = (work: () => unknown) => {
  try {
    work()
  } catch (error) {
    return error instanceof IdentityFailure ? error.message : `not an IdentityFailure: ${error}`
  }
  return 'accepted'
}

describe('identity failures', () => {
  it('builds the unsafe and incomplete refusals the CLI prints', () => {
    expect(unsafeIdentity()).toBeInstanceOf(Error)
    expect(unsafeIdentity().message).toMatch(/^Unsafe identity storage\. .*chmod 700 identity\.$/)
    expect(unsafeIdentity().incomplete).toBeUndefined()
    const failure = incompleteIdentity(identity)
    expect(failure.message).toMatch(/^Identity incomplete\. .*run phosphor setup\.$/)
    expect(failure.incomplete).toBe(identity)
  })

  it('passes its own refusals through a save and turns anything else into one retry hint', () => {
    const own = unsafeIdentity()
    expect(saveFailure(own)).toBe(own)
    for (const other of [new Error('EACCES'), 'string', undefined]) {
      const translated = saveFailure(other)
      expect(translated).toBeInstanceOf(IdentityFailure)
      expect(translated.message).toBe('Identity save failed. Run phosphor status before retrying.')
    }
  })
})

describe('identity metadata parser', () => {
  it('returns a canonical copy without unknown fields', () => {
    const parsed = parseIdentity({ secret: 'drop', ...identity, owner: { login: 'other' } })
    expect(parsed).toEqual(identity)
    expect(Object.keys(parsed)).toEqual(Object.keys(identity))
    expect(parseIdentity({ ...identity, ownerLogin: null }).ownerLogin).toBeNull()
  })

  it.each([
    ['an array', [identity]],
    ['null', null],
    ['version 2', { ...identity, version: 2 }],
    ['no controlUrl', { ...identity, controlUrl: undefined }],
    ['public http', { ...identity, controlUrl: 'http://public.example' }],
    ['bad savedAt', { ...identity, savedAt: 'bad' }],
    ['no ownerLogin', { version: 1, controlUrl: 'https://example.com', savedAt: identity.savedAt }],
    ['bad ownerLogin', { ...identity, ownerLogin: 'bad login' }],
    ['escaping hostId', { ...identity, hostId: '../escape' }],
    ['padded label', { ...identity, label: ' bee1 ' }],
  ])('refuses %s as invalid', (_name, value) => {
    expect(refusal(() => parseIdentity(value))).toBe(INVALID)
  })

  it('treats malformed JSON text like a bad shape', () => {
    expect(parseIdentityText(JSON.stringify(identity))).toEqual(identity)
    expect(refusal(() => parseIdentityText('{'))).toBe(INVALID)
    expect(refusal(() => parseIdentityText('[]'))).toBe(INVALID)
  })
})

describe('pending enrollment parser', () => {
  it('returns a canonical copy without unknown fields', () => {
    const parsed = parsePending({ secret: 'drop', ...pending })
    expect(parsed).toEqual(pending)
    expect(Object.keys(parsed)).toEqual(Object.keys(pending))
  })

  it.each([1, 60])('accepts poll interval %s', (pollIntervalSec) => {
    expect(parsePending({ ...pending, pollIntervalSec }).pollIntervalSec).toBe(pollIntervalSec)
  })

  it.each([
    ['null', null],
    ['version 2', { ...pending, version: 2 }],
    ['public http', { ...pending, controlUrl: 'http://public.example' }],
    ['bad savedAt', { ...pending, savedAt: 'bad' }],
    ['escaping enrollmentId', { ...pending, enrollmentId: '../escape' }],
    ['lowercase userCode', { ...pending, userCode: 'bcdfghjk' }],
    ['bad fingerprint', { ...pending, keyFingerprint: 'bad' }],
    ['poll interval 0', { ...pending, pollIntervalSec: 0 }],
    ['poll interval 61', { ...pending, pollIntervalSec: 61 }],
  ])('refuses %s', (_name, value) => {
    expect(refusal(() => parsePending(value))).toBe('Invalid pending enrollment.')
  })
})

describe('identity key association', () => {
  it('names the key file after the host id', () => {
    expect(keyFileName(hostId)).toBe(`host-key.${hostId}.pem`)
  })

  it.each([
    [`host-key.${hostId}.pem`, true],
    ['host-key.0b6f7c1e-2f4a-0c8e-9d1b-5a7e3c2f1d00.pem', false],
    [`host-key.${hostId.toUpperCase()}.pem`, false],
    [`host-key.${hostId}.pem.bak`, false],
    ['host-key.not-a-uuid.pem', false],
    ['pending-key.pem', false],
    ['host.json', false],
  ])('counts %s as a host key: %s', (name, expected) => {
    expect(isHostKeyFile(name)).toBe(expected)
  })

  it('exports a PKCS#8 PEM that loads back as the same key', () => {
    const pem = exportKeyPem(key)
    expect(pem).toMatch(/^-----BEGIN PRIVATE KEY-----\n/)
    expect(publicIdentity(createPrivateKey(pem))).toEqual(publicIdentity(key))
  })

  it('matches a pending key by fingerprint and refuses a non-Ed25519 key', () => {
    expect(pendingKeyMatches(pending, key)).toBe(true)
    expect(pendingKeyMatches(pending, freshKey())).toBe(false)
    const x25519 = generateKeyPairSync('x25519').privateKey
    expect(() => pendingKeyMatches(pending, x25519)).toThrow('Identity key must be Ed25519.')
  })
})

describe('identity commit and orphan decisions', () => {
  it('refuses an orphan with other bytes without asking whether host.json exists', async () => {
    const committed = vi.fn(async () => false)
    const pem = exportKeyPem(key)
    await expect(assertReusableOrphan(pem + '\n', pem, committed)).rejects.toThrow(
      unsafeIdentity().message,
    )
    expect(committed).not.toHaveBeenCalled()
  })

  it('reuses an identical orphan only while nothing is committed', async () => {
    const pem = exportKeyPem(key)
    await expect(assertReusableOrphan(pem, pem, async () => false)).resolves.toBeUndefined()
    await expect(assertReusableOrphan(pem, pem, async () => true)).rejects.toBeInstanceOf(
      IdentityFailure,
    )
    const probe = Object.assign(new Error('denied'), { code: 'EACCES' })
    await expect(assertReusableOrphan(pem, pem, async () => Promise.reject(probe))).rejects.toBe(
      probe,
    )
  })

  it.each([
    [true, false, true, true],
    [true, false, false, false],
    [true, true, true, false],
    [false, false, true, false],
  ])(
    'written %s, committed %s, aborted %s discards the key: %s',
    (written, committed, aborted, expected) => {
      expect(discardsUncommittedKey({ written, committed, aborted })).toBe(expected)
    },
  )
})
