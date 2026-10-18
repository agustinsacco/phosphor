import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildPlan, validatePlanInputs } from '../../relocation/plan.mjs'
import { SHIPPING_FIXTURE, SHIPPING_DESTINATION } from '../../relocation/map.mjs'
import { validateRelocationMap } from '../../test-inventory.mjs'

const directories: string[] = []
const projects = [
  { name: 'desktop', roots: ['apps/desktop'] },
  { name: 'host', roots: ['apps/host'] },
  { name: 'shared', roots: ['libs/shared'] },
  { name: 'tooling', roots: ['tools/scripts', 'tools/host-release'] },
]
function repository(contents: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'relocation-plan-'))
  directories.push(root)
  for (const [file, content] of Object.entries(contents)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), content)
  }
  const files = Object.keys(contents)
  const plan = (tests: string[], paths = files) =>
    buildPlan({ root, files: paths, tests, projects })
  return { root, files, plan }
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
afterEach(() =>
  directories.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })),
)

describe('relocation planner', () => {
  it('is deterministic, FD-05 compatible, hashed, and never writes inputs', () => {
    const test = 'apps/host/src/api/a.test.ts'
    const content = "import { a } from './a'\n"
    const repo = repository({ [test]: content, 'apps/host/src/api/a.ts': 'export const a = 1' })
    const first = repo.plan([test])
    expect(first).toEqual(repo.plan([test], [...repo.files].reverse()))
    expect(validateRelocationMap(first)).toEqual([
      { from: test, to: 'apps/host/test/api/a.test.ts' },
    ])
    expect(first.moves[0]).toMatchObject({ hash: digest(content), kind: 'test' })
    expect(first.importerEdits).toEqual([
      {
        file: test,
        to: 'apps/host/test/api/a.test.ts',
        hash: digest(content),
        edits: [{ start: 19, end: 22, from: './a', to: '../../src/api/a' }],
      },
    ])
    expect(validatePlanInputs(repo.root, first)).toBe(true)
    expect(readFileSync(join(repo.root, test), 'utf8')).toBe(content)
  })

  it('routes the shipping replay fixture to dev and reports its shipping consumer', () => {
    const test = 'apps/desktop/src/features/chat/replay.test.ts'
    const mock = 'apps/desktop/src/dev/mockPhosphor.ts'
    const repo = repository({
      [SHIPPING_FIXTURE]: '{}',
      [mock]: "import raw from '../features/chat/__fixtures__/real-session-events.jsonl?raw'",
      [test]: "import raw from './__fixtures__/real-session-events.jsonl?raw'",
    })
    const plan = repo.plan([test])
    expect(plan.moves).toContainEqual({
      from: SHIPPING_FIXTURE,
      to: SHIPPING_DESTINATION,
      kind: 'shipping-fixture',
      hash: digest('{}'),
    })
    expect(plan.importerEdits.find((edit) => edit.file === test)?.edits[0]?.to).toBe(
      '../../../../src/dev/fixtures/real-session-events.jsonl?raw',
    )
    expect(plan.importerEdits.some((edit) => edit.file === mock)).toBe(false)
    expect(plan.reports).toContainEqual(
      expect.objectContaining({ file: mock, reason: 'external-consumer' }),
    )
  })

  it('classifies mixed fixture directories per file and follows helper dependencies', () => {
    const test = 'apps/host/src/a.test.ts'
    const helper = 'apps/host/src/test-support.ts'
    const testFixture = 'apps/host/src/__fixtures__/test.ts'
    const shippingFixture = 'apps/host/src/__fixtures__/shipping.ts'
    const repo = repository({
      [test]: "import './test-support'",
      [helper]: "export * from './__fixtures__/test'",
      [testFixture]: 'export const test = 1',
      [shippingFixture]: 'export const shipping = 2',
      'apps/host/src/main.ts': "import './__fixtures__/shipping'",
    })
    expect(repo.plan([test]).moves.map(({ from }) => from)).toEqual([testFixture, test, helper])
  })

  it('preserves transitive shipping helpers and the public host-protocol-testing API', () => {
    const test = 'libs/shared/src/host-protocol-testing/api.test.ts'
    const repo = repository({
      [test]: "import './index'",
      'libs/shared/src/host-protocol-testing/index.ts': "export * from './fake-host'",
      'libs/shared/src/host-protocol-testing/fake-host.ts': 'export const host = 1',
      'apps/host/src/test-support.ts': "export * from './__fixtures__/shipping'",
      'apps/host/src/__fixtures__/shipping.ts': '',
      'apps/host/src/main.ts': "import './test-support'",
    })
    expect(repo.plan([test]).moves.map(({ from }) => from)).toEqual([test])
  })

  it('rewrites imports, exports, require, aliases and dynamic literal imports exactly', () => {
    const test = 'apps/desktop/src/a.test.ts'
    const content = [
      "import './a.js'",
      "export * from './a'",
      "const a = require('./a')",
      "import('./a')",
      "import raw from '@/__fixtures__/a.json?raw'",
      '// import "./not-real"',
    ].join('\n')
    const repo = repository({
      [test]: content,
      'apps/desktop/src/a.ts': '',
      'apps/desktop/src/__fixtures__/a.json': '{}',
    })
    const plan = repo.plan([test])
    const edits = plan.importerEdits.find((edit) => edit.file === test)!.edits
    expect(edits.map(({ to }) => to)).toEqual([
      '../../src/a.js',
      '../../src/a',
      '../../src/a',
      '../../src/a',
      './__fixtures__/a.json?raw',
    ])
    for (const edit of edits) expect(content.slice(edit.start, edit.end)).toBe(edit.from)
  })

  it('reports e2e consumers, CI paths, packaging filters and path math without rewriting', () => {
    const test = 'apps/host/src/__fixtures__/fake-pi.test.ts'
    const e2e = 'apps/desktop/e2e/fixtures/remote-host.ts'
    const repo = repository({
      [test]: "const p = join(import.meta.dirname, 'fake-pi.cjs')",
      'apps/host/src/__fixtures__/fake-pi.cjs': '',
      'apps/host/src/__fixtures__/machine.ts': '',
      [e2e]:
        "import '../../../../apps/host/src/__fixtures__/machine'\n" +
        "spawn(join(project, 'apps/host/src/__fixtures__/fake-pi.cjs'))",
      '.github/workflows/ci.yml': `run: vitest ${test}`,
      'apps/desktop/electron-builder.yml': "filter: ['**/*.ts', '!**/*.test.ts']",
    })
    const plan = repo.plan([test])
    expect(plan.importerEdits).toEqual([])
    expect(plan.reports.map(({ reason }) => reason)).toEqual(
      expect.arrayContaining(['external-consumer', 'string-path', 'config-path', 'path-math']),
    )
    expect(plan.reports.filter(({ file }) => file === e2e)).toHaveLength(2)
  })

  it('rejects stale move and unmoved importer hashes', () => {
    const test = 'apps/host/src/a.test.ts'
    const consumer = 'tools/scripts/test/existing.test.ts'
    const repo = repository({ [test]: '', [consumer]: "import '../../../apps/host/src/a.test'" })
    const plan = repo.plan([test, consumer])
    expect(plan.importerEdits).toHaveLength(1)
    writeFileSync(join(repo.root, consumer), 'changed')
    expect(() => validatePlanInputs(repo.root, plan)).toThrow(`Stale input hash: ${consumer}`)
    writeFileSync(join(repo.root, consumer), "import '../../../apps/host/src/a.test'")
    writeFileSync(join(repo.root, test), 'changed')
    expect(() => validatePlanInputs(repo.root, plan)).toThrow(`Stale input hash: ${test}`)
  })

  it('reports unresolved imports and collisions rather than planning silent overwrites', () => {
    const test = 'apps/host/src/a.test.ts'
    const repo = repository({ [test]: "import './missing'", 'apps/host/test/A.test.ts': '' })
    const plan = repo.plan([test])
    expect(plan.collisions).toHaveLength(1)
    expect(plan.reports).toContainEqual({
      file: test,
      line: 1,
      reason: 'unresolved-import',
      text: './missing',
    })
    expect(() => repo.plan(['apps/host/src/untracked.test.ts'])).toThrow('Untracked test')
  })

  it('reports URL-based paths and nonliteral imports without guessing replacements', () => {
    const test = 'apps/host/src/a.test.ts'
    const repo = repository({
      [test]: [
        "const url = new URL('./data.txt', import.meta.url)",
        'const data = import(variable)',
      ].join('\n'),
    })
    const plan = repo.plan([test])
    expect(plan.importerEdits).toEqual([])
    expect(plan.reports.map(({ text }) => text)).toEqual([
      "new URL('./data.txt', import.meta.url)",
      'import(variable)',
    ])
    expect(() => repo.plan([])).toThrow('Empty Vitest inventory')
  })

  it('rewrites mock specifiers and skips unchanged source-directory strings', () => {
    const test = 'apps/host/src/a.test.ts'
    const repo = repository({
      [test]: ["import './a'", "vi.mock('./a', () => ({}))", "const source = 'apps/host/src'"].join(
        '\n',
      ),
      'apps/host/src/a.ts': '',
    })
    const plan = repo.plan([test])
    expect(plan.importerEdits[0]!.edits).toHaveLength(2)
    expect(plan.reports.map(({ text }) => text)).toEqual([])
  })

  it('keeps raw escaped edit preimages and handles type imports', () => {
    const test = 'apps/host/src/a.test.ts'
    const content = "type A = import('\\x2e/a').A"
    const repo = repository({ [test]: content, 'apps/host/src/a.ts': 'export type A = string' })
    const edits = repo.plan([test]).importerEdits[0]!.edits
    expect(edits).toHaveLength(1)
    expect(content.slice(edits[0]!.start, edits[0]!.end)).toBe(edits[0]!.from)
    expect(edits[0]!.to).toBe('../src/a')
  })

  it('reports excluded site and supabase consumers without editing them', () => {
    const test = 'apps/host/src/a.test.ts'
    const repo = repository({
      [test]: '',
      'apps/site/src/a.ts': "import '../../host/src/a.test'",
      'supabase/tests/a.ts': "import '../../apps/host/src/a.test'",
    })
    const plan = repo.plan([test])
    expect(plan.importerEdits).toEqual([])
    expect(plan.reports.map(({ file }) => file)).toEqual([
      'apps/site/src/a.ts',
      'supabase/tests/a.ts',
    ])
  })

  it('keeps package subpaths stable when the resolved production target is stationary', () => {
    const test = 'apps/host/src/a.test.ts'
    const repo = repository({
      [test]: "import '@phosphor/pi-extensions/swarm'",
      'libs/pi-extensions/pi-ext/swarm.ts': '',
    })
    const plan = repo.plan([test])
    expect(plan.importerEdits).toEqual([])
    expect(plan.reports).toEqual([])
  })

  it.each(['--apply', '--verify', '--unknown'])('rejects unsupported mode %s', (mode) => {
    const result = spawnSync(
      process.execPath,
      [resolve('tools/scripts/relocate-tests.mjs'), mode],
      { encoding: 'utf8' },
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(mode === '--unknown' ? 'Usage:' : 'not implemented in RL-01')
    expect(result.stdout).toBe('')
  })
})
