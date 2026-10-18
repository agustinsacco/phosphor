import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { evaluateBudget, checkRepository, PACKAGES } from '../size-budget.mjs'
import { measureSource } from '../size-spans.mjs'

const source = (lines: number) => Array.from({ length: lines }, () => '// line').join('\n')
const baseline = (offenders = {}, exemptions: object[] = [], renames = {}) => ({
  version: 1,
  package: 'shared',
  offenders,
  exemptions,
  renames,
})
const measure = (lines: number, file = 'src/large.ts') => measureSource(file, source(lines))
const fixtureDirs: string[] = []
afterEach(() =>
  fixtureDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })),
)

function repository() {
  const dir = mkdtempSync(join(tmpdir(), 'size-budget-'))
  fixtureDirs.push(dir)
  execFileSync('git', ['init', '-q', dir])
  mkdirSync(join(dir, 'tools/budgets'), { recursive: true })
  for (const name of Object.keys(PACKAGES)) {
    writeFileSync(
      join(dir, `tools/budgets/${name}.json`),
      JSON.stringify({ ...baseline(), package: name }),
    )
  }
  return dir
}

function put(root: string, file: string, text: string) {
  mkdirSync(join(root, file, '..'), { recursive: true })
  writeFileSync(join(root, file), text)
}

describe('size-budget per-package ratchet', () => {
  it('rejects new and grown offenders while permitting equal, shrunk and removed offenders', () => {
    expect(evaluateBudget(measure(401), baseline()).errors.join('\n')).toMatch(
      /new.*src\/large.ts/i,
    )
    const existing = baseline({ 'src/large.ts::file': 420 })
    expect(evaluateBudget(measure(421), existing).errors.join('\n')).toMatch(/grown.*421.*420/i)
    for (const lines of [420, 419, 400, 0]) {
      expect(evaluateBudget(measure(lines), existing).errors).toEqual([])
    }
    expect(evaluateBudget([], existing).errors).toEqual([])
  })

  it('ratchets full functions even when the file is within its limit', () => {
    const spans = measureSource(
      'a.ts',
      `function factory() {\n  return { run() {\n${source(81)}\n  } }\n}`,
    )
    const errors = evaluateBudget(spans, baseline()).errors
    expect(errors).toHaveLength(2)
    expect(errors.join('\n')).toMatch(/factory\[1\]\/run\[1\]/)
  })

  it('uses test800 rather than source400 and still limits test functions to 80', () => {
    expect(evaluateBudget(measure(800, 'a.test.ts'), baseline()).errors).toEqual([])
    expect(evaluateBudget(measure(801, 'a.test.ts'), baseline()).errors.join('\n')).toContain(
      'test-file800',
    )
    expect(evaluateBudget(measure(401, 'a.ts'), baseline()).errors.join('\n')).toContain('file400')
    const test = `it('case', () => {\n${source(81)}\n})`
    expect(
      evaluateBudget(measureSource('a.test.ts', test), baseline()).errors.join('\n'),
    ).toContain('function80')
  })

  it('supports explicit file rename mappings without allowing growth or implicit rename credit', () => {
    const spans = measure(410, 'src/new.ts')
    const old = { 'src/old.ts::file': 410 }
    expect(evaluateBudget(spans, baseline(old)).errors).toHaveLength(1)
    const renamed = baseline(old, [], { 'src/old.ts': 'src/new.ts' })
    expect(evaluateBudget(spans, renamed).errors).toEqual([])
    expect(evaluateBudget(measure(411, 'src/new.ts'), renamed).errors.join('\n')).toMatch(/grown/i)
    expect(
      evaluateBudget([...spans, ...measure(410, 'src/old.ts')], renamed).errors.join('\n'),
    ).toMatch(/rename/i)
  })

  it('requires exact generated/declaration exemptions with rationale and owner', () => {
    const exemption = {
      file: 'src/generated.ts',
      rule: 'file400',
      kind: 'generated',
      rationale: 'Generated registry checked against its source by the generation suite.',
      owner: 'shared',
    }
    expect(evaluateBudget(measure(500, exemption.file), baseline({}, [exemption])).errors).toEqual(
      [],
    )
    expect(
      evaluateBudget(measure(500, 'src/other.ts'), baseline({}, [exemption])).errors.join('\n'),
    ).toMatch(/new/i)
    for (const invalid of [
      { ...exemption, file: 'src/*.ts' },
      { ...exemption, rationale: '' },
      { ...exemption, owner: '' },
      { ...exemption, kind: 'security-complexity' },
      { ...exemption, rule: '*' },
    ]) {
      expect(
        evaluateBudget(measure(500, exemption.file), baseline({}, [invalid])).errors.join('\n'),
      ).toMatch(/exemption/i)
    }
  })

  it('fails stale exemptions rather than keeping unused waivers', () => {
    const exemption = {
      file: 'a.ts',
      rule: 'file400',
      kind: 'declaration',
      rationale: 'Icon declarations',
      owner: 'desktop',
    }
    expect(
      evaluateBudget(measure(400, 'a.ts'), baseline({}, [exemption])).errors.join('\n'),
    ).toMatch(/stale exemption/i)
    expect(evaluateBudget([], baseline({}, [exemption])).errors.join('\n')).toMatch(
      /stale exemption/i,
    )
  })

  it('offers strict final cleanup that rejects baseline debt but accepts approved exemptions', () => {
    const spans = measure(410)
    expect(
      evaluateBudget(spans, baseline({ 'src/large.ts::file': 410 }), { strict: true }).errors.join(
        '\n',
      ),
    ).toMatch(/remaining.*baseline/i)
    expect(
      evaluateBudget(measure(400), baseline({ 'src/large.ts::file': 410 }), { strict: true })
        .errors,
    ).toEqual([])
  })

  it('fails closed on malformed, duplicate and invalid baseline entries', () => {
    for (const invalid of [
      { ...baseline(), version: 2 },
      { ...baseline(), offenders: { 'a.ts::file': -1 } },
      { ...baseline(), offenders: { 'a.ts::file': '500' } },
      { ...baseline(), renames: { 'old.ts': '../outside.ts' } },
    ]) {
      expect(evaluateBudget(measure(410), invalid).errors.join('\n')).toMatch(/invalid/i)
    }
  })

  it('checks all eleven package domains, tracked and untracked source, and never rewrites baselines', () => {
    const root = repository()
    for (const prefix of Object.values(PACKAGES)) {
      put(root, `${prefix || '.'}/large.ts`, source(401))
    }
    execFileSync('git', ['-C', root, 'add', 'apps/host/large.ts'])
    put(root, 'ignored/huge.json', source(1000))
    const before = readFileSync(join(root, 'tools/budgets/host.json'), 'utf8')
    const result = checkRepository(root)
    expect(result.errors).toHaveLength(11)
    for (const name of Object.keys(PACKAGES)) expect(result.errors.join('\n')).toContain(`${name}:`)
    expect(readFileSync(join(root, 'tools/budgets/host.json'), 'utf8')).toBe(before)
  })

  it.each([
    { name: 'new offender', lines: 401, command: 'check', status: 1, output: /shared:.*new/i },
    { name: 'within budget', lines: 400, command: 'check', status: 0, output: /PASS/ },
    { name: 'missing baseline', lines: 400, command: 'check', status: 1, output: /host:.*ENOENT/ },
    { name: 'unknown command', lines: 400, command: 'regenerate', status: 1, output: /Usage:/ },
  ])('CLI checks $name', ({ name, lines, command, status, output }) => {
    const root = repository()
    put(root, 'libs/shared/large.ts', source(lines))
    if (name === 'missing baseline') rmSync(join(root, 'tools/budgets/host.json'))
    const script = resolve('tools/scripts/size-budget.mjs')
    const result = spawnSync(process.execPath, [script, command], { cwd: root, encoding: 'utf8' })
    expect(result.status).toBe(status)
    expect(result.stdout + result.stderr).toMatch(output)
  })
})
