import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyReleaseArtifact, verifyReleaseManifest } from '../verify'
import {
  createReleaseMirror,
  installCurrent,
  installVersion,
  publishRelease,
  releaseManifest,
} from './release-files'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})
function scratch() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'host-release-files-')))
  homes.push(home)
  return home
}
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const keep = () => {}

describe('installed version tree', () => {
  it('installs a version tree with its VERSION and placeholder files', () => {
    const lib = join(scratch(), 'lib')
    const folder = installVersion(lib, '3.1.4')
    expect(folder).toBe(join(lib, 'versions/3.1.4'))
    expect(readFileSync(join(folder, 'VERSION'), 'utf8')).toBe('3.1.4\n')
    for (const name of ['bin/phosphor', 'node/bin/node', 'lib/phosphor.mjs'])
      expect(readFileSync(join(folder, name), 'utf8')).toBe('test')
    expect(installVersion(lib, '3.1.4')).toBe(folder)
  })

  it('makes 1.0.0 current and points the launcher through current', () => {
    const home = scratch()
    const lib = join(home, 'lib')
    const old = installCurrent(home, lib)
    expect(old).toBe(join(lib, 'versions/1.0.0'))
    expect(readlinkSync(join(lib, 'current'))).toBe('versions/1.0.0')
    expect(readlinkSync(join(home, '.local/bin/phosphor'))).toBe(join(lib, 'current/bin/phosphor'))
    expect(realpathSync(join(home, '.local/bin/phosphor'))).toBe(join(old, 'bin/phosphor'))
  })
})

describe('signed mirror', () => {
  it('creates an empty mirror and its throwaway key', () => {
    const home = scratch()
    const mirror = createReleaseMirror(home)
    expect(mirror.assets).toBe(join(home, 'assets'))
    expect(readdirSync(mirror.assets)).toEqual([])
    expect(mirror.key).toBe(join(home, 'throwaway'))
    expect(existsSync(mirror.key)).toBe(true)
    expect(mirror.keys).toEqual([
      { id: 'test', publicKey: readFileSync(mirror.key + '.pub', 'utf8').trim() },
    ])
  })

  it('describes exactly the bytes it is given', () => {
    const bytes = Buffer.from('artifact')
    expect(releaseManifest('1.0.1', 'name.tar.gz', bytes)).toEqual({
      schema: 1,
      version: '1.0.1',
      protocols: [1],
      node: '24.14.1',
      sourceCommit: 'a'.repeat(40),
      artifacts: [{ target: 'linux-x64', file: 'name.tar.gz', bytes: 8, sha256: sha256(bytes) }],
    })
  })

  it('publishes a manifest whose signature verifies and whose artifact matches its hash', () => {
    const mirror = createReleaseMirror(scratch())
    const bytes = Buffer.from('release bytes')
    const path = publishRelease(mirror, '1.2.3', bytes, keep)
    expect(path).toBe(join(mirror.assets, 'phosphor-host.manifest.json'))
    const manifest = verifyReleaseManifest(
      readFileSync(path),
      readFileSync(path + '.sig', 'utf8'),
      mirror.keys,
    )
    const [artifact] = manifest.artifacts
    expect(artifact).toEqual({
      target: 'linux-x64',
      file: 'phosphor-host-1.2.3-linux-x64.tar.gz',
      bytes: bytes.length,
      sha256: sha256(bytes),
    })
    const published = readFileSync(join(mirror.assets, 'phosphor-host-1.2.3-linux-x64.tar.gz'))
    expect(published).toEqual(bytes)
    if (artifact) expect(() => verifyReleaseArtifact(published, artifact)).not.toThrow()
  })

  it('signs the faulted manifest under the request name, keeping the artifact as built', () => {
    const mirror = createReleaseMirror(scratch())
    const bytes = Buffer.from('release bytes')
    const path = publishRelease(
      mirror,
      '1.2.3',
      bytes,
      (manifest) => {
        manifest.node = '99.0.0'
        manifest.artifacts = []
      },
      'v1.2.3',
    )
    expect(path).toBe(join(mirror.assets, 'phosphor-host-v1.2.3.manifest.json'))
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ node: '99.0.0', artifacts: [] })
    expect(readFileSync(join(mirror.assets, 'phosphor-host-1.2.3-linux-x64.tar.gz'))).toEqual(bytes)
  })

  it('replaces a stale signature instead of failing on it', () => {
    const mirror = createReleaseMirror(scratch())
    const path = join(mirror.assets, 'phosphor-host.manifest.json')
    writeFileSync(path + '.sig', 'stale')
    publishRelease(mirror, '1.2.3', Buffer.from('x'), keep)
    expect(readFileSync(path + '.sig', 'utf8')).toMatch(/^-----BEGIN SSH SIGNATURE-----\n/)
    expect(() =>
      verifyReleaseManifest(readFileSync(path), readFileSync(path + '.sig', 'utf8'), mirror.keys),
    ).not.toThrow()
  })

  it('signs with its own key only', () => {
    const mirror = createReleaseMirror(scratch())
    const elsewhere = createReleaseMirror(scratch())
    const path = publishRelease(mirror, '1.2.3', Buffer.from('x'), keep)
    expect(() =>
      verifyReleaseManifest(
        readFileSync(path),
        readFileSync(path + '.sig', 'utf8'),
        elsewhere.keys,
      ),
    ).toThrow('Invalid release manifest or signature')
  })
})
