#!/usr/bin/env node
// Desktop's sign-in against a real Supabase Auth: the local control stack
// (`npm run db:start`) with GitHub played by supabase/tests/fixtures/fake-github.cjs.
//
// Starts the fake on the stack's Docker network, runs the account stack test
// with the stack's address and publishable key, and removes only its own
// container. A run that passes without running every test is a failure: the
// test skips itself when it is not given a stack. The test runs in a process
// group of its own with a deadline, and SIGINT/SIGTERM kill it, so the
// container is removed even when the test hangs or the job is cancelled.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runGroup } from './process-group.mjs'
import { localStack, startFake, removeFake } from './control-stack-support.mjs'
/* global AbortController */

const root = resolve(import.meta.dirname, '../..')
const github = 'http://127.0.0.1:54353'
const test = 'apps/desktop/electron/account/stack.test.ts'
const vitest = join(root, 'node_modules/vitest/vitest.mjs')
const TEST_MS = 180_000

const cancel = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM']) {
  // Nothing below blocks for long, so this always gets to run; the finally
  // block then removes the container.
  process.on(signal, () => cancel.abort(new Error(`cancelled by ${signal}`)))
}

const out = mkdtempSync(join(tmpdir(), 'phosphor-auth-stack-'))
let failure = null
try {
  const stack = localStack()
  cancel.signal.throwIfAborted()
  await startFake(cancel.signal)
  const report = join(out, 'report.json')
  const code = await runGroup(
    process.execPath,
    [vitest, 'run', test, '--reporter=default', '--reporter=json', `--outputFile.json=${report}`],
    {
      cwd: root,
      timeoutMs: TEST_MS,
      signal: cancel.signal,
      env: {
        ...process.env,
        PHOSPHOR_AUTH_STACK_URL: stack.url,
        PHOSPHOR_AUTH_STACK_KEY: stack.key,
        PHOSPHOR_AUTH_STACK_GITHUB: github,
      },
    },
  )
  cancel.signal.throwIfAborted()
  if (code === null) throw new Error(`the stack tests were killed, or ran past ${TEST_MS / 1000} s`)
  const summary = JSON.parse(readFileSync(report, 'utf8'))
  const { numTotalTests: total, numPassedTests: passed } = summary
  if (code !== 0 || total === 0 || passed !== total) {
    failure = `${passed} of ${total} stack tests passed (vitest exit ${code})`
  } else {
    console.log(`auth-stack: ${passed} of ${total} passed against ${stack.url}`)
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error)
} finally {
  removeFake()
  rmSync(out, { recursive: true, force: true })
}
if (failure) {
  console.error(`auth-stack: ${failure}`)
  process.exit(cancel.signal.aborted ? 130 : 1)
}
