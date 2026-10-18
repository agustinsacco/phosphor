// Signed Host bundle suite: manifest signing, pinned keys and signed-release rejection.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { verifyReleaseManifest } from '../../apps/host/src/update/verify'
import { HOST_PROTOCOL_VERSION } from '../../libs/shared/src/remote-host'
import {
  type BundleFixture,
  type ReleaseMetadata,
  disposeBundleFixture,
  install,
  node,
  root,
  setupBundleFixture,
  target,
} from './__fixtures__/bundle-fixture'
let fixture: BundleFixture
beforeAll(() => {
  fixture = setupBundleFixture()
}, 60000)
afterAll(() => disposeBundleFixture(fixture))

describe('signed Host bundle tools', { timeout: 60_000 }, () => {
  it('emits the contract protocols and signs a complete three-target manifest', () => {
    const output = join(fixture.dir, 'manifest-output')
    mkdirSync(output)
    for (const target of ['linux-x64', 'linux-arm64', 'darwin-arm64'])
      writeFileSync(join(output, `phosphor-host-1.2.3-${target}.tar.gz`), 'test artifact')
    node(
      `import {makeManifest} from './tools/host-release/manifest.mjs'; makeManifest(${JSON.stringify(output)})`,
      { HOST_RELEASE_SIGNING_KEY: fixture.privateKey },
    )
    const path = join(output, 'phosphor-host-1.2.3.manifest.json')
    const manifest = verifyReleaseManifest(
      readFileSync(path),
      readFileSync(`${path}.sig`, 'utf8'),
      [{ id: 'test', publicKey: fixture.publicKey }],
    )
    expect(manifest.protocols).toEqual([HOST_PROTOCOL_VERSION])
    expect(manifest.artifacts).toHaveLength(3)
    for (const name of readdirSync(output))
      expect(readFileSync(join(output, name)).includes(Buffer.from(fixture.privateKey))).toBe(false)
  })
  it('keeps the checked-in installer generated from the pinned key source', () => {
    const generated = join(fixture.dir, 'generated-install.sh')
    node(
      `import {generateInstaller} from './tools/host-release/installer.mjs'; generateInstaller(${JSON.stringify(generated)})`,
    )
    expect(
      readFileSync(generated).equals(readFileSync(join(root, 'tools/host-release/install.sh'))),
    ).toBe(true)
  })
  it('refuses wrong Node archive hash before extraction or build', () => {
    expect(() =>
      node(
        `import {nodeArchive} from './tools/host-release/build-bundle.mjs'; await nodeArchive(${JSON.stringify(target)},${JSON.stringify(fixture.cache)})`,
      ),
    ).toThrow(/Node archive hash mismatch/)
  })
  it('refuses changed manifest, wrong namespace, other key, artifact hash and size without changing existing install', () => {
    const cases = [
      () => install(fixture, { flip: true }),
      () => install(fixture, { namespace: 'wrong' }),
      () => install(fixture, { key: 'other' }),
      () => install(fixture, { algorithm: 'sha256' }),
      () =>
        install(fixture, {
          change: (m) => {
            const a = m.artifacts[0]
            if (a) a.sha256 = '0'.repeat(64)
          },
        }),
      () =>
        install(fixture, {
          change: (m) => {
            const a = m.artifacts[0]
            if (a) a.bytes--
          },
        }),
      () =>
        install(fixture, {
          change: (m) => {
            const a = m.artifacts[0]
            if (a) a.bytes++
          },
        }),
    ]
    for (const run of cases) {
      const { result, old } = run()
      expect(result.status).not.toBe(0)
      expect(readdirSync(join(old, 'versions'))).toEqual(['old'])
      expect(execFileSync('readlink', [join(old, 'current')], { encoding: 'utf8' }).trim()).toBe(
        'versions/old',
      )
      expect(existsSync(join(old, '.install'))).toBe(false)
    }
  })
  it('refuses unsafe signed versions and artifact paths', () => {
    for (const version of ['../1.2.3', '1/2/3', '1.2.3\n', '01.2.3', '1.2.4']) {
      const { result } = install(fixture, {
        change: (m) => {
          m.version = version
        },
      })
      expect(result.status).not.toBe(0)
    }
    const { result } = install(fixture, {
      change: (m) => {
        const a = m.artifacts[0]
        if (a) a.file = '../escape'
      },
    })
    expect(result.status).not.toBe(0)
  })
  it('rejects signed malformed shapes, duplicate targets, unknown fields and limits', () => {
    const changes = [
      (m: ReleaseMetadata) => {
        Reflect.set(m, 'schema', '1')
      },
      (m: ReleaseMetadata) => {
        Reflect.set(m, 'extra', true)
      },
      (m: ReleaseMetadata) => {
        Reflect.set(m, 'protocols', ['1'])
      },
      (m: ReleaseMetadata) => {
        m.protocols = []
      },
      (m: ReleaseMetadata) => {
        m.protocols = [1, 1]
      },
      (m: ReleaseMetadata) => {
        m.protocols = [65536]
      },
      (m: ReleaseMetadata) => {
        m.artifacts.push(...m.artifacts)
      },
      (m: ReleaseMetadata) => {
        const a = m.artifacts[0]
        if (a) a.bytes = 268435457
      },
    ]
    for (const change of changes) expect(install(fixture, { change }).result.status).not.toBe(0)
  })
  it('rejects signed JSON with quoted array delimiters', () => {
    for (const change of [
      (json: string) => json.replace('2\n  ]', '2\n  "]"'),
      (json: string) => json.replace('}\n  ]', '}\n  "]"'),
      (json: string) => json.replace('1,\n    2', '1 ","\n    2'),
    ]) {
      const { result } = install(fixture, {
        change: (m) => {
          m.protocols = [1, 2]
        },
        rawManifest: change,
      })
      expect(result.status).not.toBe(0)
    }
  })
  it('refuses signed archive traversal and symlinks before extracting anything', () => {
    const original = fixture.bundle
    try {
      for (const kind of ['traversal', 'symlink']) {
        const tar = gunzipSync(original)
        const header = tar.subarray(0, 512)
        if (kind === 'traversal') {
          header.fill(0, 0, 100)
          header.write('../escaped', 0, 'ascii')
        } else {
          header[156] = 50
          header.write('outside-target', 157, 'ascii')
        }
        header.fill(32, 148, 156)
        header.write(
          header
            .reduce((a, b) => a + b, 0)
            .toString(8)
            .padStart(6, '0') + '\0 ',
          148,
          'ascii',
        )
        fixture.bundle = gzipSync(tar)
        const { result, old, home } = install(fixture, {
          prepare: (home) => {
            const commands = join(home, 'commands')
            mkdirSync(commands)
            const realTar = execFileSync('sh', ['-c', 'command -v tar'], {
              encoding: 'utf8',
            }).trim()
            writeFileSync(
              join(commands, 'tar'),
              `#!/bin/sh\n[ "$1" != '-xzf' ] || touch "$HOME/extracted"\nexec ${realTar} "$@"\n`,
              { mode: 0o755 },
            )
            return { PATH: `${commands}:${process.env.PATH}` }
          },
        })
        expect(result.status).not.toBe(0)
        expect(existsSync(join(home, 'extracted'))).toBe(false)
        expect(readdirSync(join(old, 'versions'))).toEqual(['old'])
      }
    } finally {
      fixture.bundle = original
    }
  })
  it('refuses directory symlinks outside its allowed install tree', () => {
    const { result, home } = install(fixture, {
      prepare: (home) => {
        const outside = join(home, 'outside')
        mkdirSync(outside)
        rmSync(join(home, '.local/bin'), { recursive: true })
        execFileSync('ln', ['-s', outside, join(home, '.local/bin')])
        return {}
      },
    })
    expect(result.status).not.toBe(0)
    expect(readdirSync(join(home, 'outside'))).toEqual([])
  })
  it('cleans up its environment-only signing key on success and failure', () => {
    const temp = join(fixture.dir, 'sign-tmp')
    mkdirSync(temp)
    const env = { HOST_RELEASE_SIGNING_KEY: fixture.privateKey, TMPDIR: temp }
    const output = node(
      `import {signManifest} from './tools/host-release/manifest.mjs'; signManifest(Buffer.from('test'))`,
      env,
    )
    expect(output).not.toContain(fixture.privateKey.trim())
    expect(readdirSync(temp)).toEqual([])
    expect(() =>
      node(
        `import {signManifest} from './tools/host-release/manifest.mjs'; signManifest(Buffer.from('test'))`,
        { ...env, HOST_RELEASE_SIGNING_KEY: 'invalid-test-key' },
      ),
    ).toThrow(/Release signing failed/)
    expect(readdirSync(temp)).toEqual([])
  })
  it('signs with a key whose secret store dropped the final newline or used CRLF', () => {
    const sign = `import {signManifest} from './tools/host-release/manifest.mjs'; process.stdout.write(signManifest(Buffer.from('test')).toString('utf8'))`
    for (const key of [
      fixture.privateKey.trimEnd(),
      fixture.privateKey.trimEnd().replace(/\n/g, '\r\n'),
    ]) {
      expect(node(sign, { HOST_RELEASE_SIGNING_KEY: key })).toContain('BEGIN SSH SIGNATURE')
    }
  })
})
