import { createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto'
import { GRANT_PREFIX, type GrantKeySet, type GrantPayload } from '@phosphor/shared/host-grant'

export interface GrantKeys {
  readonly keyset: GrantKeySet
  readonly kid: string
  sign(payload: GrantPayload): string
}

/** Seeds stay inside this closure. Only the first key signs during rotation. */
export function parseGrantKeys(value: string | undefined): GrantKeys | null {
  if (value === undefined) return null
  const invalid = (rule: string, index: number): never => {
    throw new Error(`Invalid CONTROL_GRANT_KEYS: ${rule} at entry ${index + 1}`)
  }
  if (value.length > 4096) invalid('length', 0)
  const entries = value.split(',')
  if (entries.length > 8) invalid('key count', 8)
  const keys: { kid: string; publicKey: string }[] = []
  let signer: KeyObject | undefined
  for (const [index, entry] of entries.entries()) {
    const parts = entry.split('=')
    const [kid, seed] = parts
    if (parts.length !== 2 || !kid || !/^[A-Za-z0-9_-]{1,64}$/.test(kid)) invalid('key id', index)
    if (!seed || !/^[A-Za-z0-9_-]{43}$/.test(seed)) invalid('seed length', index)
    // Narrow again for strict indexed access after the never-returning validator.
    if (kid === undefined || seed === undefined) return invalid('entry', index)
    const bytes = Buffer.from(seed, 'base64url')
    if (bytes.length !== 32 || bytes.toString('base64url') !== seed)
      invalid('canonical seed', index)
    if (keys.some((key) => key.kid === kid)) invalid('duplicate key id', index)
    let privateKey: KeyObject
    try {
      privateKey = createPrivateKey({
        key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), bytes]),
        format: 'der',
        type: 'pkcs8',
      })
    } catch {
      return invalid('seed', index)
    }
    const publicKey = createPublicKey(privateKey)
      .export({ format: 'der', type: 'spki' })
      .subarray(-32)
      .toString('base64url')
    keys.push(Object.freeze({ kid, publicKey }))
    signer ??= privateKey
  }
  const first = keys[0]
  if (!first || !signer) return invalid('empty keyset', 0)
  const signingKey = signer
  return Object.freeze({
    kid: first.kid,
    keyset: Object.freeze({ keys: Object.freeze(keys) }),
    sign(payload: GrantPayload) {
      const bytes = Buffer.from(JSON.stringify(payload))
      return `${GRANT_PREFIX}${bytes.toString('base64url')}.${sign(null, bytes, signingKey).toString('base64url')}`
    },
  })
}

export function parseGrantOrigin(value = 'https://phosphor.saccolabs.com'): string {
  try {
    const url = new URL(value)
    if (
      url.origin === value &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          ['localhost', '127.0.0.1'].includes(url.hostname) &&
          Number(url.port) >= 1))
    )
      return value
  } catch {
    // Never include a configuration value in errors.
  }
  throw new Error('Invalid CONTROL_PUBLIC_ORIGIN')
}
