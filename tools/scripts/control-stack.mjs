#!/usr/bin/env node
// Real enrollment, machine ownership and Host traffic on the isolated local stack.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runGroup } from './process-group.mjs'
import { localStack, startFake, removeFake } from './control-stack-support.mjs'
/* global AbortController */

const root = resolve(import.meta.dirname, '../..')
const github = 'http://127.0.0.1:54353'
const test = 'apps/control/src/routes/stack.test.ts'
const vitest = join(root, 'node_modules/vitest/vitest.mjs')
const TEST_MS = 180_000

const cancel = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM']) {
  // Nothing below blocks for long, so this always gets to run; the finally
  // block then removes the container.
  process.on(signal, () => cancel.abort(new Error(`cancelled by ${signal}`)))
}

let ownsFake = false
const out = mkdtempSync(join(tmpdir(), 'phosphor-control-stack-'))
let failure = null
try {
  const stack = localStack()
  cancel.signal.throwIfAborted()
  await startFake(cancel.signal, true)
  ownsFake = true
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
        PHOSPHOR_CONTROL_STACK_SECRET: stack.secret,
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
    console.log(`control-stack: ${passed} of ${total} passed against ${stack.url}`)
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error)
} finally {
  if (ownsFake) removeFake()
  rmSync(out, { recursive: true, force: true })
}
if (failure) {
  console.error(`control-stack: ${failure}`)
  process.exit(cancel.signal.aborted ? 130 : 1)
}
