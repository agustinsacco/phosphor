#!/usr/bin/env node
// Desktop's sign-in against a real Supabase Auth: the local control stack
// (`npm run db:start`) with GitHub played by supabase/tests/fixtures/fake-github.cjs.
//
// Starts the fake on the stack's Docker network, runs the account stack test
// with the stack's address and publishable key, and removes only its own
// container. A run that passes without running every test is a failure: the
// test skips itself when it is not given a stack.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { URL } from 'node:url'
/* global fetch, AbortSignal */

const root = resolve(import.meta.dirname, '../..')
const project = 'phosphor-control-test'
const container = `${project}-fake-github`
const github = 'http://127.0.0.1:54353'
const test = 'apps/desktop/electron/account/stack.test.ts'

/** Run a command; its output is returned, never printed (status carries test keys). */
function run(program, args) {
  const result = spawnSync(program, args, { cwd: root, encoding: 'utf8', timeout: 300_000 })
  if (result.error || result.status !== 0) {
    const why = (result.stderr || result.error?.message || '').trim().slice(-600)
    throw new Error(`${program} ${args.slice(0, 2).join(' ')} failed: ${why}`)
  }
  return result.stdout
}

function removeFake() {
  // Only this exact name: never another stack's containers.
  spawnSync('docker', ['rm', '--force', container], { stdio: 'ignore' })
}

function localStack() {
  const env = {}
  const status = run('npx', ['--yes', 'supabase@2.119.0', 'status', '--output', 'env'])
  for (const line of status.split('\n')) {
    const match = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim())
    if (match) env[match[1]] = match[2]
  }
  if (!env.API_URL || !env.PUBLISHABLE_KEY) throw new Error('No local stack: npm run db:start')
  if (new URL(env.API_URL).hostname !== '127.0.0.1') {
    throw new Error(`Refusing a stack that is not local: ${new URL(env.API_URL).origin}`)
  }
  return { url: new URL(env.API_URL).origin, key: env.PUBLISHABLE_KEY }
}

async function startFake() {
  removeFake()
  const fixture = join(root, 'supabase/tests/fixtures/fake-github.cjs')
  run('docker', [
    'run',
    '--detach',
    '--name',
    container,
    '--network',
    `supabase_network_${project}`,
    '--network-alias',
    'fake-github',
    '--publish',
    '127.0.0.1:54353:54353',
    '--mount',
    `type=bind,src=${fixture},dst=/fake-github.cjs,readonly`,
    'node:22-alpine',
    'node',
    '/fake-github.cjs',
  ])
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      if ((await fetch(`${github}/__health`, { signal: AbortSignal.timeout(1000) })).ok) return
    } catch {
      // Not listening yet.
    }
    await new Promise((done) => setTimeout(done, 250))
  }
  throw new Error('The fake GitHub did not start')
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    removeFake()
    process.exit(130)
  })
}

const out = mkdtempSync(join(tmpdir(), 'phosphor-auth-stack-'))
let failure = null
try {
  const stack = localStack()
  await startFake()
  const report = join(out, 'report.json')
  const vitest = spawnSync(
    'npx',
    ['vitest', 'run', test, '--reporter=default', '--reporter=json', `--outputFile.json=${report}`],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        PHOSPHOR_AUTH_STACK_URL: stack.url,
        PHOSPHOR_AUTH_STACK_KEY: stack.key,
        PHOSPHOR_AUTH_STACK_GITHUB: github,
      },
    },
  )
  const summary = JSON.parse(readFileSync(report, 'utf8'))
  const { numTotalTests: total, numPassedTests: passed } = summary
  if (vitest.status !== 0 || total === 0 || passed !== total) {
    failure = `${passed} of ${total} stack tests passed (vitest exit ${vitest.status})`
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
  process.exit(1)
}
