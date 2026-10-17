import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  loadProjectRoots,
  validateUnitSpec,
  selectUnitTests,
  listTestFiles,
  ROOT_SUITE_INPUTS,
} from '../select-unit-tests.mjs'

const root = resolve(import.meta.dirname, '../../..')
const projects = loadProjectRoots(root)
const files = [
  'apps/desktop/src/store.test.ts',
  'apps/desktop/test/renderer/view.test.tsx',
  'apps/host/src/runtime.test.ts',
  'libs/shared/src/rpc.test.ts',
  'libs/shared/test/budget.test.ts',
  'tools/scripts/test/selection.test.ts',
  'tools/host-release/bundle.test.ts',
]
const unit = () => ({
  owns: ['apps/desktop/src/store.ts (projection)', 'apps/desktop/src/MonacoEditor.tsx'],
  characterize_first: [{ test: files[0], covers: ['original'] }],
  new_tests: [{ test: files[1] }],
  existing_tests: [files[0]],
})

describe('select-unit-tests explicit unit selection', () => {
  it('loads project roots from project.json plus the documented release-tools exception', () => {
    const directory = mkdtempSync(join(tmpdir(), 'unit-projects-'))
    try {
      for (const [name, path] of [
        ['host', 'apps/host'],
        ['tooling', 'tools/scripts'],
      ]) {
        mkdirSync(join(directory, path), { recursive: true })
        writeFileSync(join(directory, path, 'project.json'), JSON.stringify({ name, root: path }))
      }
      expect(loadProjectRoots(directory)).toEqual([
        { name: 'host', roots: ['apps/host'] },
        { name: 'tooling', roots: ['tools/scripts', 'tools/host-release'] },
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('unions explicit paths with the entire owning package suite in both layouts', () => {
    expect(selectUnitTests(unit(), files, projects)).toEqual({
      files: [files[0], files[1]],
      projects: ['desktop'],
      warnings: [],
    })
    expect(
      selectUnitTests({ ...unit(), existing_tests: [files[3]] }, files, projects).files,
    ).toContain(files[3])
  })

  it('expands consumer and library suites for import changes without traversing imports', () => {
    const result = selectUnitTests(
      { ...unit(), importChanges: [{ consumer: 'host', library: 'shared' }] },
      files,
      projects,
    )
    expect(result.projects).toEqual(['desktop', 'host', 'shared'])
    expect(result.files).toEqual(files.slice(0, 5))
  })

  it('selects release tools alongside tooling checks', () => {
    expect(
      selectUnitTests(
        { owns: ['tools/host-release/build.mjs'], existing_tests: [files[6]] },
        files,
        projects,
      ).files,
    ).toEqual(files.slice(5).sort())
  })

  it('strips ownership notes, keeps glob prefixes and warns on non-path entries', () => {
    const validated = validateUnitSpec({
      ...unit(),
      owns: [...unit().owns, 'apps/host/**', 'test-inventory'],
    })
    expect(validated.owns).toEqual([
      'apps/desktop/src/store.ts',
      'apps/desktop/src/MonacoEditor.tsx',
      'apps/host',
    ])
    expect(validated.warnings).toHaveLength(1)
  })

  it.each([
    'apps/host/**',
    'apps/host/src/*.ts',
    'apps/host/{src,test}/x.ts',
    'apps/host/[st]*.ts',
  ])('expands glob ownership %s alongside an explicit consumer suite', (glob) => {
    const selection = selectUnitTests({ ...unit(), owns: [glob] }, files, projects)
    expect(selection.projects).toEqual(['desktop', 'host'])
    expect(selection.files).toContain(files[2])
    expect(selection.warnings).toEqual([])
  })

  it('fails closed for glob-only code ownership or unknown glob owners', () => {
    expect(() =>
      selectUnitTests({ owns: ['apps/host/**', 'docs/host.md'] }, files, projects),
    ).toThrow(/Empty explicit/)
    expect(() => selectUnitTests({ ...unit(), owns: ['unknown/**'] }, files, projects)).toThrow(
      /No owning/,
    )
  })

  it.each([
    null,
    {},
    { owns: ['apps/host/src/file.ts'] },
    { owns: ['apps/host/src/file.ts'], existing_tests: [] },
    { owns: ['apps/host/src/file.ts'], existing_tests: [''] },
    { owns: ['apps/host/src/file.ts'], existing_tests: ['../escape.test.ts'] },
    { owns: ['apps/host/src/file.ts'], new_tests: [{}] },
    { ...unit(), importChanges: [{ consumer: 'host' }] },
    { ...unit(), owns: ['**/*.ts'] },
  ])('rejects invalid or empty explicit selection %j', (input) => {
    expect(() => validateUnitSpec(input)).toThrow()
  })

  it('fails on missing explicit tests, empty owning suites and unknown import owners', () => {
    expect(() => selectUnitTests(unit(), [], projects)).toThrow(/Empty/)
    expect(() => selectUnitTests(unit(), files.slice(2), projects)).toThrow(/Missing explicit/)
    expect(() =>
      selectUnitTests({ ...unit(), owns: ['apps/control/src/file.ts'] }, files, projects),
    ).toThrow(/Empty owning/)
    expect(() =>
      selectUnitTests(
        { ...unit(), importChanges: [{ consumer: 'host', library: 'missing' }] },
        files,
        projects,
      ),
    ).toThrow(/Unknown project/)
    expect(() =>
      selectUnitTests({ ...unit(), owns: ['unknown/file.ts'] }, files, projects),
    ).toThrow(/No owning/)
  })

  it('uses real Vitest file-only collection without resolving the Monaco import graph', () => {
    const available = listTestFiles(root)
    const explicit = available.find((file) => file.startsWith('apps/desktop/'))!
    expect(explicit).toBeDefined()
    const selection = selectUnitTests(
      {
        owns: [
          'apps/desktop/src/features/files/MonacoEditor.tsx',
          'apps/desktop/src/lib/monaco.ts',
        ],
        existing_tests: [explicit],
      },
      available,
      projects,
    )
    expect(selection.files).toContain(explicit)
    expect(selection.files.length).toBeGreaterThan(100)
    expect(selection.projects).toEqual(['desktop'])
  }, 30_000)

  it('CLI fails closed when a unit manifest is missing', () => {
    const result = spawnSync(
      process.execPath,
      [resolve(root, 'tools/scripts/select-unit-tests.mjs')],
      { encoding: 'utf8' },
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('--unit')
  })
})

it('pins whole-suite root inputs, including all root tsconfig variants', () => {
  expect(ROOT_SUITE_INPUTS).toEqual([
    'vitest.config.ts',
    'package.json',
    'package-lock.json',
    'tsconfig*.json',
    'eslint.config.js',
  ])
  for (const path of [
    ...ROOT_SUITE_INPUTS.filter((path: string) => !path.includes('*')),
    'tsconfig.base.json',
    'tsconfig.node.json',
  ]) {
    const result = selectUnitTests({ ...unit(), owns: [path] }, files, projects)
    expect(result.files).toEqual([...files].sort())
  }
})
it('warns on unowned non-code and root paths while retaining explicit suite ownership', () => {
  const result = selectUnitTests(
    {
      ...unit(),
      owns: [
        'docs/testing.md',
        'README.md',
        '.github/workflows/ci.yml',
        '.prettierignore',
        'new-guide.md',
      ],
    },
    files,
    projects,
  )
  expect(result.projects).toEqual(['desktop'])
  expect(result.warnings).toHaveLength(5)
})
it('returns an explicit no-tests outcome only for docs or non-code ownership', () => {
  for (const input of [
    { owns: ['docs/testing.md'] },
    { kind: 'docs', owns: ['apps/host/src/runtime.ts'] },
    { owns: ['new-root-guide.md'] },
  ]) {
    expect(selectUnitTests(input, [], projects)).toMatchObject({
      status: 'no-tests',
      files: [],
      reason: expect.any(String),
    })
  }
  expect(() => selectUnitTests({ owns: ['apps/host/src/new-module.ts'] }, files, projects)).toThrow(
    /Empty explicit/,
  )
  expect(() =>
    selectUnitTests(
      { owns: ['docs/testing.md'], importChanges: [{ consumer: 'missing', library: 'host' }] },
      files,
      projects,
    ),
  ).toThrow(/Unknown project/)
})
it('maps not-yet-created owned code by prefix without requiring it on disk', () => {
  const result = selectUnitTests(
    { owns: ['apps/host/src/brand-new-module.ts'], new_tests: [{ test: files[2] }] },
    files,
    projects,
  )
  expect(result.projects).toEqual(['host'])
})

it('still expands project-owned non-code config changes and requires explicit tests', () => {
  expect(
    selectUnitTests(
      { owns: ['libs/shared/package.json'], existing_tests: [files[3]] },
      files,
      projects,
    ).projects,
  ).toEqual(['shared'])
  expect(() => selectUnitTests({ owns: ['libs/shared/package.json'] }, files, projects)).toThrow(
    /Empty explicit/,
  )
})
it('CLI --run returns an explicit no-tests report for documentation without running Vitest', () => {
  const directory = mkdtempSync(join(tmpdir(), 'unit-docs-'))
  try {
    const manifest = join(directory, 'unit.json')
    writeFileSync(manifest, JSON.stringify({ kind: 'docs', owns: ['docs/testing.md'] }))
    const result = spawnSync(
      process.execPath,
      [resolve(root, 'tools/scripts/select-unit-tests.mjs'), '--unit', manifest, '--run'],
      { cwd: root, encoding: 'utf8' },
    )
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'no-tests', files: [] })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
