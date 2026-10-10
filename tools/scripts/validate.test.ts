import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it.each([
  { skip: '1', failBuild: false },
  { skip: '0', failBuild: false },
  { skip: '1', failBuild: true },
])('validator always builds and propagates failure: %j', ({ skip, failBuild }) => {
  const dir = mkdtempSync(join(tmpdir(), 'validator-'))
  try {
    const calls = join(dir, 'calls')
    const command = `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CALLS"\nif [ "$FAIL_BUILD" = "1" ] && [ "$*" = "run build" ]; then exit 1; fi\n`
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
        FAIL_BUILD: failBuild ? '1' : '0',
        SKIP_E2E: skip,
        CONTROL_DB: '0',
        VALIDATE_LOG: join(dir, 'log'),
      },
    })
    expect(result.status).toBe(failBuild ? 1 : 0)
    const expected = [
      'run typecheck',
      'run typecheck:host',
      'run lint',
      'prettier --check .',
      'test',
      'run build',
      'run build:host',
    ]
    if (skip !== '1') expected.push('run test:e2e -- --reporter=dot')
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(expected)
    expect(result.stderr).toContain(failBuild ? 'FAILED: build' : 'all green')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
