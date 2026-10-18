import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  aggregateCoverage,
  compareCoverage,
  coverageScope,
  runUnitCoverage,
} from '../unit-coverage.mjs'

const root = resolve(import.meta.dirname, '../../..')
const facade = 'tools/scripts/facade.ts'
const helper = 'tools/scripts/helper.ts'
const renamed = 'tools/scripts/renamed.ts'
const test = 'tools/scripts/example.test.ts'
const moves = { version: 1, moves: [{ from: facade, to: renamed, kind: 'source' }] }
const report = (counts: Record<string, number[]>, directory = root) =>
  Object.fromEntries(
    Object.entries(counts).map(([file, hits]) => [
      join(directory, file),
      {
        path: join(directory, file),
        statementMap: Object.fromEntries(hits.map((_, index) => [String(index), {}])),
        s: Object.fromEntries(hits.map((hit, index) => [String(index), hit])),
      },
    ]),
  )
const aggregate = (counts: Record<string, number[]>) =>
  aggregateCoverage(report(counts), Object.keys(counts), root)

describe('unit-coverage aggregate statement comparison', () => {
  it('weights statements rather than averaging file percentages', () => {
    const before = aggregate({ [facade]: [1], [helper]: [1, 0, 0] })
    expect(before).toMatchObject({ covered: 2, total: 4 })
    expect(compareCoverage(before, aggregate({ [facade]: [1, 0], [helper]: [1, 0] })).pass).toBe(
      true,
    )
    expect(compareCoverage(before, aggregate({ [facade]: [1, 0], [helper]: [0, 0] })).pass).toBe(
      false,
    )
  })

  it('includes untested helper dilution and prints denominator changes', () => {
    const before = aggregate({ [facade]: [1, 1] })
    const after = aggregate({ [facade]: [1, 1], [helper]: [0, 0] })
    expect(compareCoverage(before, after)).toMatchObject({ pass: false, denominatorChange: 2 })
  })

  it('compares exact ratios, not rounded displayed percentages', () => {
    const before = aggregate({ [facade]: [...Array<number>(9999).fill(1), 0] })
    const after = aggregate({ [facade]: [...Array<number>(9998).fill(1), 0] })
    expect(compareCoverage(before, after).pass).toBe(false)
  })

  it('normalizes renamed scope while retaining new helper statements', () => {
    const before = aggregate({ [facade]: [1] })
    const after = aggregateCoverage(
      report({ [renamed]: [1], [helper]: [0] }),
      [renamed, helper],
      root,
      moves,
    )
    expect(after.files.map((entry) => entry.file)).toEqual([facade, helper])
    expect(compareCoverage(before, after).pass).toBe(false)
    expect(() => compareCoverage(before, aggregate({ [renamed]: [1] }))).toThrow(/lost scope/i)
  })

  it('treats zero-statement scope as vacuously covered, without NaN', () => {
    const empty = aggregate({ [facade]: [] })
    expect(compareCoverage(empty, empty)).toMatchObject({ pass: true, denominatorChange: 0 })
    expect(compareCoverage(empty, aggregate({ [facade]: [0] })).pass).toBe(false)
    expect(compareCoverage(aggregate({ [facade]: [0] }), empty).pass).toBe(true)
  })

  it.each([{}, null, [], { [join(root, facade)]: { s: { 0: -1 } } }])(
    'fails closed on missing or malformed reports: %j',
    (input) => expect(() => aggregateCoverage(input, [facade], root)).toThrow(),
  )

  it('requires every selected file and every statement count, including zero-hit files', () => {
    expect(() => aggregateCoverage(report({ [facade]: [1] }), [facade, helper], root)).toThrow(
      /missing.*helper/i,
    )
    const malformed = report({ [facade]: [1] })
    const entry = malformed[join(root, facade)]
    if (!entry) throw new Error('fixture entry missing')
    entry.s = {}
    expect(() => aggregateCoverage(malformed, [facade], root)).toThrow(/statement/i)
    expect(() => aggregateCoverage({}, [], root)).toThrow(/empty/i)
    expect(() => aggregateCoverage({}, ['../escape.ts'], root)).toThrow(/path/i)
    expect(() =>
      compareCoverage({ covered: 2, total: 1, files: [] }, aggregate({ [facade]: [] })),
    ).toThrow()
  })
})

const temporary = mkdtempSync(join(tmpdir(), 'phosphor-coverage-test-'))
afterAll(() => rmSync(temporary, { recursive: true, force: true }))
function fixture() {
  const directory = mkdtempSync(join(temporary, 'repo-'))
  const put = (file: string, content: string) => {
    mkdirSync(resolve(directory, file, '..'), { recursive: true })
    writeFileSync(join(directory, file), content)
  }
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Coverage test',
        GIT_AUTHOR_EMAIL: 'coverage@example.invalid',
        GIT_COMMITTER_NAME: 'Coverage test',
        GIT_COMMITTER_EMAIL: 'coverage@example.invalid',
      },
    }).trim()
  const commit = () => {
    git('add', '.')
    git('commit', '-qm', 'fixture')
    return git('rev-parse', 'HEAD')
  }
  git('init', '-q')
  put('package.json', '{"type":"module"}')
  put('tools/scripts/project.json', '{"name":"tooling","root":"tools/scripts"}')
  put('vitest.config.mjs', 'export default {test:{include:["tools/scripts/*.test.ts"]}}')
  put(facade, 'export function value() { return 1 }')
  put(
    test,
    `import {it,expect} from 'vitest'; import {value} from './facade'; it('value',()=>expect(value()).toBe(1))`,
  )
  put('tools/scripts/types.d.ts', 'export interface Example { value: string }')
  put('tools/scripts/type-only.ts', 'export interface OnlyTypes { value: string }')
  const before = commit()
  put(helper, 'export function unused() { return 42 }')
  const after = commit()
  const unit = { owns: ['tools/scripts/**'], new_tests: [{ test }] }
  return { directory, put, git, commit, unit, before, after }
}

it('selects all owned sources and includes real unimported helpers in isolated ref runs', () => {
  const { directory, git, unit, before, after } = fixture()
  expect(coverageScope(unit, directory)).toEqual([facade, helper, 'tools/scripts/type-only.ts'])
  const options = { unit, before, after, tests: [test], root: directory, dependencies: root }
  const result = runUnitCoverage(options)
  expect(result.pass).toBe(false)
  expect(result.before.total).toBeGreaterThan(0)
  expect(result.after.total).toBeGreaterThan(result.before.total)
  expect(result.after.files.find((entry) => entry.file === helper)).toMatchObject({ covered: 0 })
  expect(
    result.after.files.find((entry) => entry.file === 'tools/scripts/type-only.ts'),
  ).toMatchObject({ covered: 0, total: 0 })
  expect(result.runtime).toMatchObject({ os: process.platform, node: process.version })
  expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
  expect(readFileSync(join(directory, facade), 'utf8')).toContain('return 1')
  expect(() => runUnitCoverage({ ...options, before: 'missing-ref' })).toThrow()
  expect(() => runUnitCoverage({ ...options, tests: [] })).toThrow(/tests/i)
  expect(() => coverageScope({ ...unit, owns: ['docs/**'] }, directory)).toThrow(/empty/i)
}, 60_000)

it('normalizes real source/test relocations and cleans up on failed tests', () => {
  const { directory, put, git, commit, unit, before } = fixture()
  const relocatedTest = 'tools/scripts/relocated.test.ts'
  git('mv', facade, renamed)
  git('mv', test, relocatedTest)
  put(
    relocatedTest,
    readFileSync(join(directory, relocatedTest), 'utf8').replace('./facade', './renamed'),
  )
  const after = commit()
  const map = { version: 1, moves: [...moves.moves, { from: test, to: relocatedTest }] }
  const options = { unit, before, after, tests: [test], map, root: directory, dependencies: root }
  const result = runUnitCoverage(options)
  expect(result.after.files.map((entry) => entry.file)).toEqual([
    helper,
    facade,
    'tools/scripts/type-only.ts',
  ])
  expect(result.pass).toBe(false)
  put(relocatedTest, "import {it,expect} from 'vitest'; it('fails',()=>expect(1).toBe(2))")
  expect(() => runUnitCoverage({ ...options, after: commit() })).toThrow()
  expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
  put('tools/scripts/check.sh', '#!/bin/sh\necho unmeasurable')
  git('add', '.')
  expect(() => coverageScope(unit, directory)).toThrow(/unsupported executable/i)
}, 60_000)

it('prints help and fails closed on incomplete CLI input', () => {
  const script = join(root, 'tools/scripts/unit-coverage.mjs')
  expect(execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' })).toContain(
    '--before',
  )
  const result = spawnSync(process.execPath, [script, '--before', 'HEAD'], { encoding: 'utf8' })
  expect(result.status).toBe(1)
  expect(result.stderr).toMatch(/required/i)
})

// Review regressions: snapshot isolation, cleanup failures and command evidence.
import * as childProcess from 'node:child_process'
import { existsSync, symlinkSync } from 'node:fs'
import { vi } from 'vitest'

function workspaceFixture(declaration: string) {
  const { directory, put, git, commit } = fixture()
  const workspace = 'tools/scripts/workspace'
  const workspaceSource = `${workspace}/index.js`
  const relocatedTest = 'tools/scripts/workspace.test.ts'
  put(
    'package.json',
    JSON.stringify({
      type: 'module',
      ...(declaration === 'manifest' ? { workspaces: ['tools/scripts/*'] } : {}),
    }),
  )
  if (declaration === 'lockfile')
    put(
      'package-lock.json',
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          'node_modules/@fixture/workspace': { resolved: workspace, link: true },
        },
      }),
    )
  put(
    `${workspace}/package.json`,
    JSON.stringify({ name: '@fixture/workspace', type: 'module', exports: './index.js' }),
  )
  put(workspaceSource, 'export function value() { return 1 }')
  put(
    test,
    `import {it,expect} from 'vitest'; import {value} from '@fixture/workspace';
   import {readFileSync} from 'node:fs';
   const expected = JSON.parse(readFileSync(new URL('../../expected.json', import.meta.url), 'utf8'));
   it('snapshot value',()=>expect(value()).toBe(expected))`,
  )
  put('expected.json', '1')
  const before = commit()
  put(workspaceSource, 'export function value(extra = false) { if (extra) return 3; return 2 }')
  put('expected.json', '2')
  git('mv', test, relocatedTest)
  const after = commit()
  // A dependency installation with the same workspace link as npm creates.
  mkdirSync(join(directory, 'node_modules/@fixture'), { recursive: true })
  symlinkSync(
    join(directory, workspace),
    join(directory, 'node_modules/@fixture/workspace'),
    'junction',
  )
  symlinkSync(join(root, 'node_modules/vitest'), join(directory, 'node_modules/vitest'), 'junction')
  symlinkSync(
    join(root, 'node_modules/@vitest'),
    join(directory, 'node_modules/@vitest'),
    'junction',
  )
  return { directory, git, before, after, workspaceSource, relocatedTest }
}

it.each(['lockfile', 'manifest'])(
  'imports and measures each ref’s own workspace package using its %s',
  (declaration) => {
    const { directory, git, before, after, workspaceSource, relocatedTest } =
      workspaceFixture(declaration)
    const result = runUnitCoverage({
      unit: { owns: [workspaceSource], new_tests: [{ test }] },
      before,
      after,
      tests: [test],
      map: { version: 1, moves: [{ from: test, to: relocatedTest }] },
      root: directory,
    })
    expect(result.pass).toBe(false)
    expect(result.before.covered).toBe(result.before.total)
    expect(result.after.covered).toBeGreaterThan(0)
    expect(result.after.covered).toBeLessThan(result.after.total)
    expect(result.commands.before).toEqual([
      process.execPath,
      join(directory, 'node_modules/vitest/vitest.mjs'),
      'run',
      '--maxWorkers=2',
      '--coverage.enabled',
      '--coverage.provider=v8',
      '--coverage.reporter=json',
      expect.stringMatching(/^--coverage.reportsDirectory=.*\/old-report$/),
      `--coverage.include=${workspaceSource}`,
      test,
    ])
    expect(result.commands.after).toEqual([
      ...result.commands.before.slice(0, 7),
      expect.stringMatching(/^--coverage.reportsDirectory=.*\/new-report$/),
      `--coverage.include=${workspaceSource}`,
      relocatedTest,
    ])
    expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
  },
  60_000,
)

it.each([true, false])(
  'attempts all cleanup steps and preserves the first error (earlier operation failed: %s)',
  async (operationFailed) => {
    const { directory, git, unit, before, after } = fixture()
    const removed: string[] = []
    let pruned = false
    const firstCleanupError = new Error('first removal failed')
    const execute = vi.fn(childProcess.execFileSync).mockImplementation((file, args, options) => {
      if (file === 'git' && args?.[0] === 'worktree') {
        if (args[1] === 'remove') {
          removed.push(String(args[3]))
          throw removed.length === 1 ? firstCleanupError : new Error('second removal failed')
        }
        if (args[1] === 'prune') pruned = true
      }
      return execFileSync(file, args, options)
    })
    vi.resetModules()
    vi.doMock('node:child_process', () => ({ ...childProcess, execFileSync: execute }))
    const { runUnitCoverage: isolatedRun } = await import('../unit-coverage.mjs')
    try {
      expect(() =>
        isolatedRun({
          unit: operationFailed ? { ...unit, owns: ['docs/**'] } : unit,
          before,
          after,
          tests: [test],
          root: directory,
          dependencies: root,
        }),
      ).toThrow(operationFailed ? /empty owned executable source scope/i : firstCleanupError)
      expect(removed).toHaveLength(2)
      expect(removed.every((snapshot) => !existsSync(resolve(snapshot, '..')))).toBe(true)
      expect(pruned).toBe(true)
    } finally {
      vi.doUnmock('node:child_process')
      vi.resetModules()
    }
    expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
  },
  60_000,
)
