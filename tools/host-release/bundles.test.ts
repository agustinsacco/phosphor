import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { verifyReleaseManifest } from '../../apps/host/src/update/verify'
import { HOST_PROTOCOL_VERSION } from '../../libs/shared/src/remote-host'
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'host-bundles-test-')))
const root = resolve(import.meta.dirname, '../..')
const target = `${process.platform}-${process.arch}`
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const node = (source: string, env: NodeJS.ProcessEnv = {}) =>
  execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST_RELEASE_VERSION: '1.2.3', ...env },
  })
const script = join(dir, 'install.sh')
const cache = join(dir, 'cache')
const out = join(dir, 'out')
let bundle: Buffer
let publicKey: string
let privateKey: string
beforeAll(() => {
  for (const name of ['key', 'other'])
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, name)])
  publicKey = readFileSync(join(dir, 'key.pub'), 'utf8').trim()
  privateKey = readFileSync(join(dir, 'key'), 'utf8')
  node(
    `import {generateInstaller} from './tools/host-release/installer.mjs'; generateInstaller(${JSON.stringify(script)}, ${JSON.stringify([{ id: 'test', publicKey }])})`,
  )
  const stage = join(dir, 'node-stage')
  const prefix = `node-v24.14.1-${target}`
  mkdirSync(join(stage, prefix, 'bin'), { recursive: true })
  cpSync(process.execPath, join(stage, prefix, 'bin/node'))
  writeFileSync(join(stage, prefix, 'LICENSE'), 'Test runtime license\n')
  mkdirSync(cache)
  const cached = join(cache, `${prefix}.tar.gz`)
  node(
    `import {archive} from './tools/host-release/archive.mjs'; import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(cached)},archive(${JSON.stringify(stage)}))`,
  )
  const pin = { version: '24.14.1', archives: { [target]: hash(readFileSync(cached)) } }
  const build = (folder: string) =>
    node(
      `import {buildBundle} from './tools/host-release/build-bundle.mjs'; await buildBundle(${JSON.stringify(target)},${JSON.stringify(folder)},${JSON.stringify(cache)},${JSON.stringify(pin)})`,
    )
  build(out)
  build(join(dir, 'second'))
  const file = `phosphor-host-1.2.3-${target}.tar.gz`
  bundle = readFileSync(join(out, file))
  expect(readFileSync(join(dir, 'second', file)).equals(bundle)).toBe(true)
}, 60000)
afterAll(() => rmSync(dir, { recursive: true, force: true }))
function metadata() {
  return {
    schema: 1,
    version: '1.2.3',
    protocols: [1],
    node: '24.14.1',
    sourceCommit: 'a'.repeat(40),
    artifacts: [
      {
        target,
        file: `phosphor-host-1.2.3-${target}.tar.gz`,
        bytes: bundle.length,
        sha256: hash(bundle),
      },
    ],
  }
}
function install(
  change: (manifest: ReturnType<typeof metadata>) => void = () => {},
  namespace = 'phosphor-host-release',
  key = 'key',
  flip = false,
  requested = '1.2.3',
  prepare?: (home: string, release: string) => NodeJS.ProcessEnv,
  algorithm = 'sha512',
  flags: string[] = [],
  rawManifest: (json: string) => string = (json) => json,
) {
  const release = mkdtempSync(join(dir, 'release-'))
  const home = mkdtempSync(join(dir, 'home-'))
  const temp = join(home, 'temp')
  mkdirSync(temp)
  const m = metadata()
  change(m)
  const file = join(
    release,
    requested ? 'phosphor-host-1.2.3.manifest.json' : 'phosphor-host.manifest.json',
  )
  const bytes = Buffer.from(rawManifest(JSON.stringify(m, null, 2) + '\n'))
  writeFileSync(file, bytes)
  execFileSync(
    'ssh-keygen',
    ['-Y', 'sign', '-f', join(dir, key), '-n', namespace, '-O', `hashalg=${algorithm}`, file],
    { stdio: 'pipe' },
  )
  if (flip) writeFileSync(file, Buffer.from(bytes.toString().replace('1.2.3', '1.2.4')))
  writeFileSync(join(release, `phosphor-host-1.2.3-${target}.tar.gz`), bundle)
  const old = join(home, '.local/lib/phosphor-host')
  mkdirSync(join(old, 'versions/old'), { recursive: true })
  writeFileSync(join(old, 'versions/old/marker'), 'unchanged')
  execFileSync('ln', ['-s', 'versions/old', join(old, 'current')])
  mkdirSync(join(home, '.local/bin'))
  execFileSync('ln', ['-s', join(old, 'current/bin/phosphor'), join(home, '.local/bin/phosphor')])
  const extraEnv = prepare?.(home, release) ?? {}
  const result = spawnSync('sh', [script, ...(requested ? [requested] : []), ...flags], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: temp,
      PHOSPHOR_HOST_RELEASE_URL: `file://${release}`,
      ...extraEnv,
    },
  })
  expect(result.stdout + result.stderr).not.toContain(privateKey.trim())
  expect(readdirSync(temp)).toEqual([])
  expect(readFileSync(join(old, 'versions/old/marker'), 'utf8')).toBe('unchanged')
  expect(existsSync(join(old, '.install-lock'))).toBe(extraEnv.KEEP_LOCK === '1')
  return { result, home, old }
}
function installPrepared(
  prepare: (home: string, release: string) => NodeJS.ProcessEnv,
  flags: string[] = [],
) {
  return install(undefined, undefined, undefined, undefined, undefined, prepare, undefined, flags)
}
function launcher(home: string) {
  return join(home, '.local/bin/phosphor')
}
describe('signed Host bundle tools', () => {
  it('builds byte-identical bundles and installs without system Node, including latest alias', () => {
    for (const requested of ['1.2.3', '']) {
      const { result, home } = install(undefined, undefined, undefined, undefined, requested)
      expect(result.status, result.stderr).toBe(0)
      const version = execFileSync(join(home, '.local/bin/phosphor'), ['version'], {
        encoding: 'utf8',
        env: { HOME: home, PATH: '/usr/bin:/bin' },
      })
      expect(version).toContain('1.2.3')
    }
  })
  it('is idempotent for the selected version and restores a missing launcher', () => {
    for (const missing of [false, true]) {
      const { result, home, old } = installPrepared((home) => {
        const root = join(home, '.local/lib/phosphor-host')
        mkdirSync(join(root, 'versions/1.2.3'))
        writeFileSync(join(root, 'versions/1.2.3/VERSION'), '1.2.3\n')
        writeFileSync(join(root, 'versions/1.2.3/marker'), 'keep')
        rmSync(join(root, 'current'))
        execFileSync('ln', ['-s', 'versions/1.2.3', join(root, 'current')])
        if (missing) rmSync(launcher(home))
        return {}
      })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain('already installed')
      expect(readFileSync(join(old, 'versions/1.2.3/marker'), 'utf8')).toBe('keep')
      expect(execFileSync('readlink', [launcher(home)], { encoding: 'utf8' }).trim()).toBe(
        join(old, 'current/bin/phosphor'),
      )
    }
  })
  it('never merges existing version folders or replaces a nonsymlink current', () => {
    for (const kind of ['unselected', 'bad-version', 'current-directory', 'current-file']) {
      const { result, old } = installPrepared((home) => {
        const root = join(home, '.local/lib/phosphor-host')
        mkdirSync(join(root, 'versions/1.2.3'))
        writeFileSync(join(root, 'versions/1.2.3/VERSION'), 'wrong')
        if (kind !== 'unselected') {
          rmSync(join(root, 'current'))
          if (kind === 'bad-version')
            execFileSync('ln', ['-s', 'versions/1.2.3', join(root, 'current')])
          else if (kind === 'current-directory') mkdirSync(join(root, 'current'))
          else writeFileSync(join(root, 'current'), 'keep')
        }
        return {}
      })
      expect(result.status).not.toBe(0)
      expect(readFileSync(join(old, 'versions/1.2.3/VERSION'), 'utf8')).toBe('wrong')
      if (kind === 'unselected' || kind === 'bad-version') {
        expect(result.stderr).toContain(join(old, 'versions/1.2.3'))
        expect(result.stderr).toContain('phosphor update --rollback')
      }
    }
  })
  it('refuses foreign launchers by default and backs them up only with the flag', () => {
    for (const kind of ['file', 'symlink']) {
      const prepare = (home: string) => {
        rmSync(launcher(home))
        if (kind === 'file') writeFileSync(launcher(home), 'source launcher')
        else execFileSync('ln', ['-s', '/nonexistent/foreign', launcher(home)])
        return {}
      }
      const refused = installPrepared(prepare)
      expect(refused.result.status).not.toBe(0)
      expect(refused.result.stderr).toContain('--replace-launcher')
      expect(refused.result.stderr).toContain(launcher(refused.home))
      expect(readdirSync(join(refused.old, 'versions'))).toEqual(['old'])
      const replaced = installPrepared(prepare, ['--replace-launcher'])
      expect(replaced.result.status, replaced.result.stderr).toBe(0)
      expect(replaced.result.stdout).toContain('phosphor service install')
      const backup = `${launcher(replaced.home)}.before-release`
      if (kind === 'file') expect(readFileSync(backup, 'utf8')).toBe('source launcher')
      else
        expect(execFileSync('readlink', [backup], { encoding: 'utf8' }).trim()).toBe(
          '/nonexistent/foreign',
        )
      expect(execFileSync(launcher(replaced.home), ['version'], { encoding: 'utf8' })).toContain(
        '1.2.3',
      )
    }
  })
  it('refuses a launcher directory and existing backup even with the replacement flag', () => {
    for (const kind of ['directory', 'backup-file', 'backup-symlink']) {
      const { result, home, old } = installPrepared(
        (home) => {
          rmSync(launcher(home))
          if (kind === 'directory') mkdirSync(launcher(home))
          else {
            writeFileSync(launcher(home), 'source launcher')
            if (kind === 'backup-file') writeFileSync(`${launcher(home)}.before-release`, 'keep')
            else execFileSync('ln', ['-s', '/missing', `${launcher(home)}.before-release`])
          }
          return {}
        },
        ['--replace-launcher'],
      )
      expect(result.status).not.toBe(0)
      expect(readdirSync(join(old, 'versions'))).toEqual(['old'])
      if (kind !== 'directory') expect(readFileSync(launcher(home), 'utf8')).toBe('source launcher')
    }
  })
  it('recovers a dead install lock and refuses a live owner or malformed lock', () => {
    for (const owner of ['2147483647', String(process.pid), 'invalid', '0', '']) {
      const { result, old } = installPrepared((home) => {
        const lock = join(home, '.local/lib/phosphor-host/.install-lock')
        mkdirSync(lock)
        writeFileSync(join(lock, 'pid'), `${owner}\n`)
        return { KEEP_LOCK: owner === '2147483647' ? '0' : '1' }
      })
      if (owner === '2147483647') expect(result.status, result.stderr).toBe(0)
      else {
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain(join(old, '.install-lock'))
        expect(result.stderr).toContain('no install or update is running')
        expect(readFileSync(join(old, '.install-lock/pid'), 'utf8')).toBe(`${owner}\n`)
      }
    }
  })
  it('emits the contract protocols and signs a complete three-target manifest', () => {
    const output = join(dir, 'manifest-output')
    mkdirSync(output)
    for (const target of ['linux-x64', 'linux-arm64', 'darwin-arm64'])
      writeFileSync(join(output, `phosphor-host-1.2.3-${target}.tar.gz`), 'test artifact')
    node(
      `import {makeManifest} from './tools/host-release/manifest.mjs'; makeManifest(${JSON.stringify(output)})`,
      { HOST_RELEASE_SIGNING_KEY: privateKey },
    )
    const path = join(output, 'phosphor-host-1.2.3.manifest.json')
    const manifest = verifyReleaseManifest(
      readFileSync(path),
      readFileSync(`${path}.sig`, 'utf8'),
      [{ id: 'test', publicKey }],
    )
    expect(manifest.protocols).toEqual([HOST_PROTOCOL_VERSION])
    expect(manifest.artifacts).toHaveLength(3)
    for (const name of readdirSync(output))
      expect(readFileSync(join(output, name)).includes(Buffer.from(privateKey))).toBe(false)
  })
  it('keeps the checked-in installer generated from the pinned key source', () => {
    const generated = join(dir, 'generated-install.sh')
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
        `import {nodeArchive} from './tools/host-release/build-bundle.mjs'; await nodeArchive(${JSON.stringify(target)},${JSON.stringify(cache)})`,
      ),
    ).toThrow(/Node archive hash mismatch/)
  })
  it('refuses changed manifest, wrong namespace, other key, artifact hash and size without changing existing install', () => {
    const cases = [
      () => install(undefined, undefined, undefined, true),
      () => install(undefined, 'wrong'),
      () => install(undefined, undefined, 'other'),
      () => install(undefined, undefined, undefined, undefined, undefined, undefined, 'sha256'),
      () =>
        install((m) => {
          const a = m.artifacts[0]
          if (a) a.sha256 = '0'.repeat(64)
        }),
      () =>
        install((m) => {
          const a = m.artifacts[0]
          if (a) a.bytes--
        }),
      () =>
        install((m) => {
          const a = m.artifacts[0]
          if (a) a.bytes++
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
      const { result } = install((m) => {
        m.version = version
      })
      expect(result.status).not.toBe(0)
    }
    const { result } = install((m) => {
      const a = m.artifacts[0]
      if (a) a.file = '../escape'
    })
    expect(result.status).not.toBe(0)
  })
  it('rejects signed malformed shapes, duplicate targets, unknown fields and limits', () => {
    const changes = [
      (m: ReturnType<typeof metadata>) => {
        Reflect.set(m, 'schema', '1')
      },
      (m: ReturnType<typeof metadata>) => {
        Reflect.set(m, 'extra', true)
      },
      (m: ReturnType<typeof metadata>) => {
        Reflect.set(m, 'protocols', ['1'])
      },
      (m: ReturnType<typeof metadata>) => {
        m.protocols = []
      },
      (m: ReturnType<typeof metadata>) => {
        m.protocols = [1, 1]
      },
      (m: ReturnType<typeof metadata>) => {
        m.protocols = [65536]
      },
      (m: ReturnType<typeof metadata>) => {
        m.artifacts.push(...m.artifacts)
      },
      (m: ReturnType<typeof metadata>) => {
        const a = m.artifacts[0]
        if (a) a.bytes = 268435457
      },
    ]
    for (const change of changes) expect(install(change).result.status).not.toBe(0)
  })
  it('rejects signed JSON with quoted array delimiters', () => {
    for (const change of [
      (json: string) => json.replace('2\n  ]', '2\n  "]"'),
      (json: string) => json.replace('}\n  ]', '}\n  "]"'),
      (json: string) => json.replace('1,\n    2', '1 ","\n    2'),
    ]) {
      const { result } = install(
        (m) => {
          m.protocols = [1, 2]
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        [],
        change,
      )
      expect(result.status).not.toBe(0)
    }
  })
  it('refuses signed archive traversal and symlinks before extracting anything', () => {
    const original = bundle
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
        bundle = gzipSync(tar)
        const { result, old, home } = install(
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          (home) => {
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
        )
        expect(result.status).not.toBe(0)
        expect(existsSync(join(home, 'extracted'))).toBe(false)
        expect(readdirSync(join(old, 'versions'))).toEqual(['old'])
      }
    } finally {
      bundle = original
    }
  })
  it('refuses directory symlinks outside its allowed install tree', () => {
    const { result, home } = install(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (home) => {
        const outside = join(home, 'outside')
        mkdirSync(outside)
        rmSync(join(home, '.local/bin'), { recursive: true })
        execFileSync('ln', ['-s', outside, join(home, '.local/bin')])
        return {}
      },
    )
    expect(result.status).not.toBe(0)
    expect(readdirSync(join(home, 'outside'))).toEqual([])
  })
  it('rolls back the launcher and version when current publication fails', () => {
    const { result, home, old } = install(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (home) => {
        const commands = join(home, 'commands')
        mkdirSync(commands)
        const realMv = execFileSync('sh', ['-c', 'command -v mv'], { encoding: 'utf8' }).trim()
        writeFileSync(
          join(commands, 'mv'),
          `#!/bin/sh\ncase "$*" in *'/current '*) exit 1 ;; esac\nexec ${realMv} "$@"\n`,
          { mode: 0o755 },
        )
        return { PATH: `${commands}:${process.env.PATH}` }
      },
    )
    expect(result.status).not.toBe(0)
    expect(readdirSync(join(old, 'versions'))).toEqual(['old'])
    expect(
      execFileSync('readlink', [join(home, '.local/bin/phosphor')], { encoding: 'utf8' }).trim(),
    ).toBe(join(old, 'current/bin/phosphor'))
    expect(execFileSync('readlink', [join(old, 'current')], { encoding: 'utf8' }).trim()).toBe(
      'versions/old',
    )
    expect(readdirSync(old).sort()).toEqual(['current', 'versions'])
  })
  it('restores a foreign launcher or missing launcher when current publication fails', () => {
    for (const foreign of [true, false]) {
      const { result, home, old } = installPrepared(
        (home) => {
          rmSync(launcher(home))
          if (foreign) writeFileSync(launcher(home), 'source launcher')
          const commands = join(home, 'commands')
          mkdirSync(commands)
          const realMv = execFileSync('sh', ['-c', 'command -v mv'], { encoding: 'utf8' }).trim()
          writeFileSync(
            join(commands, 'mv'),
            `#!/bin/sh\ncase "$*" in *'/current '*) exit 1 ;; esac\nexec ${realMv} "$@"\n`,
            { mode: 0o755 },
          )
          return { PATH: `${commands}:${process.env.PATH}` }
        },
        foreign ? ['--replace-launcher'] : [],
      )
      expect(result.status).not.toBe(0)
      if (foreign) expect(readFileSync(launcher(home), 'utf8')).toBe('source launcher')
      else expect(existsSync(launcher(home))).toBe(false)
      expect(existsSync(`${launcher(home)}.before-release`)).toBe(false)
      expect(readdirSync(old).sort()).toEqual(['current', 'versions'])
      expect(readdirSync(join(old, 'versions'))).toEqual(['old'])
    }
  })
  it('cleans up its owned install lock on HUP, INT and TERM', () => {
    for (const [signal, code] of [
      ['HUP', 129],
      ['INT', 130],
      ['TERM', 143],
    ] as const) {
      const { result, old } = installPrepared((home) => {
        const commands = join(home, 'commands')
        mkdirSync(commands)
        const realMktemp = execFileSync('sh', ['-c', 'command -v mktemp'], {
          encoding: 'utf8',
        }).trim()
        writeFileSync(
          join(commands, 'mktemp'),
          `#!/bin/sh\ncase "$*" in *'/phosphor-host/.install.'*) kill -${signal} "$PPID"; exit 1 ;; esac\nexec ${realMktemp} "$@"\n`,
          { mode: 0o755 },
        )
        return { PATH: `${commands}:${process.env.PATH}` }
      })
      expect(result.status, result.stderr).toBe(code)
      expect(readdirSync(old).sort()).toEqual(['current', 'versions'])
    }
  })
  it('cleans up its environment-only signing key on success and failure', () => {
    const temp = join(dir, 'sign-tmp')
    mkdirSync(temp)
    const env = { HOST_RELEASE_SIGNING_KEY: privateKey, TMPDIR: temp }
    const output = node(
      `import {signManifest} from './tools/host-release/manifest.mjs'; signManifest(Buffer.from('test'))`,
      env,
    )
    expect(output).not.toContain(privateKey.trim())
    expect(readdirSync(temp)).toEqual([])
    expect(() =>
      node(
        `import {signManifest} from './tools/host-release/manifest.mjs'; signManifest(Buffer.from('test'))`,
        { ...env, HOST_RELEASE_SIGNING_KEY: 'invalid-test-key' },
      ),
    ).toThrow(/Release signing failed/)
    expect(readdirSync(temp)).toEqual([])
  })
  it.runIf(process.env.PHOSPHOR_HOST_RELEASE_NETWORK === '1')(
    'checks the official pinned archive on this platform',
    async () => {
      const real = join(dir, 'official')
      node(
        `import {buildBundle} from './tools/host-release/build-bundle.mjs'; await buildBundle(${JSON.stringify(target)},${JSON.stringify(real)})`,
      )
      const second = join(dir, 'official-second')
      node(
        `import {buildBundle} from './tools/host-release/build-bundle.mjs'; await buildBundle(${JSON.stringify(target)},${JSON.stringify(second)},${JSON.stringify(join(real, '.node-cache'))})`,
      )
      const file = `phosphor-host-1.2.3-${target}.tar.gz`
      const official = readFileSync(join(real, file))
      expect(readFileSync(join(second, file)).equals(official)).toBe(true)
      const fake = bundle
      try {
        bundle = official
        const { result, home } = install()
        expect(result.status, result.stderr).toBe(0)
        expect(
          execFileSync(join(home, '.local/bin/phosphor'), ['version'], {
            encoding: 'utf8',
            env: { HOME: home, PATH: '/usr/bin:/bin' },
          }),
        ).toContain('1.2.3')
      } finally {
        bundle = fake
      }
    },
    180000,
  )
})
