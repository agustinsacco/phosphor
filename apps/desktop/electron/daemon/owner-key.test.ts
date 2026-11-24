import { createPublicKey, verify } from 'node:crypto'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeCipher } from '../account/__fixtures__/fakes'
import { OWNER_KEY_FILE, loadOwnerKey } from './owner-key'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function folder() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'owner-key-')))
  roots.push(root)
  return join(root, 'daemon')
}
const publicKeyObject = (x: string) =>
  createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' })

describe('loadOwnerKey', () => {
  it('creates an Ed25519 key once, sealed by protected storage, and signs with it', async () => {
    const dir = folder()
    const { cipher } = fakeCipher({ ok: true, kind: 'keychain' })
    const first = await loadOwnerKey({ dir, cipher })
    expect(first.ok && first.created).toBe(true)
    if (!first.ok) return
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, OWNER_KEY_FILE)).mode & 0o777).toBe(0o600)
    // The private key never reaches the disk in the clear.
    const record = readFileSync(join(dir, OWNER_KEY_FILE), 'utf8')
    expect(record).not.toContain('PRIVATE')
    expect(Object.keys(JSON.parse(record) as object).sort()).toEqual(
      ['id', 'label', 'publicKey', 'sealed', 'version'].sort(),
    )
    const again = await loadOwnerKey({ dir, cipher })
    expect(again.ok && !again.created && again.key.publicKey).toBe(first.key.publicKey)
    if (!again.ok) return
    const bytes = new TextEncoder().encode('payload')
    const signature = again.key.sign(bytes)
    expect(signature).toHaveLength(64)
    expect(verify(null, bytes, publicKeyObject(first.key.publicKey), signature)).toBe(true)
  })
  it.each([
    [{ ok: false, reason: 'no secure storage is available' }, 'unavailable'],
    [{ ok: true, kind: 'file' }, 'no system keyring'],
  ] as const)(
    'fails closed without protected storage (%o) and writes nothing',
    async (storage, text) => {
      const dir = folder()
      const result = await loadOwnerKey({ dir, cipher: fakeCipher(storage).cipher })
      expect(result).toEqual({ ok: false, reason: expect.stringContaining(text) as string })
      expect(() => statSync(dir)).toThrow()
    },
  )
  it('never replaces a record it cannot decrypt or that does not match', async () => {
    const dir = folder()
    const { cipher } = fakeCipher({ ok: true, kind: 'keychain' })
    await loadOwnerKey({ dir, cipher })
    const path = join(dir, OWNER_KEY_FILE)
    const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
    const foreign = { ...cipher, decrypt: () => Promise.reject(new Error('locked')) }
    expect(await loadOwnerKey({ dir, cipher: foreign })).toMatchObject({ ok: false })
    const other = await loadOwnerKey({ dir: folder(), cipher })
    if (!other.ok) throw new Error('expected a second key')
    writeFileSync(path, JSON.stringify({ ...record, publicKey: other.key.publicKey }), {
      mode: 0o600,
    })
    expect(await loadOwnerKey({ dir, cipher })).toEqual({
      ok: false,
      reason: expect.stringContaining('does not match') as string,
    })
    writeFileSync(path, '{', { mode: 0o600 })
    expect(await loadOwnerKey({ dir, cipher })).toMatchObject({ ok: false })
    expect(readFileSync(path, 'utf8')).toBe('{')
  })
  it('refuses a shared folder or record and a cipher that returns plaintext', async () => {
    const dir = folder()
    const { cipher } = fakeCipher({ ok: true, kind: 'keychain' })
    await loadOwnerKey({ dir, cipher })
    chmodSync(join(dir, OWNER_KEY_FILE), 0o644)
    expect(await loadOwnerKey({ dir, cipher })).toMatchObject({ ok: false })
    chmodSync(dir, 0o755)
    expect(await loadOwnerKey({ dir, cipher })).toMatchObject({ ok: false })
    const plain = { ...cipher, encrypt: (text: string) => Promise.resolve(Buffer.from(text)) }
    const fresh = folder()
    expect(await loadOwnerKey({ dir: fresh, cipher: plain })).toMatchObject({ ok: false })
    expect(() => statSync(join(fresh, OWNER_KEY_FILE))).toThrow()
    const failing = { ...cipher, encrypt: () => Promise.reject(new Error('denied')) }
    expect(await loadOwnerKey({ dir: folder(), cipher: failing })).toMatchObject({ ok: false })
  })
})
