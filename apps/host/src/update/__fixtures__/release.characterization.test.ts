import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyReleaseArtifact, verifyReleaseManifest } from '../verify'
import { bundle, fixture, tar } from './release'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup()
})
function fixtureFor() {
  const f = fixture()
  fixtures.push(f)
  return f
}
const read = (path: string) => readFileSync(path, 'utf8')
const signed = (f: ReturnType<typeof fixture>, path: string) =>
  verifyReleaseManifest(readFileSync(path), read(path + '.sig'), f.keys)

describe('tar and bundle', () => {
  it('writes one ustar header per entry, data padded to 512 bytes, then the ending', () => {
    const archive = tar([{ name: 'a/b', text: 'hello' }])
    expect(archive.length).toBe(512 + 512 + 1024)
    const header = archive.subarray(0, 512)
    const field = (start: number, end: number) => header.subarray(start, end).toString()
    expect(field(0, 4)).toBe('a/b\0')
    expect(field(100, 136)).toBe('0000755\0' + '0000000\0' + '0000000\0' + '00000000005\0')
    expect(field(136, 148)).toBe('00000000000\0')
    expect(field(156, 157)).toBe('0')
    expect(field(257, 265)).toBe('ustar\0' + '00')
    const sum = [...header].reduce((n, b, i) => n + (i >= 148 && i < 156 ? 32 : b), 0)
    expect(field(148, 156)).toBe(sum.toString(8).padStart(6, '0') + '\0 ')
    expect(archive.subarray(512, 517).toString()).toBe('hello')
    expect(archive.subarray(517).equals(Buffer.alloc(507 + 1024))).toBe(true)
  })

  it('takes test as default text, a declared size and type, and a custom ending', () => {
    const archive = tar([{ name: 'link', type: '2', size: 99 }], Buffer.from('end'))
    expect(archive.length).toBe(512 + 512 + 3)
    expect(archive.subarray(124, 136).toString()).toBe('00000000143\0')
    expect(archive.subarray(156, 157).toString()).toBe('2')
    expect(archive.subarray(512, 516).toString()).toBe('test')
    expect(archive.subarray(-3).toString()).toBe('end')
    expect(tar([])).toEqual(Buffer.alloc(1024))
  })

  it('bundles a gzip of VERSION and the four release files', () => {
    const files = ['bin/phosphor', 'node/bin/node', 'node/LICENSE', 'lib/phosphor.mjs']
    expect(gunzipSync(bundle('2.0.0'))).toEqual(
      tar([{ name: 'VERSION', text: '2.0.0\n' }, ...files.map((name) => ({ name }))]),
    )
    expect(gunzipSync(bundle())).toEqual(gunzipSync(bundle('1.2.3')))
  })
})

describe('release fixture install tree and links', () => {
  it('installs 1.0.0 as current with a launcher in ~/.local/bin', () => {
    const f = fixtureFor()
    expect(f.home).toBe(realpathSync(f.home))
    expect(f.home.startsWith(join(realpathSync(tmpdir()), 'host-update-'))).toBe(true)
    expect(f.lib).toBe(join(f.home, '.local/lib/phosphor-host'))
    expect(f.assets).toBe(join(f.home, 'assets'))
    expect(readdirSync(f.assets)).toEqual([])
    expect(f.old).toBe(join(f.lib, 'versions/1.0.0'))
    expect(read(join(f.old, 'VERSION'))).toBe('1.0.0\n')
    for (const name of ['bin/phosphor', 'node/bin/node', 'lib/phosphor.mjs'])
      expect(read(join(f.old, name))).toBe('test')
    expect(existsSync(join(f.old, 'node/LICENSE'))).toBe(false)
    expect(readlinkSync(join(f.lib, 'current'))).toBe('versions/1.0.0')
    expect(readlinkSync(join(f.home, '.local/bin/phosphor'))).toBe(
      join(f.lib, 'current/bin/phosphor'),
    )
    expect(realpathSync(join(f.home, '.local/bin/phosphor'))).toBe(join(f.old, 'bin/phosphor'))
  })

  it('installs more versions beside the current one', () => {
    const f = fixtureFor()
    expect(f.install('2.0.0')).toBe(join(f.lib, 'versions/2.0.0'))
    expect(read(join(f.lib, 'versions/2.0.0/VERSION'))).toBe('2.0.0\n')
    expect(readlinkSync(join(f.lib, 'current'))).toBe('versions/1.0.0')
  })

  it('builds an update context over the installed release and a throwaway key', async () => {
    const f = fixtureFor()
    expect(f.keys).toHaveLength(1)
    expect(f.keys[0]?.id).toBe('test')
    expect(f.keys[0]?.publicKey).toBe(read(join(f.home, 'throwaway.pub')).trim())
    expect(f.keys[0]?.publicKey).toMatch(/^ssh-ed25519 \S+/)
    const { print, service, ...context } = f.context
    expect(context).toEqual({
      home: f.home,
      nodeVersion: process.versions.node,
      defaultResourceRoot: '/unused',
      env: { PHOSPHOR_HOST_RELEASE_URL: pathToFileURL(f.assets).href },
      uid: process.getuid?.(),
      hostname: 'test-host',
      platform: 'linux',
      arch: 'x64',
      configPath: join(f.home, '.config/phosphor-host/config.json'),
      update: {
        node: join(f.old, 'node/bin/node'),
        bundle: join(f.old, 'lib/phosphor.mjs'),
        keys: f.keys,
        cgroup: '0::/user.slice/user-1000.slice/session-1.scope\n',
      },
    })
    print('hello')
    expect(f.messages).toEqual(['hello'])
    expect(await service?.runner?.('systemctl', [])).toEqual({ code: 3, stdout: '', stderr: '' })
  })

  it('gives every fixture its own home and key', () => {
    const first = fixtureFor()
    const second = fixtureFor()
    expect(first.home).not.toBe(second.home)
    expect(first.keys[0]?.publicKey).not.toBe(second.keys[0]?.publicKey)
  })
})

describe('release fixture signed mirror', () => {
  it('publishes a signed manifest and the artifact bytes it hashes', () => {
    const f = fixtureFor()
    const path = f.release()
    expect(path).toBe(join(f.assets, 'phosphor-host.manifest.json'))
    const bytes = bundle('1.2.3')
    const manifest = {
      schema: 1,
      version: '1.2.3',
      protocols: [1],
      node: '24.14.1',
      sourceCommit: 'a'.repeat(40),
      artifacts: [
        {
          target: 'linux-x64' as const,
          file: 'phosphor-host-1.2.3-linux-x64.tar.gz',
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    }
    expect(read(path)).toBe(JSON.stringify(manifest) + '\n')
    expect(signed(f, path)).toEqual(manifest)
    const artifact = readFileSync(join(f.assets, 'phosphor-host-1.2.3-linux-x64.tar.gz'))
    expect(artifact).toEqual(bytes)
    expect(() => verifyReleaseArtifact(artifact, manifest.artifacts[0]!)).not.toThrow()
    expect(readdirSync(f.assets).sort()).toEqual([
      'phosphor-host-1.2.3-linux-x64.tar.gz',
      'phosphor-host.manifest.json',
      'phosphor-host.manifest.json.sig',
    ])
  })

  it('signs the given version and bytes under a per-request manifest name', () => {
    const f = fixtureFor()
    const bytes = Buffer.from('not a bundle')
    const path = f.release('2.0.0', bytes, undefined, 'v2.0.0')
    expect(path).toBe(join(f.assets, 'phosphor-host-v2.0.0.manifest.json'))
    const manifest = signed(f, path)
    expect(manifest.version).toBe('2.0.0')
    expect(manifest.artifacts[0]).toEqual({
      target: 'linux-x64',
      file: 'phosphor-host-2.0.0-linux-x64.tar.gz',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
    expect(readFileSync(join(f.assets, 'phosphor-host-2.0.0-linux-x64.tar.gz'))).toEqual(bytes)
  })

  it('signs the manifest after the fault hook mutates it, keeping the original artifact', () => {
    const f = fixtureFor()
    const bytes = bundle('1.2.3')
    const path = f.release('1.2.3', bytes, (m) => {
      expect(m.artifacts[0]?.bytes).toBe(bytes.length)
      m.version = '9.9.9'
      m.artifacts[0]!.sha256 = '0'.repeat(64)
      m.artifacts[0]!.file = 'phosphor-host-9.9.9-linux-x64.tar.gz'
    })
    const manifest = signed(f, path)
    expect(manifest.version).toBe('9.9.9')
    expect(manifest.artifacts[0]).toMatchObject({
      sha256: '0'.repeat(64),
      file: 'phosphor-host-9.9.9-linux-x64.tar.gz',
    })
    expect(readFileSync(join(f.assets, 'phosphor-host-1.2.3-linux-x64.tar.gz'))).toEqual(bytes)
    expect(existsSync(join(f.assets, 'phosphor-host-9.9.9-linux-x64.tar.gz'))).toBe(false)
    f.release('1.2.3', bytes, (m) => {
      m.protocols = []
    })
    expect(JSON.parse(read(path))).toMatchObject({ version: '1.2.3', protocols: [] })
    expect(existsSync(path + '.sig')).toBe(true)
  })

  it('replaces an earlier signature when it publishes the same manifest again', () => {
    const f = fixtureFor()
    const path = f.release('1.2.3')
    const first = read(path + '.sig')
    expect(f.release('1.2.4')).toBe(path)
    expect(read(path + '.sig')).not.toBe(first)
    expect(signed(f, path).version).toBe('1.2.4')
    expect(() => verifyReleaseManifest(readFileSync(path), first, f.keys)).toThrow()
    expect(readdirSync(f.assets)).toHaveLength(4)
  })

  it('removes the whole home on cleanup', () => {
    const f = fixture()
    f.cleanup()
    expect(existsSync(dirname(f.lib))).toBe(false)
    expect(existsSync(f.home)).toBe(false)
  })
})
