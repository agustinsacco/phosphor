// Signed Host bundle suite: install, latest alias and shell PATH setup cases.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type BundleFixture,
  buildFixtureBundle,
  disposeBundleFixture,
  install,
  installPrepared,
  root,
  setupBundleFixture,
} from './__fixtures__/bundle-fixture'
let fixture: BundleFixture
beforeAll(() => {
  fixture = setupBundleFixture()
  expect(buildFixtureBundle(fixture, join(fixture.dir, 'second')).equals(fixture.bundle)).toBe(true)
}, 60000)
afterAll(() => disposeBundleFixture(fixture))

describe('signed Host bundle tools', { timeout: 60_000 }, () => {
  it('builds byte-identical bundles and installs without system Node, including latest alias', () => {
    for (const requested of ['1.2.3', '']) {
      const { result, home } = install(fixture, { requested })
      expect(result.status, result.stderr).toBe(0)
      const version = execFileSync(join(home, '.local/bin/phosphor'), ['version'], {
        encoding: 'utf8',
        env: { HOME: home, PATH: '/usr/bin:/bin' },
      })
      expect(version).toContain('1.2.3')
    }
  })
  it('calls the installed PATH helper before releasing the install lock', () => {
    const template = readFileSync(join(root, 'tools/host-release/install.sh.in'), 'utf8')
    const helper = template.indexOf('"$command" internal-install-path')
    expect(helper).toBeGreaterThan(template.indexOf('committed=1'))
    expect(helper).toBeLessThan(template.lastIndexOf('\ncleanup\n'))
  })
  it.each([false, true])('names a usable setup command when local bin is on PATH: %s', (onPath) => {
    const { result } = installPrepared(fixture, (home) => ({
      PATH: onPath ? `${home}/.local/bin:${process.env.PATH}` : '/usr/bin:/bin',
    }))
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(
      onPath ? 'Next: phosphor setup' : 'Next: ~/.local/bin/phosphor setup',
    )
    expect(result.stdout.includes('export PATH="$HOME/.local/bin:$PATH"')).toBe(!onPath)
  })
  it.each(['zsh', 'bash'])(
    'adds one guarded PATH block for %s, preserves user content and survives reruns',
    (shell) => {
      const { result, home, release } = (() => {
        let source = ''
        const installed = installPrepared(fixture, (home, release) => {
          source = release
          writeFileSync(join(home, `.${shell}rc`), '# user content\n')
          return { SHELL: `/bin/${shell}`, PATH: '/usr/bin:/bin' }
        })
        return { ...installed, release: source }
      })()
      expect(result.status, result.stderr).toBe(0)
      const file = join(home, `.${shell}rc`)
      expect(result.stdout).toContain(`Added Phosphor Host PATH to ${file}`)
      expect(readFileSync(file, 'utf8')).toContain('# user content\n')
      const again = spawnSync('sh', [fixture.script, '1.2.3'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          SHELL: `/bin/${shell}`,
          PATH: '/usr/bin:/bin',
          PHOSPHOR_HOST_RELEASE_URL: `file://${release}`,
        },
      })
      expect(again.status, again.stderr).toBe(0)
      expect(readFileSync(file, 'utf8').split('# >>> Phosphor Host PATH >>>')).toHaveLength(2)
      if (shell === 'bash' && process.platform === 'darwin')
        expect(
          readFileSync(join(home, '.profile'), 'utf8').split('# >>> Phosphor Host PATH >>>'),
        ).toHaveLength(2)
      const resolved = spawnSync('sh', ['-c', `. "$HOME/.${shell}rc"; command -v phosphor`], {
        encoding: 'utf8',
        env: { HOME: home, PATH: '/usr/bin:/bin' },
      })
      expect(resolved.stdout.trim()).toBe(join(home, '.local/bin/phosphor'))
      const twice = spawnSync(
        'sh',
        ['-c', `. "$HOME/.${shell}rc"; . "$HOME/.${shell}rc"; printf '%s' "$PATH"`],
        { encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin' } },
      )
      expect(
        twice.stdout.split(':').filter((entry) => entry === join(home, '.local/bin')),
      ).toHaveLength(1)
    },
  )
  it.each(['opt-out', 'symlink', 'directory', 'oversized', 'on-path', 'other-shell'])(
    'leaves rc unchanged for %s and prints the same-shell export when needed',
    (scenario) => {
      const { result, home } = installPrepared(fixture, (home) => {
        const rc = join(home, '.zshrc')
        if (scenario === 'symlink') {
          writeFileSync(join(home, 'target'), 'keep')
          execFileSync('ln', ['-s', 'target', rc])
        } else if (scenario === 'directory') mkdirSync(rc)
        else writeFileSync(rc, scenario === 'oversized' ? 'x'.repeat(1024 * 1024 + 1) : 'keep')
        return {
          SHELL: scenario === 'other-shell' ? '/bin/fish' : '/bin/zsh',
          PATH: scenario === 'on-path' ? `${home}/.local/bin:/usr/bin:/bin` : '/usr/bin:/bin',
          ...(scenario === 'opt-out' ? { PHOSPHOR_NO_MODIFY_PATH: '1' } : {}),
        }
      })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).not.toContain('Added Phosphor Host PATH')
      if (['symlink', 'directory', 'oversized'].includes(scenario))
        expect(result.stdout).toContain('Left unsafe shell startup file unchanged:')
      if (scenario !== 'directory')
        expect(readFileSync(join(home, '.zshrc'), 'utf8')).toBe(
          scenario === 'oversized' ? 'x'.repeat(1024 * 1024 + 1) : 'keep',
        )
      expect(result.stdout.includes('export PATH="$HOME/.local/bin:$PATH"')).toBe(
        scenario !== 'on-path',
      )
    },
  )
})
