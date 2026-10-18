// Signed Host bundle suite: install lock reclamation, signal and rollback races.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type BundleFixture,
  disposeBundleFixture,
  hook,
  installPrepared,
  launcher,
  rerun,
  setupBundleFixture,
} from './__fixtures__/bundle-fixture'
let fixture: BundleFixture
beforeAll(() => {
  fixture = setupBundleFixture()
}, 60000)
afterAll(() => disposeBundleFixture(fixture))

describe('signed Host bundle tools', { timeout: 60_000 }, () => {
  it('recovers a dead install lock and refuses a live owner or malformed lock', () => {
    for (const owner of ['2147483647', String(process.pid), 'invalid', '0', '']) {
      const { result, old } = installPrepared(fixture, (home) => {
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
  it('defers HUP, INT and TERM during acquisition, reclamation and publication', () => {
    for (const [signal, code] of [
      ['HUP', 129],
      ['INT', 130],
      ['TERM', 143],
    ] as const) {
      for (const phase of ['acquire', 'gate', 'retire', 'publish']) {
        const { result, old, home } = installPrepared(
          fixture,
          (home) => {
            const root = join(home, '.local/lib/phosphor-host')
            if (phase === 'gate' || phase === 'retire') {
              mkdirSync(join(root, '.install-lock'))
              writeFileSync(join(root, '.install-lock/pid'), '2147483647\n')
            }
            if (phase === 'publish') {
              rmSync(launcher(home))
              writeFileSync(launcher(home), 'source launcher')
            }
            const command = phase === 'acquire' || phase === 'gate' ? 'mkdir' : 'mv'
            const pattern = {
              acquire: '*"/.install-lock"',
              gate: '*"/.install-lock/recovery"',
              retire: '*"/.install-lock "*',
              publish: '*"/version "*',
            }[phase]
            const body = `case "$*" in ${pattern}) "$real" "$@" || exit "$?"; kill -${signal} "$PPID"; exit 0 ;; esac`
            return { PATH: hook(home, command, body) }
          },
          phase === 'publish' ? ['--replace-launcher'] : [],
        )
        expect(result.status, `${phase}: ${result.stderr}`).toBe(code)
        expect(result.stdout).not.toContain('Installed')
        expect(result.stdout).not.toContain('Next:')
        expect(readdirSync(old).sort()).toEqual(['current', 'versions'])
        if (phase === 'publish') {
          expect(
            execFileSync('readlink', [join(old, 'current')], { encoding: 'utf8' }).trim(),
          ).toBe('versions/1.2.3')
          expect(execFileSync(launcher(home), ['version'], { encoding: 'utf8' })).toContain('1.2.3')
          expect(readFileSync(`${launcher(home)}.before-release`, 'utf8')).toBe('source launcher')
        } else expect(readdirSync(join(old, 'versions'))).toEqual(['old'])
      }
    }
  })
  it('honors HUP, INT and TERM during owned-lock cleanup before printing success', () => {
    for (const [signal, code] of [
      ['HUP', 129],
      ['INT', 130],
      ['TERM', 143],
    ] as const) {
      const { result, old, home } = installPrepared(
        fixture,
        (home) => {
          rmSync(launcher(home))
          writeFileSync(launcher(home), 'source launcher')
          return {
            PATH: hook(
              home,
              'mv',
              `case "$*" in *"/.install-lock "*) "$real" "$@" || exit "$?"; kill -${signal} "$PPID"; exit 0 ;; esac`,
            ),
          }
        },
        ['--replace-launcher'],
      )
      expect(result.status, result.stderr).toBe(code)
      expect(execFileSync('readlink', [join(old, 'current')], { encoding: 'utf8' }).trim()).toBe(
        'versions/1.2.3',
      )
      expect(execFileSync(launcher(home), ['version'], { encoding: 'utf8' })).toContain('1.2.3')
      expect(readFileSync(`${launcher(home)}.before-release`, 'utf8')).toBe('source launcher')
      expect(readdirSync(old).sort()).toEqual(['current', 'versions'])
      expect(result.stdout).toBe('')
    }
  })
  it('honors TERM during cleanup of a failed publication and preserves the old install', () => {
    const { result, old, home } = installPrepared(
      fixture,
      (home) => {
        rmSync(launcher(home))
        writeFileSync(launcher(home), 'source launcher')
        return {
          PATH: hook(
            home,
            'mv',
            `case "$*" in
  *"/.install-lock "*) "$real" "$@" || exit "$?"; kill -TERM "$PPID"; exit 0 ;;
  *"/current "*) exit 1 ;;
esac`,
          ),
        }
      },
      ['--replace-launcher'],
    )
    expect(result.status, result.stderr).toBe(143)
    expect(execFileSync('readlink', [join(old, 'current')], { encoding: 'utf8' }).trim()).toBe(
      'versions/old',
    )
    expect(readFileSync(launcher(home), 'utf8')).toBe('source launcher')
    expect(existsSync(`${launcher(home)}.before-release`)).toBe(false)
    expect(readdirSync(join(old, 'versions'))).toEqual(['old'])
    expect(readdirSync(old).sort()).toEqual(['current', 'versions'])
    expect(result.stdout).toBe('')
  })
  it('rolls back from filesystem state when a signaled publication rename returns failure after moving', () => {
    for (const [phase, signal, code] of [
      ['version', 'TERM', 143],
      ['backup', 'TERM', 143],
      ['launcher', 'TERM', 143],
      ['current', 'TERM', 143],
      ['current', 'HUP', 129],
      ['current', 'INT', 130],
    ] as const) {
      const { result, home, old } = installPrepared(
        fixture,
        (home) => {
          rmSync(launcher(home))
          writeFileSync(launcher(home), 'source launcher')
          const pattern = {
            version: '*"/version "*',
            backup: '*"/bin/phosphor "*"/phosphor.before-release"',
            launcher: '*"/phosphor "*"/bin/phosphor"',
            current: '*"/current "*',
          }[phase]
          return {
            PATH: hook(
              home,
              'mv',
              `case "$*" in ${pattern}) "$real" "$@" || exit "$?"; kill -${signal} "$PPID"; exit 1 ;; esac`,
            ),
          }
        },
        ['--replace-launcher'],
      )
      expect(result.status, `${phase}: ${result.stderr}`).toBe(code)
      expect(execFileSync('readlink', [join(old, 'current')], { encoding: 'utf8' }).trim()).toBe(
        'versions/old',
      )
      expect(readFileSync(launcher(home), 'utf8')).toBe('source launcher')
      expect(existsSync(`${launcher(home)}.before-release`)).toBe(false)
      expect(readdirSync(join(old, 'versions'))).toEqual(['old'])
      expect(readdirSync(old).sort()).toEqual(['current', 'versions'])
      expect(result.stdout).not.toContain('Next:')
    }
  })
  it('trusts the filesystem when a signal interrupts launcher removal during rollback', () => {
    const { result, old, home } = installPrepared(fixture, (home) => {
      rmSync(launcher(home))
      hook(home, 'mv', `case "$*" in *"/current "*) exit 1 ;; esac`)
      return {
        PATH: hook(
          home,
          'rm',
          `case "$*" in *"/.local/bin/phosphor") "$real" "$@"; kill -TERM "$PPID"; exit 0 ;; esac`,
        ),
      }
    })
    expect(result.status, result.stderr).toBe(143)
    expect(result.stderr).not.toContain('may have completed')
    expect(execFileSync('readlink', [join(old, 'current')], { encoding: 'utf8' }).trim()).toBe(
      'versions/old',
    )
    expect(readdirSync(join(old, 'versions'))).toEqual(['old'])
    expect(existsSync(launcher(home))).toBe(false)
    expect(result.stdout).toBe('')
  })
  it('never deletes the selected version when a selection read fails during cleanup', () => {
    const { result, old } = installPrepared(fixture, (home) => {
      hook(
        home,
        'mv',
        `case "$*" in *"/current "*) "$real" "$@" || exit "$?"; : > '${home}/moved'; exit 1 ;; esac`,
      )
      return {
        PATH: hook(
          home,
          'readlink',
          `if [ -e '${home}/moved' ] && [ ! -e '${home}/read' ]; then : > '${home}/read'; exit 1; fi`,
        ),
      }
    })
    expect(result.status, result.stderr).toBe(1)
    expect(execFileSync('readlink', [join(old, 'current')], { encoding: 'utf8' }).trim()).toBe(
      'versions/1.2.3',
    )
    expect(readdirSync(join(old, 'versions')).sort()).toEqual(['1.2.3', 'old'])
    expect(existsSync(join(old, 'versions/1.2.3/VERSION'))).toBe(true)
  })
  it('protects lock mkdir and retirement from a signal sent to both parent and child', () => {
    for (const phase of ['acquire', 'retire']) {
      let release = ''
      const { result, old, home } = installPrepared(fixture, (home, folder) => {
        release = folder
        if (phase === 'retire') {
          const lock = join(home, '.local/lib/phosphor-host/.install-lock')
          mkdirSync(lock)
          writeFileSync(join(lock, 'pid'), '2147483647\n')
        }
        const pattern = phase === 'acquire' ? '*"/.install-lock"' : '*"/.install-lock "*'
        return {
          PATH: hook(
            home,
            phase === 'acquire' ? 'mkdir' : 'mv',
            `case "$*" in ${pattern}) "$real" "$@" || exit "$?"; kill -INT "$PPID"; kill -INT "$$"; exit 0 ;; esac`,
          ),
        }
      })
      expect(result.status, `${phase}: ${result.stderr}`).toBe(130)
      expect(readdirSync(old).sort()).toEqual(['current', 'versions'])
      expect(readdirSync(join(old, 'versions'))).toEqual(['old'])
      expect(execFileSync('readlink', [join(old, 'current')], { encoding: 'utf8' }).trim()).toBe(
        'versions/old',
      )
      const next = rerun(fixture, home, release)
      expect(next.status, next.stderr).toBe(0)
      expect(readdirSync(old).sort()).toEqual(['current', 'versions'])
    }
  })
  it('protects publication mv from a signal sent to both parent and child', () => {
    const { result, old, home } = installPrepared(fixture, (home) => ({
      PATH: hook(
        home,
        'mv',
        `case "$*" in *"/current "*) "$real" "$@" || exit "$?"; kill -INT "$PPID"; kill -INT "$$"; exit 0 ;; esac`,
      ),
    }))
    expect(result.status, result.stderr).toBe(130)
    expect(execFileSync('readlink', [join(old, 'current')], { encoding: 'utf8' }).trim()).toBe(
      'versions/1.2.3',
    )
    expect(execFileSync(launcher(home), ['version'], { encoding: 'utf8' })).toContain('1.2.3')
    expect(readdirSync(old).sort()).toEqual(['current', 'versions'])
    expect(result.stdout).not.toContain('Next:')
  })
  it('retains complete bundles and the backup if restoration or roll-forward fails', () => {
    for (const failure of ['launcher', 'current', 'forward']) {
      const { result, old, home } = installPrepared(
        fixture,
        (home) => {
          rmSync(launcher(home))
          writeFileSync(launcher(home), 'source launcher')
          return {
            PATH: hook(
              home,
              'mv',
              `case "$*" in
  *"/restore-current "*) [ '${failure}' != current ] || exit 1 ;;
  *"/phosphor.before-release "*"/bin/phosphor") [ '${failure}' = current ] || exit 1 ;;
  *"/forward-current "*) [ '${failure}' != forward ] || exit 1 ;;
  *"/current "*) "$real" "$@" || exit "$?"; kill -TERM "$PPID"; exit 1 ;;
esac`,
            ),
          }
        },
        ['--replace-launcher'],
      )
      expect(result.status, result.stderr).toBe(143)
      expect(result.stderr).toContain('may have completed; rerunning the installer is safe')
      expect(readFileSync(`${launcher(home)}.before-release`, 'utf8')).toBe('source launcher')
      expect(execFileSync('readlink', [launcher(home)], { encoding: 'utf8' }).trim()).toBe(
        join(old, 'current/bin/phosphor'),
      )
      expect(
        existsSync(join(old, 'current/marker')) ||
          existsSync(join(old, 'current/lib/phosphor.mjs')),
      ).toBe(true)
      expect(existsSync(join(old, 'versions/1.2.3/lib/phosphor.mjs'))).toBe(true)
      if (failure !== 'forward')
        expect(execFileSync(launcher(home), ['version'], { encoding: 'utf8' })).toContain('1.2.3')
      expect(readdirSync(old).sort()).toEqual(['current', 'versions'])
    }
  })
  it('releases a held recovery gate on a signaled failure so the next installer can reclaim', () => {
    for (const [signal, code] of [
      ['HUP', 129],
      ['INT', 130],
      ['TERM', 143],
    ] as const) {
      let release = ''
      const { result, home, old } = installPrepared(fixture, (home, folder) => {
        release = folder
        const lock = join(home, '.local/lib/phosphor-host/.install-lock')
        mkdirSync(lock)
        writeFileSync(join(lock, 'pid'), '2147483647\n')
        return {
          KEEP_LOCK: '1',
          PATH: hook(
            home,
            'mv',
            `case "$*" in *"/.install-lock "*) kill -${signal} "$PPID"; exit 1 ;; esac`,
          ),
        }
      })
      expect(result.status, result.stderr).toBe(code)
      expect(readdirSync(join(old, '.install-lock'))).toEqual(['pid'])
      expect(readdirSync(old).sort()).toEqual(['.install-lock', 'current', 'versions'])
      expect(rerun(fixture, home, release).status).toBe(0)
      expect(readdirSync(old).sort()).toEqual(['current', 'versions'])
    }
  })
  it('sweeps only dead exact non-symlink retired folders, at most sixteen per acquisition', () => {
    const { result, old, home } = installPrepared(fixture, (home) => {
      const root = join(home, '.local/lib/phosphor-host')
      for (let i = 0; i < 17; i++) {
        const retired = join(root, `.install-lock.retired.${2147483600 + i}`)
        mkdirSync(join(retired, 'recovery'), { recursive: true })
        writeFileSync(join(retired, 'pid'), '2147483647\n')
      }
      mkdirSync(join(root, `.install-lock.retired.${process.pid}`))
      mkdirSync(join(root, '.install-lock.retired.2147483647.extra'))
      mkdirSync(join(home, 'outside'))
      writeFileSync(join(home, 'outside/pid'), 'keep')
      execFileSync('ln', [
        '-s',
        join(home, 'outside'),
        join(root, '.install-lock.retired.2147483647'),
      ])
      return {}
    })
    expect(result.status, result.stderr).toBe(0)
    const candidates = [
      `.install-lock.retired.${process.pid}`,
      ...Array.from({ length: 17 }, (_, i) => `.install-lock.retired.${2147483600 + i}`),
    ]
      .sort()
      .slice(0, 16)
    for (let i = 0; i < 17; i++) {
      const name = `.install-lock.retired.${2147483600 + i}`
      expect(existsSync(join(old, name)), name).toBe(!candidates.includes(name))
    }
    expect(existsSync(join(old, `.install-lock.retired.${process.pid}`))).toBe(true)
    expect(existsSync(join(old, '.install-lock.retired.2147483647.extra'))).toBe(true)
    expect(readFileSync(join(home, 'outside/pid'), 'utf8')).toBe('keep')
  })
  it('leaves non-exact retired names byte-for-byte untouched without counting them toward the sweep', () => {
    const names = [
      'extra.2147483647',
      'keep.2147483647',
      '0123',
      ...Array.from({ length: 16 }, (_, i) => `0${2147483600 + i}`),
      '',
      '21474836470',
    ]
    const contents = Buffer.from('retired pid contents\n\0unchanged')
    const { result, old } = installPrepared(fixture, (home) => {
      const root = join(home, '.local/lib/phosphor-host')
      for (const suffix of [...names, '2147483647']) {
        const retired = join(root, `.install-lock.retired.${suffix}`)
        mkdirSync(join(retired, 'recovery'), { recursive: true })
        writeFileSync(join(retired, 'pid'), contents)
      }
      return {}
    })
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(old, '.install-lock.retired.2147483647'))).toBe(false)
    for (const suffix of names) {
      const retired = join(old, `.install-lock.retired.${suffix}`)
      expect(readdirSync(retired).sort()).toEqual(['pid', 'recovery'])
      expect(readFileSync(join(retired, 'pid')).equals(contents)).toBe(true)
      expect(readdirSync(join(retired, 'recovery'))).toEqual([])
    }
  })
  it('does not strand a lock when two reclaimers read the same dead pid before retirement', () => {
    let release = ''
    const wait = `await_file() { i=0; while [ ! -e "$1" ]; do i=$((i+1)); [ "$i" -le 1000 ] || exit 91; sleep 0.01; done; }`
    const { result, home, old } = installPrepared(fixture, (home, folder) => {
      release = folder
      const lock = join(home, '.local/lib/phosphor-host/.install-lock')
      mkdirSync(lock)
      writeFileSync(join(lock, 'pid'), '2147483647\n')
      hook(
        home,
        'mkdir',
        `${wait}
case "$*" in *"/.install-lock/recovery")
  if [ "\${RACER:-A}" = B ]; then
    touch "$HOME/b-ready"; await_file "$HOME/retired"
    "$real" "$@"; code=$?
    touch "$HOME/b-gate"
    [ "$code" != 0 ] || await_file "$HOME/a-rmdir"
    exit "$code"
  fi
  (RACER=B sh '${fixture.script}' 1.2.3 > "$HOME/b-output" 2> "$HOME/b-error"; echo "$?" > "$HOME/b-status") &
  await_file "$HOME/b-ready"
;; esac`,
      )
      hook(
        home,
        'mv',
        `${wait}
case "$*" in *"/.install-lock "*)
  "$real" "$@" || exit "$?"
  touch "$HOME/retired"; await_file "$HOME/b-gate"; exit 0
;; esac`,
      )
      const path = hook(
        home,
        'rmdir',
        `${wait}
case "$*" in
  *"/.install-lock/recovery") "$real" "$@" || exit "$?"; touch "$HOME/retired"; await_file "$HOME/b-gate"; exit 0 ;;
  *"/.install-lock") "$real" "$@"; code=$?; touch "$HOME/a-rmdir"; exit "$code" ;;
esac`,
      )
      return { PATH: path }
    })
    expect(result.status, result.stderr).toBe(0)
    // spawnSync waits for B too, since B shares the captured pipes.
    expect(readFileSync(join(home, 'b-status'), 'utf8').trim()).toBe('1')
    expect(readFileSync(join(home, 'b-error'), 'utf8')).toContain('Install lock:')
    expect(readdirSync(old).sort()).toEqual(['current', 'versions'])
    const third = rerun(fixture, home, release)
    expect(third.status, third.stderr).toBe(0)
    expect(third.stdout).toContain('already installed')
  })
})
