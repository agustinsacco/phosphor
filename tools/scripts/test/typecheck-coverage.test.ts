import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { auditCoverage, typecheckProjects } from '../typecheck-coverage.mjs'
import { runTypecheck } from '../typecheck.mjs'

const repo = resolve(import.meta.dirname, '../../..')
const temporary: string[] = []
const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phosphor-typecheck-')))
  temporary.push(root)
  return root
}
const write = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

function coverageFixture() {
  const root = fixture()
  execFileSync('git', ['init', '-q', root])
  write(
    root,
    'tsconfig.json',
    JSON.stringify({ compilerOptions: { noEmit: true }, include: ['src/**/*'] }),
  )
  write(root, 'src/member.ts', 'export {}')
  execFileSync('git', ['add', '.'], { cwd: root })
  return root
}

function runnerFixture() {
  const root = fixture()
  for (const path of [
    'node_modules/typescript/lib/tsc.js',
    'apps/site/node_modules/typescript/lib/typescript.js',
    'apps/site/node_modules/@astrojs/check/package.json',
    'apps/site/node_modules/.bin/astro',
  ])
    write(root, path, '{}')
  return root
}

describe('typecheck coverage audit', () => {
  it('covers the actual repository, including untracked candidate files', () => {
    expect(auditCoverage(repo)).toEqual([])
  })

  it('resolves noEmit includes relative to the config, not the working directory', () => {
    const root = coverageFixture()
    write(
      root,
      'nested/tsconfig.json',
      JSON.stringify({ compilerOptions: { noEmit: true }, include: ['../src/**/*'] }),
    )
    expect(auditCoverage(root, ['nested/tsconfig.json'])).toEqual([])
  })

  it('fails when a project is missing or loses a tracked config member', () => {
    const root = coverageFixture()
    expect(() => auditCoverage(root, ['missing.json'])).toThrow(/missing.json/)
    write(root, 'other/kept.ts', 'export {}')
    write(
      root,
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { noEmit: true }, include: ['other/**/*'] }),
    )
    expect(auditCoverage(root, ['tsconfig.json'])).toEqual(['src/member.ts'])
  })

  it.each(['ts', 'tsx', 'mts', 'cts', 'd.ts'])(
    'rejects a new orphan .%s without blanket declaration exemptions',
    (extension) => {
      const root = coverageFixture()
      write(root, `orphan.${extension}`, 'export {}')
      expect(auditCoverage(root, ['tsconfig.json'])).toEqual([`orphan.${extension}`])
    },
  )

  it('ignores gitignored generated files, not tracked declarations', () => {
    const root = coverageFixture()
    write(root, '.gitignore', 'generated/\n')
    write(root, 'generated/types.d.ts', 'export {}')
    expect(auditCoverage(root, ['tsconfig.json'])).toEqual([])
    execFileSync('git', ['add', '-f', 'generated/types.d.ts'], { cwd: root })
    expect(auditCoverage(root, ['tsconfig.json'])).toEqual(['generated/types.d.ts'])
  })

  it('explicitly includes tools helpers and tests in both layouts without blanket checkJs', () => {
    const root = fixture()
    execFileSync('git', ['init', '-q', root])
    for (const path of ['tsconfig.base.json', 'tsconfig.tools.json'])
      write(root, path, readFileSync(join(repo, path), 'utf8'))
    for (const path of [
      'vitest.config.ts',
      'tools/scripts/adjacent.test.ts',
      'tools/scripts/test/nested/helper.ts',
      'tools/scripts/__tests__/legacy.test.ts',
      'tools/host-release/adjacent.test.ts',
      'tools/host-release/test/nested/helper.ts',
    ])
      write(root, path, 'export {}')
    expect(auditCoverage(root, ['tsconfig.tools.json'])).toEqual([])
    const config = JSON.parse(readFileSync(join(root, 'tsconfig.tools.json'), 'utf8'))
    expect(config.compilerOptions.allowJs).toBe(true)
    expect(config.compilerOptions.checkJs).not.toBe(true)
  })
})

describe('comprehensive typecheck runner', () => {
  it('shares one root and Nx runner while preserving standalone Host and Control aliases', () => {
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
    const project = JSON.parse(readFileSync(join(repo, 'tools/scripts/project.json'), 'utf8'))
    expect(pkg.scripts.typecheck).toBe('node tools/scripts/typecheck.mjs')
    expect(project.targets.typecheck.options.command).toBe(pkg.scripts.typecheck)
    expect(pkg.scripts['typecheck:host']).toBe('tsc --noEmit -p apps/host/tsconfig.json')
    expect(pkg.scripts['typecheck:control']).toBe('tsc --noEmit -p apps/control/tsconfig.json')
  })

  it('delegates every compiler project and the independent site check', () => {
    const root = runnerFixture()
    const calls: { command: string; args: string[]; cwd: string }[] = []
    expect(
      runTypecheck(root, (command, args, cwd) => {
        calls.push({ command, args, cwd })
        return 0
      }),
    ).toBe(0)
    expect(calls.slice(0, -1).map((call) => call.args)).toEqual(
      typecheckProjects
        .filter((path) => path !== 'apps/site/tsconfig.json')
        .map((path) => [join(root, 'node_modules/typescript/lib/tsc.js'), '--noEmit', '-p', path]),
    )
    expect(calls.at(-1)).toEqual({
      command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
      args: ['run', 'check'],
      cwd: join(root, 'apps/site'),
    })
    expect(typecheckProjects).toHaveLength(11)
  })

  it.each(['apps/host/tsconfig.json', 'apps/control/tsconfig.json', 'site'])(
    'propagates %s check failure',
    (failed) => {
      const root = runnerFixture()
      expect(
        runTypecheck(root, (_command, args, cwd) =>
          (failed === 'site' ? cwd.endsWith('/apps/site') : args.includes(failed)) ? 7 : 0,
        ),
      ).toBe(7)
    },
  )

  it('propagates an actual independent site command failure', () => {
    const root = runnerFixture()
    write(root, 'apps/site/package.json', JSON.stringify({ scripts: { check: 'node check.cjs' } }))
    write(root, 'apps/site/check.cjs', 'process.exit(7)')
    expect(runTypecheck(root)).toBe(7)
  })

  it('rejects individual site tools linked into a parent installation', () => {
    const root = runnerFixture()
    const tool = join(root, 'apps/site/node_modules/typescript/lib/typescript.js')
    rmSync(tool)
    symlinkSync(join(root, 'node_modules/typescript/lib/tsc.js'), tool)
    expect(() => runTypecheck(root, () => 0)).toThrow(/site.*local installation/i)
  })

  it('requires a real site-local installation, never a parent toolchain', () => {
    const root = runnerFixture()
    rmSync(join(root, 'apps/site/node_modules'), { recursive: true })
    expect(() => runTypecheck(root, () => 0)).toThrow(/site.*local installation/i)
    symlinkSync(join(root, 'node_modules'), join(root, 'apps/site/node_modules'), 'dir')
    expect(() => runTypecheck(root, () => 0)).toThrow(/site.*local installation/i)
  })
})
