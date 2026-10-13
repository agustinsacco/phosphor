import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { verifyReleaseArtifact, verifyReleaseManifest } from './verify'
import { HOST_RELEASE_MANIFEST_MAX_BYTES } from '@phosphor/shared/host-release'

const dir = mkdtempSync(join(tmpdir(), 'release-verify-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
for (const name of ['key', 'other']) {
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, name)])
}
const keys = [{ id: 'test', publicKey: readFileSync(join(dir, 'key.pub'), 'utf8').trim() }]
const artifact = Buffer.from('bundle')
const entry = {
  target: 'darwin-arm64' as const,
  file: 'phosphor-host-1.2.3-darwin-arm64.tar.gz',
  bytes: artifact.length,
  sha256: createHash('sha256').update(artifact).digest('hex'),
}
const manifest = Buffer.from(
  JSON.stringify({
    schema: 1,
    version: '1.2.3',
    protocols: [1],
    node: '24.14.1',
    sourceCommit: 'a'.repeat(40),
    artifacts: [entry],
  }),
)
function sign(
  bytes: Buffer,
  namespace = 'phosphor-host-release',
  key = 'key',
  algorithm = 'sha512',
) {
  return execFileSync(
    'ssh-keygen',
    ['-Y', 'sign', '-f', join(dir, key), '-n', namespace, '-O', `hashalg=${algorithm}`],
    { input: bytes, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  )
}
const signature = sign(manifest)
describe('OpenSSH release verification', () => {
  it('cross-checks ssh-keygen signatures and artifact bytes', () => {
    expect(verifyReleaseManifest(manifest, signature, keys).version).toBe('1.2.3')
    expect(() => verifyReleaseArtifact(artifact, entry)).not.toThrow()
  })
  it('rejects a flipped manifest byte, namespace, or signing key', () => {
    const changed = Buffer.from(manifest)
    changed[changed.indexOf('a'.repeat(40))] = 98
    for (const [bytes, sig] of [
      [changed, signature],
      [manifest, sign(manifest, 'wrong')],
      [manifest, sign(manifest, 'phosphor-host-release', 'other')],
    ] as const)
      expect(() => verifyReleaseManifest(bytes, sig, keys)).toThrow('Invalid release')
    expect(() => verifyReleaseManifest(manifest, signature)).toThrow()
    expect(() =>
      verifyReleaseManifest(
        manifest,
        sign(manifest, 'phosphor-host-release', 'key', 'sha256'),
        keys,
      ),
    ).toThrow()
  })
  it('rejects wrong artifact hash and size', () => {
    expect(() => verifyReleaseArtifact(Buffer.from('Bundle'), entry)).toThrow()
    expect(() => verifyReleaseArtifact(Buffer.from('bundles'), entry)).toThrow()
    expect(() =>
      verifyReleaseArtifact(artifact, { ...entry, bytes: artifact.length + 1 }),
    ).toThrow()
  })
  it('accepts exact byte/key limits and refuses one beyond them', () => {
    const padded = Buffer.concat([
      manifest,
      Buffer.alloc(HOST_RELEASE_MANIFEST_MAX_BYTES - manifest.length, 32),
    ])
    expect(verifyReleaseManifest(padded, sign(padded), keys).version).toBe('1.2.3')
    const tooLarge = Buffer.concat([padded, Buffer.from(' ')])
    expect(() => verifyReleaseManifest(tooLarge, sign(tooLarge), keys)).toThrow()
    const armor = (size: number) =>
      signature.replace('-----END', '\n'.repeat(size - signature.length) + '-----END')
    expect(verifyReleaseManifest(manifest, armor(8192), keys).version).toBe('1.2.3')
    expect(() => verifyReleaseManifest(manifest, armor(8193), keys)).toThrow()
    expect(
      verifyReleaseManifest(
        manifest,
        signature,
        Array.from({ length: 16 }, () => keys[0]).filter((key) => key !== undefined),
      ).version,
    ).toBe('1.2.3')
    expect(() =>
      verifyReleaseManifest(
        manifest,
        signature,
        Array.from({ length: 17 }, () => keys[0]).filter((key) => key !== undefined),
      ),
    ).toThrow()
  })
  it('rejects malformed SSHSIG lengths, algorithms, version, magic and reserved field', () => {
    const encoded = signature.split('\n').slice(1, -2).join('')
    const bytes = Buffer.from(encoded, 'base64')
    for (const offset of [0, 9, 13, 18, 32, 93, 98, 112, 126, 127]) {
      const changed = Buffer.from(bytes)
      changed[offset] = 255
      const armor = `-----BEGIN SSH SIGNATURE-----\n${changed.toString('base64')}\n-----END SSH SIGNATURE-----\n`
      expect(() => verifyReleaseManifest(manifest, armor, keys)).toThrow()
    }
  })
  it('rejects oversize, malformed signatures, trailing SSHSIG bytes and malformed signed metadata', () => {
    expect(() =>
      verifyReleaseManifest(Buffer.alloc(HOST_RELEASE_MANIFEST_MAX_BYTES + 1), signature, keys),
    ).toThrow()
    expect(() => verifyReleaseManifest(manifest, 'x'.repeat(8193), keys)).toThrow()
    for (const sig of ['', signature.replace('BEGIN', 'OTHER'), signature.replace('SSHSIG', '')])
      if (sig !== signature) expect(() => verifyReleaseManifest(manifest, sig, keys)).toThrow()
    const invalid = Buffer.from('{}')
    expect(() => verifyReleaseManifest(invalid, sign(invalid), keys)).toThrow()
    const encoded = signature.split('\n').slice(1, -2).join('')
    const trailing = Buffer.concat([Buffer.from(encoded, 'base64'), Buffer.from([0])]).toString(
      'base64',
    )
    expect(() =>
      verifyReleaseManifest(
        manifest,
        `-----BEGIN SSH SIGNATURE-----\n${trailing}\n-----END SSH SIGNATURE-----\n`,
        keys,
      ),
    ).toThrow()
  })
})
