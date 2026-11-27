// Signed Host bundle suite: manifest signing, pinned keys and signed-release rejection.
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { verifyReleaseManifest } from '@phosphor/session-runtime/host-install/verify'
import { decompressRelease, extractRelease } from '@phosphor/session-runtime/host-install/archive'
import { tar } from '@phosphor/session-runtime/host-install/__fixtures__/tar'
import { brainPackageFixture } from '../../apps/host/src/update/__fixtures__/brain-package'
import { packagedNodeVersion } from '../../apps/host/src/brain/packaged-runtime'
import { HOST_PROTOCOL_VERSION } from '../../libs/shared/src/remote-host'
import {
  type BundleFixture,
  type ReleaseMetadata,
  disposeBundleFixture,
  install,
  node,
  root,
  rerun,
  setupBundleFixture,
  target,
} from './__fixtures__/bundle-fixture'
let fixture: BundleFixture
beforeAll(() => {
  fixture = setupBundleFixture()
}, 60000)
afterAll(() => disposeBundleFixture(fixture))

function assertUnsafeRepairsRefused(home: string, old: string, release: string) {
  const current = join(old, 'current')
  const program = join(old, 'versions/1.2.3')
  const bin = join(home, '.local/bin/phosphor')
  const unset = () => {
    rmSync(bin, { force: true })
    rmSync(current, { force: true })
  }
  for (const harm of ['mode', 'contents', 'extra', 'missing', 'link', 'current', 'foreign']) {
    unset()
    const node = join(program, 'node/bin/node')
    const worker = join(program, 'lib/brain-workers/brain-search-worker.js')
    const bytes = readFileSync(worker)
    if (harm === 'mode') chmodSync(node, 0o644)
    if (harm === 'contents') writeFileSync(worker, 'Ledger')
    if (harm === 'extra') writeFileSync(join(program, 'Ledger'), 'keep')
    if (harm === 'missing') rmSync(worker)
    if (harm === 'link') {
      rmSync(worker)
      symlinkSync('brain-embedding-worker.js', worker)
    }
    if (harm === 'current') symlinkSync('../Ledger', current)
    if (harm === 'foreign') writeFileSync(bin, 'Ledger')
    const refusal = rerun(fixture, home, release)
    expect(refusal.status, harm).not.toBe(0)
    expect(existsSync(current), harm).toBe(false)
    if (harm === 'current') expect(readlinkSync(current)).toBe('../Ledger')
    if (harm === 'foreign') expect(readFileSync(bin, 'utf8')).toBe('Ledger')
    else expect(existsSync(bin), harm).toBe(false)
    expect(readFileSync(join(old, '.brain-required'), 'utf8')).toBe('1\n')
    if (harm === 'mode') chmodSync(node, 0o755)
    if (['contents', 'missing', 'link'].includes(harm)) {
      rmSync(worker, { force: true })
      writeFileSync(worker, bytes)
      chmodSync(worker, 0o755)
    }
    if (harm === 'extra') rmSync(join(program, 'Ledger'))
  }
}

/** A signed-shape qualified Brain bundle whose Node reports the packaged version. */
function qualifiedBundle() {
  const shim = `data:text/javascript,${encodeURIComponent(`Object.defineProperty(process,'version',{value:${JSON.stringify(packagedNodeVersion)}})`)}`
  return gzipSync(
    tar([
      { name: 'VERSION', text: '1.2.3\n' },
      {
        name: 'node/bin/node',
        text: `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(shim)} "$@"\n`,
      },
      { name: 'node/LICENSE', text: 'fixture' },
      { name: 'lib/phosphor.mjs', text: '' },
      { name: 'bin/phosphor', text: '#!/bin/sh\nexit 0\n' },
      ...brainPackageFixture,
    ]),
  )
}

/** Publishes `bundle` to `versions/1.2.3` exactly as `phosphor update` stages and renames it. */
function publishAsUpdater(lib: string, bundle: Buffer) {
  const stage = mkdtempSync(join(lib, '.staging-'))
  extractRelease(decompressRelease(bundle), stage)
  renameSync(stage, join(lib, 'versions/1.2.3'))
}

describe('signed Host bundle tools', { timeout: 60_000 }, () => {
  it('emits the contract protocols and signs a complete three-target manifest', () => {
    const output = join(fixture.dir, 'manifest-output')
    mkdirSync(output)
    for (const target of ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64'])
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
  it('refuses installer replacement with a pathless Brain pin and a different XDG root', () => {
    const { result, old } = install(fixture, {
      prepare(home) {
        writeFileSync(join(home, '.local/lib/phosphor-host/.brain-required'), '1\n', {
          mode: 0o600,
        })
        return { XDG_STATE_HOME: join(home, 'alternative-state') }
      },
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Brain')
    expect(readdirSync(join(old, 'versions'))).toEqual(['old'])
    expect(execFileSync('readlink', [join(old, 'current')], { encoding: 'utf8' }).trim()).toBe(
      'versions/old',
    )
  })
  it('does not repair a pinned missing launcher from an already selected ordinary version', () => {
    let release = ''
    const { result, home, old } = install(fixture, {
      prepare(_home, path) {
        release = path
        return {}
      },
    })
    expect(result.status, result.stderr).toBe(0)
    writeFileSync(join(old, '.brain-required'), '1\n', { mode: 0o600 })
    const launcher = join(home, '.local/bin/phosphor')
    rmSync(launcher)
    const repaired = rerun(fixture, home, release)
    expect(repaired.status).not.toBe(0)
    expect(repaired.stderr).toContain('qualified Host Brain bundle')
    expect(existsSync(launcher)).toBe(false)
  })
  it.skipIf(target !== 'darwin-arm64')(
    'repairs a pinned missing selection only from a signed qualified candidate or its exact installed copy',
    () => {
      const bytes = fixture.bundle
      fixture.bundle = qualifiedBundle()
      try {
        let release = ''
        const { result, old, home } = install(fixture, {
          prepare(home, path) {
            release = path
            const lib = join(home, '.local/lib/phosphor-host')
            rmSync(join(lib, 'current'))
            writeFileSync(join(lib, '.brain-required'), '1\n', { mode: 0o600 })
            return {}
          },
        })
        expect(result.status, result.stderr).toBe(0)
        expect(execFileSync('readlink', [join(old, 'current')], { encoding: 'utf8' }).trim()).toBe(
          'versions/1.2.3',
        )
        expect(readFileSync(join(old, '.brain-required'), 'utf8')).toBe('1\n')

        const current = join(old, 'current')
        const bin = join(home, '.local/bin/phosphor')
        rmSync(current)
        rmSync(bin)
        const reselection = rerun(fixture, home, release)
        expect(reselection.status, reselection.stderr).toBe(0)
        expect(readlinkSync(current)).toBe('versions/1.2.3')
        expect(readlinkSync(bin)).toBe(join(current, 'bin/phosphor'))

        assertUnsafeRepairsRefused(home, old, release)
      } finally {
        fixture.bundle = bytes
      }
    },
  )
  it.skipIf(target !== 'darwin-arm64')(
    'repairs a pinned missing selection from the same signed candidate the updater extracted',
    () => {
      const bytes = fixture.bundle
      fixture.bundle = qualifiedBundle()
      try {
        let release = ''
        const { result, old, home } = install(fixture, {
          prepare(home, path) {
            release = path
            const lib = join(home, '.local/lib/phosphor-host')
            rmSync(join(lib, 'current'))
            rmSync(join(home, '.local/bin/phosphor'))
            writeFileSync(join(lib, '.brain-required'), '1\n', { mode: 0o600 })
            publishAsUpdater(lib, fixture.bundle)
            return {}
          },
        })
        expect(result.status, result.stderr).toBe(0)
        const current = join(old, 'current')
        const bin = join(home, '.local/bin/phosphor')
        expect(readlinkSync(current)).toBe('versions/1.2.3')
        expect(readlinkSync(bin)).toBe(join(current, 'bin/phosphor'))
        // Repair reuses the updater's tree as it is: no mode is rewritten.
        const program = join(old, 'versions/1.2.3')
        expect(statSync(join(program, 'lib')).mode & 0o777).toBe(0o755)
        expect(statSync(join(program, 'VERSION')).mode & 0o777).toBe(0o644)
        expect(readFileSync(join(old, '.brain-required'), 'utf8')).toBe('1\n')

        const worker = join(program, 'lib/brain-workers/brain-search-worker.js')
        const harms: [string, () => void, () => void][] = [
          ['executable drift', () => chmodSync(worker, 0o755), () => chmodSync(worker, 0o644)],
          [
            'shell mode in an updater tree',
            () => chmodSync(worker, 0o600),
            () => chmodSync(worker, 0o644),
          ],
          [
            'writable folder',
            () => chmodSync(join(program, 'lib'), 0o775),
            () => chmodSync(join(program, 'lib'), 0o755),
          ],
          ['open version folder', () => chmodSync(program, 0o755), () => chmodSync(program, 0o700)],
        ]
        for (const [harm, apply, undo] of harms) {
          rmSync(current)
          rmSync(bin)
          apply()
          const refusal = rerun(fixture, home, release)
          expect(refusal.status, harm).not.toBe(0)
          expect(refusal.stderr, harm).toContain('qualified Host Brain bundle')
          expect(existsSync(current), harm).toBe(false)
          expect(existsSync(bin), harm).toBe(false)
          undo()
          const repaired = rerun(fixture, home, release)
          expect(repaired.status, `${harm}: ${repaired.stderr}`).toBe(0)
        }
        assertUnsafeRepairsRefused(home, old, release)
      } finally {
        fixture.bundle = bytes
      }
    },
  )
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
