import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { typecheckProjects } from '../typecheck-coverage.mjs'
import { evaluateBudget } from '../size-budget.mjs'
import { measureSource } from '../size-spans.mjs'

const root = resolve(import.meta.dirname, '../../..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
const workflow = read('.github/workflows/ci.yml')
const testing = read('docs/testing.md')
const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }

// Scope assertions to a job, not matching a command in another job or a comment.
function job(name: string): string {
  const section = workflow.match(
    new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:|$(?![\\s\\S]))`, 'm'),
  )
  if (!section?.[1]) throw new Error(`Missing CI job: ${name}`)
  return section[1]
}

// Each mandatory command, in the one job that owns it.
const jobCommands = {
  checks: [
    'npm ci',
    'npm ci --prefix apps/site',
    'npm run typecheck',
    'node tools/scripts/size-budget.mjs check',
  ],
  lint: ['npm ci', 'npm run lint', 'npx prettier --check .'],
  build: [
    'npm ci',
    'npm run build',
    'npm run web:build',
    'npm run build:host',
    'npm run build:control',
  ],
  unit: ['npm ci', 'npm ci --prefix apps/site', 'npm test'],
}

const documentedCommands = [
  'npm ci',
  'npm ci --prefix apps/site',
  'npm run typecheck',
  'npm run lint',
  'npx prettier --check .',
  'npm test -- --maxWorkers=2',
  'node tools/scripts/size-budget.mjs check',
  'node tools/scripts/typecheck-coverage.mjs',
  'npx vitest run tools/scripts/test/foundation-wiring.test.ts',
  'npx vitest run tools/scripts/validate.test.ts',
  'npm run test:e2e',
  'SKIP_E2E=1 npm run validate',
  'node tools/scripts/test-inventory.mjs collect --out /tmp/inventory-before.json',
  'node tools/scripts/test-inventory.mjs run --out /tmp/execution.json tools/scripts/validate.test.ts',
  'node tools/scripts/test-inventory.mjs compare --before /tmp/inventory-before.json --after /tmp/inventory-after.json --map /tmp/moves.json',
  'node tools/scripts/unit-coverage.mjs --unit /tmp/unit.json --before "$BEFORE_SHA" --after "$FINAL_SHA" tools/scripts/validate.test.ts',
  'node tools/scripts/unit-gate.mjs --input /tmp/gate.json',
  'node tools/scripts/size-budget.mjs check --strict',
]

function documentedShellLines(): string[] {
  return [...testing.matchAll(/```bash\n([\s\S]*?)\n```/g)].flatMap((block) =>
    block[1]!.split('\n').filter(Boolean),
  )
}

describe('foundation CI wiring', () => {
  it.each(Object.entries(jobCommands))(
    'installs before %s and runs each of its mandatory commands exactly once',
    (name, expected) => {
      const section = job(name)
      const commands = [...section.matchAll(/^ {8}run: (.+)$/gm)].map((match) => match[1])
      expect(commands).toEqual(expected)
      expect(section).not.toMatch(/^\s*(?:if|continue-on-error):/m)
      expect(section).not.toMatch(/--passWithNoTests|--if-present|\|\|\s*(?:true|:)|--exclude/)
    },
  )

  it('runs the whole unit suite in one job', () => {
    expect(job('unit')).not.toContain('--shard')
    expect(workflow).not.toContain('tools/scripts/unit-gate.mjs')
  })

  it('warms Electron up before the Desktop suite on Linux', () => {
    expect(read('apps/desktop/playwright.config.ts')).toContain("globalSetup: './e2e/warm-up.ts'")
    const warmUp = read('apps/desktop/e2e/warm-up.ts')
    expect(warmUp).toContain("process.platform !== 'linux'")
    expect(warmUp).toContain('requestAnimationFrame')
  })

  it('maps Desktop e2e windows and limits only PR macOS legs to @macos', () => {
    const e2e = job('e2e')
    expect(e2e).toContain("PHOSPHOR_E2E_SHOW: '1'")
    const [push, pr] = [...e2e.matchAll(/'(\[\{"os".*?\])'/g)].map(
      (match) => JSON.parse(match[1]!) as { os: string; shard: string; grep?: string }[],
    )
    expect(e2e).toContain("github.event_name == 'push' &&")
    expect(push).toEqual([
      { os: 'linux', shard: '1/1' },
      { os: 'macos', shard: '1/1' },
    ])
    expect(pr).toEqual([
      { os: 'linux', shard: '1/1' },
      { os: 'macos', shard: '1/1', grep: '@macos' },
    ])
  })

  it('uses the comprehensive runner including its all-file audit, Host, Control and site', () => {
    expect(pkg.scripts.typecheck).toBe('node tools/scripts/typecheck.mjs')
    expect(typecheckProjects).toEqual(
      expect.arrayContaining([
        'apps/host/tsconfig.json',
        'apps/control/tsconfig.json',
        'apps/site/tsconfig.json',
        'tsconfig.tools.json',
        'libs/client-ui/tsconfig.json',
        'libs/host-client/tsconfig.json',
        'libs/host-client/tsconfig.tests.json',
        'apps/web/tsconfig.json',
        'apps/web/tsconfig.tests.json',
        'apps/web/tsconfig.worker.json',
        'apps/web/e2e/tsconfig.json',
      ]),
    )
    const runner = read('tools/scripts/typecheck.mjs')
    expect(runner).toContain('const missing = auditCoverage(root)')
    expect(runner).toContain('if (missing.length)')
    expect(runner).toContain('for (const project of typecheckProjects)')
    // The audit also has an actual-repository unit test. No extra CI audit step.
    expect(read('tools/scripts/test/typecheck-coverage.test.ts')).toContain(
      'expect(auditCoverage(repo)).toEqual([])',
    )
    expect(workflow).not.toMatch(/run: .*typecheck(?::host|:control|:web-e2e|-coverage\.mjs)/)
    expect(read('docs/host.md')).not.toContain('standalone `npm run typecheck:host`')
  })

  it('still rejects one-line growth above a reconciled baseline ceiling', () => {
    const desktop = JSON.parse(read('tools/budgets/desktop.json')) as {
      offenders: Record<string, number>
    }
    // Any production whole-file offender (400-line rule); a paid-down entry may be pruned.
    const [key, ceiling] =
      Object.entries(desktop.offenders).find(
        ([entry]) => /^electron\/.*\.ts::file$/.test(entry) && !entry.includes('.test.'),
      ) ?? []
    if (!key || !ceiling) throw new Error('desktop.json has no production whole-file offender')
    const file = key.slice(0, -'::file'.length)
    const budget = {
      version: 1,
      package: 'desktop',
      offenders: { [key]: ceiling },
      exemptions: [],
      renames: {},
    }
    const spans = (lines: number) => measureSource(file, '// fixture line\n'.repeat(lines))
    expect(evaluateBudget(spans(ceiling), budget).errors).toEqual([])
    expect(evaluateBudget(spans(ceiling + 1), budget).errors).toEqual([
      `Grown offender ${key} (file400): ${ceiling + 1} lines, baseline ${ceiling}`,
    ])
  })

  it('runs every job on the project runners, selected by OS and architecture', () => {
    const runsOn = [...workflow.matchAll(/^ {4}runs-on: (.+)$/gm)].map((match) => match[1])
    const linux = '[self-hosted, Linux, ARM64]'
    expect(runsOn.filter((value) => value === linux)).toHaveLength(8)
    expect(runsOn.filter((value) => value !== linux)).toEqual([
      `\${{ matrix.os == 'macos' && fromJSON('["self-hosted","macOS","ARM64"]') || fromJSON('["self-hosted","Linux","ARM64"]') }}`,
    ])
    // A bare `self-hosted` would hand Linux work to the Mac.
    expect(workflow).not.toMatch(/runs-on: self-hosted$|ubuntu-|macos-/m)
  })

  it('gates no job on affected projects', () => {
    expect(workflow).not.toMatch(/affected|shadowSelection/)
    // Only the aggregator waits on other jobs; everything else starts at once.
    expect(workflow.match(/^ {4}needs:/gm)).toHaveLength(1)
    expect(job('result')).toMatch(/^ {4}needs:/m)
  })

  it('aggregates every required job and rejects all non-success results', () => {
    const jobs = [...workflow.split('\njobs:\n')[1]!.matchAll(/^ {2}([\w-]+):$/gm)].map(
      (match) => match[1],
    )
    expect(jobs).toEqual([
      'checks',
      'lint',
      'build',
      'unit',
      'web-e2e',
      'control-schema',
      'site',
      'e2e',
      'result',
    ])
    const result = job('result')
    expect(result).toContain('name: CI result')
    expect(result).toContain('if: always()')
    expect(result).toContain(
      'needs: [checks, lint, build, unit, control-schema, site, e2e, web-e2e]',
    )
    expect(result).toContain("RESULTS: ${{ join(needs.*.result, ' ') }}")
    expect(result).toContain('for r in $RESULTS; do [ "$r" = success ] ||')
    expect(result).toContain('exit 1;')
  })
})

describe('living testing contract', () => {
  it.each(documentedCommands)('keeps the runnable command: %s', (command) => {
    expect(documentedShellLines()).toContain(command)
    const script = command.match(/npm run ([\w:-]+)/)?.[1]
    if (script) expect(pkg.scripts[script]).toBeTruthy()
    for (const path of command.match(/tools\/scripts\/[\w/.-]+\.(?:mjs|ts)/g) ?? []) {
      expect(existsSync(resolve(root, path)), path).toBe(true)
    }
  })

  it('documents actual CLI flags rather than a second invented gate interface', () => {
    const inventory = read('tools/scripts/test-inventory.mjs')
    for (const flag of ['--out', '--before', '--after', '--map', '--allow-platform-mismatch']) {
      expect(inventory).toContain(flag)
      expect(testing).toContain(flag)
    }
    const coverage = read('tools/scripts/unit-coverage.mjs')
    for (const flag of ['--unit', '--before', '--after', '--map']) {
      expect(coverage).toContain(flag)
      expect(testing).toContain(flag)
    }
    expect(read('tools/scripts/unit-gate.mjs')).toContain('--input gate.json')
    expect(read('tools/scripts/size-budget.mjs')).toContain('check [--strict]')
    expect(testing).toContain('owner-expanded exact multi-unit `manifest`')
    expect(testing).toContain('Do not run this tool against untrusted PR data in CI.')
    expect(testing).not.toContain('—')
  })

  it('keeps layout, typed helper, frozen suites, budgets and warning staging discoverable', () => {
    expect(testing).toContain('temporary until RL-03')
    expect(testing).toContain('test(<ID>): characterize <behaviour>')
    expect(testing).toContain('test(<ID>): regression <defect>')
    for (const path of [
      'apps/desktop/test/renderer/helpers/fakePhosphor.ts',
      'libs/shared/test/ipc.freeze.test.ts',
      'apps/desktop/test/main/preload.freeze.test.ts',
      'libs/shared/test/host-protocol.freeze.test.ts',
      'libs/shared/test/control-api.freeze.test.ts',
      'tools/scripts/test/status-wire.freeze.test.ts',
    ]) {
      expect(testing).toContain(path)
      expect(existsSync(resolve(root, path)), path).toBe(true)
    }
    for (const phrase of [
      '400-line',
      'functions 80 lines',
      'test files 800 lines',
      'one-way ceilings',
      'no-floating-promises',
      'no-misused-promises',
      'zero-warning CI budget',
      'eslint-suppressions.json',
      'oxlint-suppressions.json',
      'tools/scripts/dead-mocks.mjs',
    ])
      expect(testing).toContain(phrase)
  })

  it('links the contract from agent commands/conventions, development and the system index', () => {
    const claude = read('AGENTS.md')
    const commands = claude.split('## Commands')[1]!.split('## Architecture')[0]!
    const conventions = claude.split('## Conventions')[1]!.split('## Running')[0]!
    expect(commands).toContain('(docs/testing.md)')
    expect(conventions).toContain('(docs/testing.md#layout-and-helpers)')
    const development = read('README.md').split('## Development')[1]!.split('### Nx')[0]!
    expect(development).toContain('(docs/testing.md)')
    expect(development).toContain('npm ci --prefix apps/site')
    expect(read('docs/README.md').split('## The system')[1]!.split('## The surfaces')[0]).toContain(
      '[testing.md](testing.md)',
    )
    for (const text of [commands, development]) {
      expect(text).not.toMatch(/main \+ renderer|tsc for main/)
      expect(text).toContain('Host, Control, tooling')
    }
  })
})
