import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildPlan } from '../../relocation/plan.mjs'
import { evaluateBudget } from '../../size-budget.mjs'
import { listTestFiles } from '../../select-unit-tests.mjs'

const roots: string[] = []
const projects = [{ name: 'host', roots: ['apps/host'] }]
const test = 'apps/host/src/a.test.ts'
function planFor(contents: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'relocation-regressions-'))
  roots.push(root)
  for (const [file, content] of Object.entries(contents)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), content)
  }
  return buildPlan({ root, files: Object.keys(contents), tests: [test], projects })
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function rewritten(content: string, edits: { start: number; end: number; to: string }[]) {
  return [...edits]
    .reverse()
    .reduce((text, edit) => text.slice(0, edit.start) + edit.to + text.slice(edit.end), content)
}

describe('relocation plan regressions', () => {
  it.each(['vi', 'vitest'])('rewrites every %s mock module API and factory import', (api) => {
    const methods = ['mock', 'doMock', 'unmock', 'doUnmock', 'importActual', 'importMock']
    const calls = methods.map((method) => `${api}.${method}('./a')`)
    calls.push(`${api}.mock(import('./a'), () => import('./a'))`)
    const content = calls.join('\n')
    const plan = planFor({ [test]: content, 'apps/host/src/a.ts': '' })
    expect(plan.importerEdits[0]!.edits).toHaveLength(8)
    expect(rewritten(content, plan.importerEdits[0]!.edits)).toBe(
      calls.join('\n').replaceAll("'./a'", "'../src/a'"),
    )
    expect(plan.reports).toEqual([])
  })

  it('does not report unchanged alias mocks, including in excluded consumers', () => {
    const plan = planFor({
      [test]: "vi.mock('@/lib/a')",
      'apps/desktop/src/lib/a.ts': '',
      'apps/desktop/e2e/a.ts': "vi.mock('@/lib/a')",
    })
    expect(plan.importerEdits).toEqual([])
    expect(plan.reports).toEqual([])
  })

  it('rewrites the real codex usage health mock relative to its new test home', () => {
    const root = process.cwd()
    const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
      .split('\0')
      .filter(Boolean)
    const plan = buildPlan({ root, files, tests: listTestFiles(root) })
    const edit = plan.importerEdits.find(
      ({ file }) => file === 'apps/desktop/electron/pi/codex-usage.test.ts',
    )!
    expect(edit.to).toBe('apps/desktop/test/main/pi/codex-usage.test.ts')
    expect(edit.edits).toContainEqual(
      expect.objectContaining({
        from: './health',
        to: '../../../electron/pi/health',
      }),
    )
  })

  it.each(['ts', 'json'])('does not add .%s to a dotted extensionless specifier', (extension) => {
    const file = 'tools/scripts/test/consumer.ts'
    const target = `apps/host/src/__fixtures__/a.test.${extension}`
    const content = "import '../../../apps/host/src/__fixtures__/a.test'"
    const plan = planFor({ [test]: '', [target]: '', [file]: content })
    expect(rewritten(content, plan.importerEdits[0]!.edits)).toBe(
      "import '../../../apps/host/test/__fixtures__/a.test'",
    )
  })

  it('reports Markdown links and inline paths to moved files as doc-path', () => {
    const plan = planFor({
      [test]: '',
      'README.md': `See [test](${test})`,
      'docs/testing.md': 'See [suite](../apps/host/src/a.test.ts)\n`apps/host/src/a.test.ts`',
    })
    expect(plan.reports).toEqual([
      { file: 'README.md', line: 1, reason: 'doc-path', text: `See [test](${test})` },
      {
        file: 'docs/testing.md',
        line: 1,
        reason: 'doc-path',
        text: 'See [suite](../apps/host/src/a.test.ts)',
      },
      { file: 'docs/testing.md', line: 2, reason: 'doc-path', text: '`apps/host/src/a.test.ts`' },
    ])
  })

  it('reports moved subtrees but not parent roots or unchanged paths', () => {
    const plan = planFor({
      [test]: [
        "const root = 'apps/host'",
        "const parent = 'apps/host/src'",
        "const up = '..'",
        "const stable = '@phosphor/shared/a'",
        "const fixtures = 'apps/host/src/__fixtures__'",
      ].join('\n'),
      'apps/host/src/a.ts': '',
      'apps/host/src/__fixtures__/data.json': '{}',
      'libs/shared/src/a.ts': '',
      'tools/scripts/config.ts': "const stable = 'apps/host/src/a.ts'",
    })
    expect(plan.reports).toEqual([
      { file: test, line: 5, reason: 'string-path', text: 'apps/host/src/__fixtures__' },
    ])
  })

  it('omits unchanged fixture strings in stationary consumers', () => {
    const plan = planFor({
      [test]: '',
      'apps/host/src/main.ts':
        "import './__fixtures__/shipping'\nconst name = './__fixtures__/shipping'",
      'apps/host/src/__fixtures__/shipping.ts': '',
    })
    expect(plan.reports).toEqual([])
  })

  it('omits unchanged relative references inside a relocated subtree and slash markers', () => {
    const plan = planFor({
      [test]:
        "const data = './__fixtures__/data.json'\nconst directory = '__fixtures__'\nconst marker = '/__fixtures__/'",
      'apps/host/src/__fixtures__/data.json': '{}',
      'apps/host/src/__fixtures__/generator.mjs': "const cwd = '.'\nconst data = './data.json'",
    })
    expect(plan.reports).toEqual([])
  })

  it('sorts report filenames by code units, not the machine locale', () => {
    const contents = Object.fromEntries(
      ['Z', 'a', '_'].map((name) => [`docs/${name}.json`, JSON.stringify({ test })]),
    )
    const plan = planFor({ [test]: '', ...contents })
    expect(plan.reports.map(({ file }) => file)).toEqual([
      'docs/Z.json',
      'docs/_.json',
      'docs/a.json',
    ])
  })

  it('emits directly applicable per-package budget renames only for moved baseline files', () => {
    const budget = {
      version: 1,
      package: 'host',
      offenders: {
        'src/__fixtures__/fake-pi.cjs::file': 450,
        'src/__fixtures__/machine.ts::fakeMachine[1]': 90,
        'src/__fixtures__/machine.ts::file': 401,
        'src/main.ts::file': 500,
      },
      exemptions: [],
      renames: {},
    }
    const plan = planFor({
      [test]: '',
      'apps/host/src/__fixtures__/fake-pi.cjs': '',
      'apps/host/src/__fixtures__/machine.ts': '',
      'apps/host/src/main.ts': '',
      'tools/budgets/host.json': JSON.stringify(budget),
      'tools/budgets/shared.json': JSON.stringify({ ...budget, package: 'shared', offenders: {} }),
    })
    expect(plan.budgetRenames).toEqual({
      host: {
        'src/__fixtures__/fake-pi.cjs': 'test/__fixtures__/fake-pi.cjs',
        'src/__fixtures__/machine.ts': 'test/__fixtures__/machine.ts',
      },
    })
    const result = evaluateBudget(
      [
        {
          file: 'test/__fixtures__/fake-pi.cjs',
          key: 'test/__fixtures__/fake-pi.cjs::file',
          rule: 'file',
          lines: 450,
        },
        {
          file: 'test/__fixtures__/machine.ts',
          key: 'test/__fixtures__/machine.ts::fakeMachine[1]',
          rule: 'function',
          lines: 90,
        },
        {
          file: 'test/__fixtures__/machine.ts',
          key: 'test/__fixtures__/machine.ts::file',
          rule: 'file',
          lines: 401,
        },
        { file: 'src/main.ts', key: 'src/main.ts::file', rule: 'file', lines: 500 },
      ],
      { ...budget, renames: plan.budgetRenames.host },
    )
    expect(result.errors).toEqual([])
  })
})
