import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it.each([
  { skip: '1', failBuild: false },
  { skip: '0', failBuild: false },
  { skip: '1', failBuild: true },
  { skip: '1', failBuild: false, failTypes: true },
])('validator always builds and propagates failure: %j', ({ skip, failBuild, failTypes }) => {
  const dir = mkdtempSync(join(tmpdir(), 'validator-'))
  try {
    const calls = join(dir, 'calls')
    const command = `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CALLS"\nif [ "$*" = "$FAIL_COMMAND" ]; then exit 1; fi\n`
    for (const name of ['npm', 'npx']) {
      writeFileSync(join(dir, name), command)
      chmodSync(join(dir, name), 0o755)
    }
    const script = resolve(import.meta.dirname, 'validate.sh')
    execFileSync('bash', ['-n', script])
    const result = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        CALLS: calls,
        FAIL_COMMAND: failTypes ? 'run typecheck' : failBuild ? 'run build' : '',
        SKIP_E2E: skip,
        CONTROL_DB: '0',
        VALIDATE_LOG: join(dir, 'log'),
      },
    })
    expect(result.status).toBe(failBuild || failTypes ? 1 : 0)
    const expected = [
      'run typecheck',
      'run lint',
      'prettier --check .',
      'test',
      'run build',
      'run build:host',
      'run build:control',
      'run web:build',
    ]
    if (skip !== '1')
      expected.push('run test:e2e -- --reporter=dot', 'run test:e2e:web -- --reporter=dot')
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(expected)
    expect(result.stderr).toContain(
      failTypes ? 'FAILED: typecheck' : failBuild ? 'FAILED: build' : 'all green',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it.each([
  { desktop: true, web: true, skip: '0' },
  { desktop: false, web: false, skip: '0' },
  { desktop: true, web: true, skip: '1' },
])('--pr runs the CI checks and only the changed e2e specs: %j', ({ desktop, web, skip }) => {
  const dir = mkdtempSync(join(tmpdir(), 'validator-pr-'))
  try {
    const calls = join(dir, 'calls')
    const command = `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CALLS"\n`
    for (const name of ['npm', 'npx', 'node']) {
      writeFileSync(join(dir, name), command)
      chmodSync(join(dir, name), 0o755)
    }
    // A changed spec, a deleted one (skipped) and an untracked one, per suite.
    writeFileSync(
      join(dir, 'git'),
      `#!/bin/sh
case "$1 $5" in
  "diff apps/desktop/e2e/*.spec.ts") ${desktop ? "printf 'apps/desktop/e2e/smoke.spec.ts\\napps/desktop/e2e/gone.spec.ts\\n'" : ':'} ;;
  "diff apps/web/e2e/*.spec.ts") ${web ? "printf 'apps/web/e2e/icons.spec.ts\\n'" : ':'} ;;
esac
case "$1 $5" in
  "ls-files apps/desktop/e2e/*.spec.ts") ${desktop ? "printf 'apps/desktop/e2e/brain.spec.ts\\n'" : ':'} ;;
esac
`,
    )
    chmodSync(join(dir, 'git'), 0o755)
    const result = spawnSync('bash', [resolve(import.meta.dirname, 'validate.sh'), '--pr'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        CALLS: calls,
        SKIP_E2E: skip,
        VALIDATE_BASE: 'base',
        VALIDATE_LOG: join(dir, 'log'),
      },
    })
    expect(result.status, result.stderr).toBe(0)
    const expected = [
      'run typecheck',
      'run lint',
      'prettier --check .',
      'tools/scripts/size-budget.mjs check',
      'test',
    ]
    if (desktop && skip !== '1')
      expected.push('run test:e2e -- --reporter=dot brain.spec.ts smoke.spec.ts')
    if (web && skip !== '1') expected.push('run test:e2e:web -- --reporter=dot icons.spec.ts')
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(expected)
    expect(result.stderr).toContain('all green')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
