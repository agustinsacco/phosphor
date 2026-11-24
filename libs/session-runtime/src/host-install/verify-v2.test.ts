import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { verifyReleaseManifest, verifyReleaseManifestV2 } from './verify'

const dir = mkdtempSync(join(tmpdir(), 'release-verify-v2-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
for (const name of ['key', 'other'])
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, name)])
const keys = [{ id: 'test', publicKey: readFileSync(join(dir, 'key.pub'), 'utf8').trim() }]
const sign = (bytes: Buffer, key = 'key') =>
  execFileSync(
    'ssh-keygen',
    ['-Y', 'sign', '-f', join(dir, key), '-n', 'phosphor-host-release', '-O', 'hashalg=sha512'],
    { input: bytes, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  )
const v2 = {
  schema: 2,
  version: '1.2.3',
  protocols: [1],
  node: '24.14.1',
  sourceCommit: 'a'.repeat(40),
  features: ['local-mode', 'owner-socket'],
  artifacts: [
    {
      target: 'darwin-x64',
      file: 'phosphor-host-1.2.3-darwin-x64.tar.gz',
      bytes: 6,
      sha256: 'b'.repeat(64),
    },
  ],
}

describe('verifyReleaseManifestV2', () => {
  it('accepts a signed v2 manifest with the same pinned key as v1', () => {
    const bytes = Buffer.from(JSON.stringify(v2))
    expect(verifyReleaseManifestV2(bytes, sign(bytes), keys)).toEqual(v2)
  })
  it('refuses another key, a changed byte and a v1 manifest', () => {
    const bytes = Buffer.from(JSON.stringify(v2))
    const changed = Buffer.from(JSON.stringify({ ...v2, version: '1.2.4' }))
    const v1 = Buffer.from(JSON.stringify({ ...v2, schema: 1, features: undefined }))
    for (const [manifest, signature] of [
      [bytes, sign(bytes, 'other')],
      [changed, sign(bytes)],
      [v1, sign(v1)],
    ] as const)
      expect(() => verifyReleaseManifestV2(manifest, signature, keys)).toThrow(
        'Invalid release manifest or signature',
      )
  })
  it('never lets the v1 reader accept a v2 manifest', () => {
    const bytes = Buffer.from(JSON.stringify(v2))
    expect(() => verifyReleaseManifest(bytes, sign(bytes), keys)).toThrow('Invalid release')
  })
})
