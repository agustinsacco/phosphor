import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto'
import { lstatSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { isPublicKey, isUuid, normalizeLabel } from '@phosphor/shared/control-api'
import { errnoIs, isOwnerPrivate } from '@phosphor/session-runtime/fs-safety'
import { atomicRecord, readBounded } from '@phosphor/session-runtime/host-install/files'
import type { Cipher } from '../account/vault'

/**
 * Desktop's owner key for its own Phosphor service (reconcile D2-Q1): an
 * Ed25519 pair whose private half exists on disk only as safeStorage
 * ciphertext. The service learns only the public half, through
 * `setup --local --owner-key`. Every path here fails closed: without protected
 * storage there is no key, and Desktop stays on the in-app runtime.
 */

export const OWNER_KEY_FILE = 'owner-key.json'
export const OWNER_KEY_LABEL = 'Phosphor Desktop'
const OWNER_KEY_MAX_BYTES = 8192

interface OwnerKeyFile {
  version: 1
  id: string
  label: string
  /** Raw Ed25519 public key, base64url (JWK `x`). */
  publicKey: string
  /** safeStorage ciphertext of the PKCS#8 DER private key in base64, itself base64. */
  sealed: string
}

export interface OwnerKey {
  readonly id: string
  readonly label: string
  readonly publicKey: string
  /** Signs owner credential payload bytes; 64 bytes out. */
  sign(bytes: Uint8Array): Uint8Array
}

export type OwnerKeyResult =
  { ok: true; key: OwnerKey; created: boolean } | { ok: false; reason: string }

export interface OwnerKeyOptions {
  /** A Desktop-owned folder under userData; created 0700. */
  dir: string
  cipher: Cipher
  uid?: number
}

const refuse = (reason: string): OwnerKeyResult => ({ ok: false, reason })

function parseKeyFile(text: string): OwnerKeyFile | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const r = v as Record<string, unknown>
  return r.version === 1 &&
    isUuid(r.id) &&
    typeof r.label === 'string' &&
    normalizeLabel(r.label) === r.label &&
    isPublicKey(r.publicKey) &&
    typeof r.sealed === 'string' &&
    r.sealed.length > 0
    ? { version: 1, id: r.id, label: r.label, publicKey: r.publicKey, sealed: r.sealed }
    : null
}

const publicHalf = (key: KeyObject): string | undefined =>
  createPublicKey(key).export({ format: 'jwk' }).x

function ownerKey(file: OwnerKeyFile, privateKey: KeyObject): OwnerKey {
  return {
    id: file.id,
    label: file.label,
    publicKey: file.publicKey,
    sign: (bytes) => new Uint8Array(sign(null, bytes, privateKey)),
  }
}

function privateFolder(dir: string, uid: number | undefined): boolean {
  try {
    mkdirSync(dir, { mode: 0o700 })
  } catch (error) {
    if (!errnoIs(error, 'EEXIST')) throw error
  }
  const info = lstatSync(dir)
  return info.isDirectory() && !info.isSymbolicLink() && isOwnerPrivate(info, uid)
}

async function openKey(file: OwnerKeyFile, cipher: Cipher): Promise<OwnerKeyResult> {
  let privateKey: KeyObject
  try {
    const der = await cipher.decrypt(Buffer.from(file.sealed, 'base64'))
    privateKey = createPrivateKey({ key: Buffer.from(der, 'base64'), format: 'der', type: 'pkcs8' })
  } catch {
    return refuse('The Phosphor service key could not be read from protected storage.')
  }
  if (privateKey.asymmetricKeyType !== 'ed25519' || publicHalf(privateKey) !== file.publicKey)
    return refuse('The Phosphor service key does not match its record.')
  return { ok: true, key: ownerKey(file, privateKey), created: false }
}

async function createKey(path: string, cipher: Cipher): Promise<OwnerKeyResult> {
  const { privateKey } = generateKeyPairSync('ed25519')
  const der = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
  const publicKey = publicHalf(privateKey)
  if (!isPublicKey(publicKey)) return refuse('The Phosphor service key could not be created.')
  const ciphertext = await cipher.encrypt(der)
  if (ciphertext.length === 0 || ciphertext.includes(der))
    return refuse('Protected storage did not encrypt the Phosphor service key.')
  const sealed = ciphertext.toString('base64')
  const file: OwnerKeyFile = {
    version: 1,
    id: randomUUID(),
    label: OWNER_KEY_LABEL,
    publicKey,
    sealed,
  }
  atomicRecord(path, file, 0o600)
  return { ok: true, key: ownerKey(file, privateKey), created: true }
}

/**
 * Desktop's owner key, created on first use. An existing record is never
 * replaced: a key that cannot be decrypted or does not match is a refusal, so a
 * keychain problem never silently re-pairs the service with a new key.
 */
export async function loadOwnerKey(options: OwnerKeyOptions): Promise<OwnerKeyResult> {
  try {
    return await loadOrCreate(options)
  } catch {
    return refuse('The Phosphor service key could not be prepared.')
  }
}

async function loadOrCreate(options: OwnerKeyOptions): Promise<OwnerKeyResult> {
  const { dir, cipher, uid = process.getuid?.() } = options
  const storage = await cipher.storage()
  if (!storage.ok) return refuse(`Protected storage is unavailable: ${storage.reason}.`)
  // Linux without a keyring "encrypts" with a fixed key; that is not protected storage.
  if (storage.kind === 'file')
    return refuse('Protected storage is unavailable: no system keyring is running.')
  if (!privateFolder(dir, uid)) return refuse('The Phosphor service key folder is not private.')
  const path = join(dir, OWNER_KEY_FILE)
  let text: string
  try {
    const info = lstatSync(path)
    if (!info.isFile() || !isOwnerPrivate(info, uid))
      return refuse('The Phosphor service key record is not private.')
    text = readBounded(path, OWNER_KEY_MAX_BYTES)
  } catch (error) {
    if (errnoIs(error, 'ENOENT')) return createKey(path, cipher)
    return refuse('The Phosphor service key record could not be read.')
  }
  const file = parseKeyFile(text)
  if (!file) return refuse('The Phosphor service key record is invalid.')
  return openKey(file, cipher)
}
