// Signed Host bundle suite: reproducibility, entry points, docs, publication and cleanup.
// Sibling facets: bundles.setup, bundles.runtime, bundles.locks and bundles.security.
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HOST_RELEASE_BASE_URL } from '../../apps/host/src/update/download'
import {
  type BundleFixture,
  disposeBundleFixture,
  hash,
  install,
  installPrepared,
  launcher,
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
const withoutPublicReleaseUrl = (text: string) => text.replaceAll(HOST_RELEASE_BASE_URL, '')

describe('signed Host bundle tools', { timeout: 60_000 }, () => {
  it('keeps release bundles independent of TMPDIR and untracked machine files', () => {
    const probe = `phosphor-untracked-probe-${process.pid}.txt`
    expect(spawnSync('git', ['check-ignore', '-q', probe], { cwd: root }).status).toBe(1)
    const commands = join(fixture.dir, 'build-commands')
    mkdirSync(commands)
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
    // Ignore this working patch, but preserve real git handling of the one probe.
    writeFileSync(
      join(commands, 'git'),
      `#!/bin/sh
real='${realGit}'
[ "$1" = status ] || exec "$real" "$@"
status=$("$real" "$@") || exit "$?"
printf '%s\\n' "$status" | grep -F -x '?? ${probe}' || :
`,
      { mode: 0o755 },
    )
    const build = (name: string, shim: boolean) => {
      const temp = join(fixture.dir, `${name}-temp`)
      mkdirSync(temp)
      const output = join(fixture.dir, name)
      node(
        `import {buildBundle} from './tools/host-release/build-bundle.mjs'; await buildBundle(${JSON.stringify(target)},${JSON.stringify(output)},${JSON.stringify(fixture.cache)},${JSON.stringify({ version: '24.14.1', archives: { [target]: hash(readFileSync(join(fixture.cache, `node-v24.14.1-${target}.tar.gz`))) } })})`,
        {
          TMPDIR: temp,
          ...(shim ? { PATH: `${commands}:${process.env.PATH}` } : {}),
        },
      )
      return readFileSync(join(output, `phosphor-host-1.2.3-${target}.tar.gz`))
    }
    const clean = build('probe-before', true)
    try {
      writeFileSync(join(root, probe), 'Untracked machine data')
      expect(build('probe-after', true).equals(clean)).toBe(true)
    } finally {
      rmSync(join(root, probe), { force: true })
    }
    expect(build('real-other-temp', false).equals(fixture.bundle)).toBe(true)
  })
  it('carries no machine paths, source maps or sourceMappingURL in release text', () => {
    const user = userInfo().username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const userSegment = new RegExp(`[/\\\\]${user}(?![A-Za-z0-9_.-])`)
    const buildTemps = [tmpdir(), realpathSync(tmpdir())].flatMap((temp) =>
      ['phosphor-bundle-', 'phosphor-sign-'].map((prefix) => join(temp, prefix)),
    )
    const unpacked = join(fixture.dir, 'scan')
    mkdirSync(unpacked)
    execFileSync('tar', [
      '-xzf',
      join(fixture.out, `phosphor-host-1.2.3-${target}.tar.gz`),
      '-C',
      unpacked,
    ])
    expect(readFileSync(join(unpacked, 'lib/phosphor.mjs'), 'utf8')).toContain(
      HOST_RELEASE_BASE_URL,
    )
    for (const file of readdirSync(unpacked, { recursive: true, encoding: 'utf8' })) {
      if (!lstatSync(join(unpacked, file)).isFile()) continue
      expect(file).not.toMatch(/\.map$/)
      const text = readFileSync(join(unpacked, file)).toString('utf8')
      if (text.includes('\0')) continue // Node is the only binary in the bundle.
      // `/tmp` alone is also prose; forbid the build's own temp folders instead.
      for (const forbidden of [root, fixture.dir, homedir(), ...buildTemps, 'sourceMappingURL'])
        expect(text, `${file} contains ${forbidden}`).not.toContain(forbidden)
      // A user name is also a word (CI's is `runner`); forbid it only as a path segment.
      expect(
        withoutPublicReleaseUrl(text),
        `${file} contains a path through the user name`,
      ).not.toMatch(userSegment)
    }
  })
  it('excludes only the exact public URL, never private username paths alongside it', () => {
    expect(withoutPublicReleaseUrl(HOST_RELEASE_BASE_URL)).toBe('')
    const user = userInfo().username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const segment = new RegExp(`[/\\\\]${user}(?![A-Za-z0-9_.-])`)
    for (const path of [`/Users/${userInfo().username}/x`, `/home/${userInfo().username}/x`]) {
      const scanned = withoutPublicReleaseUrl(`${HOST_RELEASE_BASE_URL} ${path}`)
      expect(scanned).not.toContain(HOST_RELEASE_BASE_URL)
      expect(scanned).toContain(path)
      expect(scanned).toMatch(segment)
    }
  })
  it('recognizes both CLI entry points through paths containing spaces and percent signs', () => {
    const path = join(fixture.dir, 'entry % space')
    mkdirSync(path)
    execFileSync('ln', [
      '-s',
      join(root, 'tools/host-release/build-bundle.mjs'),
      join(path, 'build.mjs'),
    ])
    execFileSync('ln', [
      '-s',
      join(root, 'tools/host-release/manifest.mjs'),
      join(path, 'manifest.mjs'),
    ])
    for (const name of ['build', 'manifest']) {
      const entry = join(path, `${name}.mjs`)
      const result = spawnSync(process.execPath, [entry, '--unknown'], { encoding: 'utf8' })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('Unknown option')
      expect(
        node(
          `import {isEntryPoint} from './tools/host-release/common.mjs'; process.argv[1]=${JSON.stringify(entry)}; console.log(isEntryPoint(${JSON.stringify(pathToFileURL(entry).href)}))`,
        ).trim(),
      ).toBe('true')
    }
  })
  it('documents the implemented lock, updater and the manual Host Release workflow', () => {
    const docs = readFileSync(join(root, 'docs/host.md'), 'utf8')
    for (const rule of [
      'Any updater must',
      'recovery/',
      '.install-lock.retired.<own-pid>',
      'Retire the whole',
      'missing or malformed pid',
      'no program deletes the',
      'SIGKILL or power loss can leave a',
      'The manual **Host Release** workflow',
      'refuses to build while `HOST_RELEASE_KEYS` is',
      '## Updating',
      '## Uninstalling',
      '`phosphor update`',
      '--check',
      '--rollback',
      '`phosphor uninstall`',
    ])
      expect(docs).toContain(rule)
    expect(docs.replace(/\s+/g, ' ')).toContain(
      'SIGKILL or power loss can leave a pid-less lock or an abandoned `.install-lock/recovery` gate. Both require manual removal after confirming no installer or updater is running; the refusal message names `.install-lock`.',
    )
    expect(docs).not.toContain('signals are\nignored')
    expect(docs).not.toContain('The release workflow publishes')
  })
  it('is idempotent for the selected version and restores a missing launcher', () => {
    for (const missing of [false, true]) {
      const { result, home, old } = installPrepared(fixture, (home) => {
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
      const { result, old } = installPrepared(fixture, (home) => {
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
      const refused = installPrepared(fixture, prepare)
      expect(refused.result.status).not.toBe(0)
      expect(refused.result.stderr).toContain('--replace-launcher')
      expect(refused.result.stderr).toContain(launcher(refused.home))
      expect(readdirSync(join(refused.old, 'versions'))).toEqual(['old'])
      const replaced = installPrepared(fixture, prepare, ['--replace-launcher'])
      expect(replaced.result.status, replaced.result.stderr).toBe(0)
      expect(replaced.result.stdout).toContain('phosphor setup')
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
        fixture,
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
  it('rolls back the launcher and version when current publication fails', () => {
    const { result, home, old } = install(fixture, {
      prepare: (home) => {
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
    })
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
        fixture,
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
      const { result, old } = installPrepared(fixture, (home) => {
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
  it.runIf(process.env.PHOSPHOR_HOST_RELEASE_NETWORK === '1')(
    'checks the official pinned archive on this platform',
    async () => {
      const real = join(fixture.dir, 'official')
      node(
        `import {buildBundle} from './tools/host-release/build-bundle.mjs'; await buildBundle(${JSON.stringify(target)},${JSON.stringify(real)})`,
      )
      const second = join(fixture.dir, 'official-second')
      node(
        `import {buildBundle} from './tools/host-release/build-bundle.mjs'; await buildBundle(${JSON.stringify(target)},${JSON.stringify(second)},${JSON.stringify(join(real, '.node-cache'))})`,
      )
      const file = `phosphor-host-1.2.3-${target}.tar.gz`
      const official = readFileSync(join(real, file))
      expect(readFileSync(join(second, file)).equals(official)).toBe(true)
      const fake = fixture.bundle
      try {
        fixture.bundle = official
        const { result, home } = install(fixture)
        expect(result.status, result.stderr).toBe(0)
        expect(
          execFileSync(join(home, '.local/bin/phosphor'), ['version'], {
            encoding: 'utf8',
            env: { HOME: home, PATH: '/usr/bin:/bin' },
          }),
        ).toContain('1.2.3')
      } finally {
        fixture.bundle = fake
      }
    },
    180000,
  )
})
