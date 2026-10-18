import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runUnitGate, type GateOptions } from '../unit-gate.mjs'

const roots: string[] = []
const test =
  "import { expect, test } from 'vitest'; import { value } from './entry.mjs'; test('public entry', () => expect(value()).toBe(1))\n"
function fixture(kind = 'decompose', characterization = true) {
  const root = mkdtempSync(join(tmpdir(), 'unit gate '))
  roots.push(root)
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git('init', '-q')
  const commit = (files: Record<string, string>, subject: string) => {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      writeFileSync(join(root, file), content)
    }
    git('add', '--all')
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-qm',
      subject,
    )
    return git('rev-parse', 'HEAD')
  }
  const baseSha = commit(
    { 'entry.mjs': 'export const value = () => 1\n', 'package.json': '{"type":"module"}' },
    'base',
  )
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'junction')
  writeFileSync(join(root, '.git/info/exclude'), 'node_modules\nevidence*.json\n')
  const owns = ['entry.mjs', 'entry.test.ts', 'new.test.ts', 'package.json', 'unrelated.test.ts']
  const options: GateOptions = {
    root,
    baseSha,
    finalSha: baseSha,
    unit: {
      id: 'FD-X',
      kind,
      owns: [...owns],
      characterize_first: characterization ? [{ test: 'entry.test.ts' }] : [],
      new_tests: [{ test: 'entry.test.ts' }],
    },
    manifest: { version: 1, units: [{ id: 'FD-X', owns }] },
    evidencePath: join(root, 'evidence.json'),
  }
  const characterize = (extra: Record<string, string> = {}) => {
    options.characterizationSha = commit(
      { 'entry.test.ts': test, ...extra },
      'test(FD-X): characterize public entry',
    )
    return options.characterizationSha
  }
  const finish = (
    files: Record<string, string> = { 'entry.mjs': 'export function value() { return 1 }\n' },
    subject = 'refactor(FD-X): preserve entry',
  ) => {
    options.finalSha = commit(files, subject)
    const regressionShas = git(
      'log',
      '--format=%H',
      '--grep=^test(FD-X): regression ',
      `${baseSha}..HEAD`,
    )
      .split('\n')
      .filter(Boolean)
    const beforeSha = options.characterizationSha ?? regressionShas[0] ?? baseSha
    const aggregate = { covered: 1, total: 1, files: [{ file: 'entry.mjs', covered: 1, total: 1 }] }
    options.coverage = {
      beforeSha,
      afterSha: options.finalSha,
      report: { before: aggregate, after: structuredClone(aggregate) },
    }
  }
  return { root, git, commit, options, characterize, finish }
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('unit-gate history enforcement', () => {
  it('runs public-entry characterization on unchanged source and preserves pre-squash evidence', () => {
    const f = fixture()
    f.characterize()
    f.finish()
    const result = runUnitGate(f.options)
    expect(result.failures).toEqual([])
    expect(result.pass).toBe(true)
    const evidence = JSON.parse(readFileSync(f.options.evidencePath, 'utf8'))
    expect(evidence.commits.map((c: { sha: string }) => c.sha)).toEqual([
      f.options.characterizationSha,
      f.options.finalSha,
    ])
    expect(evidence.runs.map((r: { label: string }) => r.label)).toEqual([
      'characterization',
      'final',
    ])
    expect(evidence.runs[0].report.testResults[0].assertionResults[0].title).toBe('public entry')
    expect(evidence.runtime.node).toBe(process.version)
    expect(evidence.frozen[0].blob).toMatch(/^[a-f0-9]{40}$/)
    expect(evidence.coverage.report.before.total).toBe(1)
    expect(() => runUnitGate(f.options)).toThrow(/exists/)
  }, 30000)

  it('rejects source edits in the first characterization commit', () => {
    const f = fixture()
    f.characterize({ 'entry.mjs': 'export const value = () => 2' })
    f.finish()
    expect(runUnitGate(f.options).failures.join()).toMatch(/characterization.*test-only/i)
  })

  it('requires the first commit, all specified tests and immutable SHAs', () => {
    const f = fixture()
    f.commit({ 'entry.mjs': 'export const value = () => 2' }, 'refactor(FD-X): premature change')
    f.characterize()
    f.finish()
    expect(runUnitGate(f.options).failures.join()).toMatch(/first commit/)
    const other = fixture()
    other.characterize()
    other.finish()
    other.options.unit.characterize_first?.push({ test: 'unrelated.test.ts' })
    expect(runUnitGate(other.options).failures.join()).toMatch(/specified characterization/)
    const mutable = fixture()
    mutable.options.finalSha = 'HEAD'
    expect(runUnitGate(mutable.options).failures.join()).toMatch(/immutable.*SHA/)
  })

  it('rejects a later edit hidden by a final restoration', () => {
    const f = fixture()
    f.characterize()
    f.commit(
      { 'entry.test.ts': test.replace('toBe(1)', 'toBe(2)') },
      'test(FD-X): weaken assertion',
    )
    f.finish({ 'entry.test.ts': test })
    expect(runUnitGate(f.options).failures.join()).toMatch(/frozen/)
  })

  it('checks ownership at every commit, including reverted edits and rename endpoints', () => {
    const f = fixture()
    f.characterize()
    f.commit({ 'not owned.txt': 'hidden change' }, 'chore(FD-X): touch foreign file')
    f.git('rm', 'not owned.txt')
    f.finish()
    expect(runUnitGate(f.options).failures.join()).toMatch(/outside.*ownership.*not owned.txt/)
  })

  it('rejects overlapping, globbed or undeclared exact ownership', () => {
    for (const mutation of ['overlap', 'glob', 'unrelated']) {
      const f = fixture()
      f.characterize()
      f.finish()
      if (mutation === 'overlap') f.options.manifest.units.push({ id: 'FD-Y', owns: ['entry.mjs'] })
      if (mutation === 'glob') f.options.manifest.units[0]!.owns = ['*.mjs']
      if (mutation === 'unrelated') f.options.manifest.units[0]!.owns.push('other-unit.mjs')
      expect(runUnitGate(f.options).failures.join()).toMatch(/exclusive|exact|declared/)
    }
  })

  it('requires complete expansion of ownership globs and covers rename destinations', () => {
    const f = fixture()
    f.options.unit.owns = [
      'entry*.mjs',
      'entry*.test.ts',
      'new.test.ts',
      'package.json',
      'unrelated.test.ts',
    ]
    f.characterize()
    f.finish({
      'entry.mjs': 'export const value = () => 1',
      'entry-extra.mjs': 'export const hidden = 1',
    })
    expect(runUnitGate(f.options).failures.join()).toMatch(/fully expanded/)
    const renamed = fixture()
    renamed.characterize()
    renamed.git('mv', 'entry.mjs', 'not-owned.mjs')
    renamed.finish({ 'entry.mjs': 'export const value = () => 1' })
    expect(runUnitGate(renamed.options).failures.join()).toMatch(
      /outside.*ownership.*not-owned.mjs/,
    )
  })

  it('requires dependencies accepted at immutable commits already in base history', () => {
    const f = fixture()
    f.characterize()
    f.finish()
    f.options.unit.depends_on = ['FD-Y']
    f.options.manifest.units.push({ id: 'FD-Y', owns: ['other.mjs'] })
    expect(runUnitGate(f.options).failures.join()).toMatch(/dependency/)
  })

  it('accepts integrated dependency evidence and rejects acceptance of a future commit', () => {
    const f = fixture()
    f.characterize()
    f.finish()
    f.options.unit.depends_on = ['FD-Y']
    f.options.manifest.units.push({
      id: 'FD-Y',
      owns: ['other.mjs'],
      accepted: { pass: true, finalSha: f.options.baseSha },
    })
    expect(runUnitGate(f.options).pass).toBe(true)
    f.options.evidencePath = join(f.root, 'evidence-future.json')
    f.options.manifest.units[1]!.accepted!.finalSha = f.options.finalSha
    expect(runUnitGate(f.options).failures.join()).toMatch(/dependency not integrated/)
  }, 30000)

  it('rejects missing, stale or decreasing coverage evidence', () => {
    for (const mutation of ['missing', 'stale', 'decrease']) {
      const f = fixture()
      f.characterize()
      f.finish()
      if (mutation === 'missing') delete f.options.coverage
      if (mutation === 'stale') f.options.coverage!.afterSha = f.options.baseSha
      if (mutation === 'decrease') {
        const after = f.options.coverage!.report.after
        after.covered = 0
        after.files[0]!.covered = 0
      }
      expect(runUnitGate(f.options).failures.join()).toMatch(/coverage/i)
    }
  })

  it('requires passing characterization, not merely successful collection', () => {
    const f = fixture()
    f.characterize({ 'entry.test.ts': test.replace('toBe(1)', 'toBe(2)') })
    f.finish()
    expect(runUnitGate(f.options).failures.join()).toMatch(/characterization.*pass/i)
  }, 30000)

  it('accepts a fix with assertion-red regression and green final, without demanding passing characterization', () => {
    const f = fixture('fix', false)
    f.commit(
      { 'entry.test.ts': test.replace('toBe(1)', 'toBe(2)') },
      'test(FD-X): regression wrong value',
    )
    f.finish({ 'entry.mjs': 'export const value = () => 2' }, 'fix(FD-X): return correct value')
    expect(runUnitGate(f.options).failures).toEqual([])
  }, 30000)

  it('rejects green regressions and source edits before regression', () => {
    const f = fixture('security', false)
    f.commit({ 'entry.test.ts': test }, 'test(FD-X): regression ineffective')
    f.finish(undefined, 'fix(FD-X): preserve entry')
    expect(runUnitGate(f.options).failures.join()).toMatch(/regression.*assertion/)
    const early = fixture('perf', false)
    early.commit({ 'entry.mjs': 'export const value = () => 2' }, 'perf(FD-X): too soon')
    early.commit({ 'entry.test.ts': test }, 'test(FD-X): regression late')
    early.finish(undefined, 'perf(FD-X): finish')
    expect(runUnitGate(early.options).failures.join()).toMatch(/source.*before/i)
  }, 30000)

  it('rejects a weakened regression and executes regression files absent from explicit selection', () => {
    const f = fixture('fix', false)
    f.commit(
      { 'entry.test.ts': test.replace('toBe(1)', 'toBe(2)') },
      'test(FD-X): regression wrong value',
    )
    f.finish({ 'entry.test.ts': test }, 'fix(FD-X): weaken regression')
    expect(runUnitGate(f.options).failures.join()).toMatch(/frozen/)
    const omitted = fixture('fix', false)
    omitted.commit(
      { 'entry.test.ts': test.replace('toBe(1)', 'toBe(2)') },
      'test(FD-X): regression wrong value',
    )
    omitted.options.unit.new_tests = [{ test: 'unrelated.test.ts' }]
    omitted.finish({ 'unrelated.test.ts': test }, 'fix(FD-X): unrelated passing test')
    const result = runUnitGate(omitted.options)
    expect(result.failures.join()).toMatch(/final.*pass/i)
    expect(result.runs.find((run) => run.label === 'final')?.files).toContain('entry.test.ts')
  }, 30000)

  it('checks every regression at its own commit and rejects load errors as red evidence', () => {
    const f = fixture('fix', false)
    f.commit(
      { 'entry.test.ts': test.replace('toBe(1)', 'toBe(2)') },
      'test(FD-X): regression first',
    )
    f.commit({ 'entry.mjs': 'export const value = () => 2' }, 'fix(FD-X): first fix')
    f.commit(
      { 'unrelated.test.ts': "import './missing-module.mjs'" },
      'test(FD-X): regression load failure',
    )
    f.finish(undefined, 'fix(FD-X): finish')
    expect(runUnitGate(f.options).failures.join()).toMatch(/regression.*assertion/)
  }, 30000)

  it('allows only an approved exact-content relocation at its specified commit', () => {
    const f = fixture()
    f.characterize()
    f.git('mv', 'entry.test.ts', 'new.test.ts')
    const moveSha = f.commit({}, 'refactor(FD-X): relocate test')
    f.finish()
    f.options.relocation = {
      mode: 'relocation',
      approvedBy: 'owner',
      commitSha: moveSha,
      map: { version: 1, moves: [{ from: 'entry.test.ts', to: 'new.test.ts' }] },
    }
    expect(runUnitGate(f.options).failures).toEqual([])
    const invalid = fixture()
    invalid.characterize()
    invalid.git('mv', 'entry.test.ts', 'new.test.ts')
    const changed = invalid.commit(
      { 'new.test.ts': test + '// rewritten\n' },
      'refactor(FD-X): rewrite moved test',
    )
    invalid.finish()
    invalid.options.relocation = { ...f.options.relocation, commitSha: changed }
    expect(runUnitGate(invalid.options).failures.join()).toMatch(/mechanical/)
  }, 30000)

  it('forces the entire suite after root config changes, including intermediate reverted changes', () => {
    const f = fixture()
    // This pre-existing test is not in explicit unit selection.
    const base = f.commit(
      {
        'unrelated.test.ts':
          "import { test, expect } from 'vitest'; test('unrelated failure', () => expect(1).toBe(2))",
      },
      'baseline unrelated test',
    )
    f.options.baseSha = base
    f.characterize()
    f.commit(
      { 'package.json': '{"type":"module","private":true}' },
      'chore(FD-X): change root config',
    )
    f.finish({ 'package.json': '{"type":"module"}' })
    const result = runUnitGate(f.options)
    expect(result.failures.join()).toMatch(/final.*pass/i)
    expect(result.runs.find((r) => r.label === 'final')?.files).toEqual([])
  }, 30000)

  it.each(['apps/desktop/package.json', 'tsconfig.tools.json'])(
    'requires the full suite for %s',
    (file) => {
      const f = fixture()
      f.options.unit.owns.push(file)
      f.options.manifest.units[0]!.owns.push(file)
      f.options.baseSha = f.commit(
        {
          'unrelated.test.ts':
            "import { test, expect } from 'vitest'; test('unrelated failure', () => expect(1).toBe(2))",
        },
        'baseline unrelated test',
      )
      f.characterize()
      f.finish({ [file]: '{}' })
      const result = runUnitGate(f.options)
      expect(result.failures.join()).toMatch(/final.*pass/i)
      expect(result.runs.find((run) => run.label === 'final')?.files).toEqual([])
    },
    30000,
  )

  it('provides a fail-closed CLI and writes evidence even for invalid history', () => {
    const f = fixture()
    f.characterize({ 'entry.mjs': 'export const value = () => 2' })
    f.finish()
    const input = join(f.root, 'input.json')
    writeFileSync(input, JSON.stringify(f.options))
    const result = spawnSync(
      process.execPath,
      [resolve('tools/scripts/unit-gate.mjs'), '--input', input],
      { encoding: 'utf8' },
    )
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout).pass).toBe(false)
    expect(JSON.parse(readFileSync(f.options.evidencePath, 'utf8')).finalSha).toBe(
      f.options.finalSha,
    )
  })
})

describe('unit-gate review regressions', () => {
  it.each(['fix', 'security', 'perf'])(
    'accepts and freezes red characterize_first files for %s units',
    (kind) => {
      const f = fixture(kind)
      f.options.characterizationSha = f.commit(
        { 'entry.test.ts': test.replace('toBe(1)', 'toBe(2)') },
        'test(FD-X): regression specified defect',
      )
      f.finish({ 'entry.mjs': 'export const value = () => 2' }, 'fix(FD-X): correct value')
      const result = runUnitGate(f.options)
      expect(result.failures).toEqual([])
      expect(result.runs.map((run) => run.label)).toEqual(['regression', 'final'])
      expect(result.runs[0]?.status).not.toBe(0)
      expect(result.runs[0]?.failed).toBe(1)
      expect(result.runs[0]?.suiteErrors).toBe(0)
      expect(result.frozen.some((entry) => entry.original === 'entry.test.ts')).toBe(true)
      f.finish({ 'entry.test.ts': test }, 'test(FD-X): rewrite frozen regression')
      f.options.evidencePath = join(f.root, 'evidence-frozen.json')
      expect(runUnitGate(f.options).failures.join()).toMatch(/frozen/)
    },
    30000,
  )

  it('uses the last regression ref when no characterization exists', () => {
    const f = fixture('fix', false)
    f.commit(
      { 'entry.test.ts': test.replace('toBe(1)', 'toBe(2)') },
      'test(FD-X): regression first assertion',
    )
    const lastRegression = f.commit(
      { 'unrelated.test.ts': test.replace('toBe(1)', 'toBe(2)') },
      'test(FD-X): regression second assertion',
    )
    f.finish({ 'entry.mjs': 'export const value = () => 2' }, 'fix(FD-X): correct value')
    expect(f.options.coverage?.beforeSha).toBe(lastRegression)
    expect(runUnitGate(f.options).failures).toEqual([])
    f.options.evidencePath = join(f.root, 'evidence-base.json')
    f.options.coverage!.beforeSha = f.options.baseSha
    expect(runUnitGate(f.options).failures.join()).toMatch(/stale coverage/)
  }, 30000)

  it('records empty executable scope and rejects coverage for it', () => {
    const f = fixture('tooling', false)
    f.options.unit.owns = ['package.json', '.nvmrc', 'entry.test.ts']
    f.options.manifest.units[0]!.owns = [...f.options.unit.owns]
    f.finish({ '.nvmrc': '22.19.0', 'entry.test.ts': test }, 'chore(FD-X): pin node')
    delete f.options.coverage
    const result = runUnitGate(f.options)
    expect(result.failures).toEqual([])
    expect(JSON.parse(readFileSync(f.options.evidencePath, 'utf8')).coverageNote).toBe(
      'no owned executable source',
    )
    f.finish({ '.nvmrc': '22.20.0' }, 'chore(FD-X): update node')
    f.options.evidencePath = join(f.root, 'evidence-coverage.json')
    expect(runUnitGate(f.options).failures.join()).toMatch(/coverage must be absent/i)
  }, 30000)

  it.each(['--config=entry.test.ts', 'nested/-option/entry.test.ts'])(
    'rejects option-like test path segments in %s',
    (file) => {
      const f = fixture()
      f.options.unit.owns.push(file)
      f.options.manifest.units[0]!.owns.push(file)
      f.options.unit.characterize_first = [{ test: file }]
      f.options.unit.new_tests = [{ test: file }]
      f.options.characterizationSha = f.commit(
        { [file]: "import { test } from 'vitest'; test('safe', () => {})" },
        'test(FD-X): characterize option path',
      )
      f.finish()
      expect(runUnitGate(f.options).failures.join()).toMatch(/option-like test path/i)
    },
    30000,
  )

  it.each(['characterize', 'regression'])(
    'allows added __fixtures__ inputs in %s commits and freezes them',
    (mode) => {
      const f = fixture(mode === 'regression' ? 'fix' : 'decompose')
      const file = '__fixtures__/value.json'
      f.options.unit.owns.push(file)
      f.options.manifest.units[0]!.owns.push(file)
      const expected = mode === 'regression' ? 2 : 1
      f.options.characterizationSha = f.commit(
        {
          [file]: JSON.stringify(expected),
          'entry.test.ts': test
            .replace(
              'import { value }',
              "import expected from './__fixtures__/value.json'; import { value }",
            )
            .replace('toBe(1)', 'toBe(expected)'),
        },
        `test(FD-X): ${mode} fixture input`,
      )
      f.finish({ 'entry.mjs': `export const value = () => ${expected}` }, 'fix(FD-X): finish')
      const result = runUnitGate(f.options)
      expect(result.failures).toEqual([])
      expect(result.runs.every((run) => !run.files.includes(file))).toBe(true)
      f.finish({ [file]: '3' }, 'test(FD-X): change fixture')
      f.options.evidencePath = join(f.root, 'evidence-fixture.json')
      expect(runUnitGate(f.options).failures.join()).toMatch(/frozen/)
    },
    30000,
  )
})
