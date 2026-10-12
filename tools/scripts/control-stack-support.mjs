import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { URL } from 'node:url'
/* global fetch, AbortSignal */
const root = resolve(import.meta.dirname, '../..')
const project = 'phosphor-control-test'
const container = `${project}-fake-github`
const github = 'http://127.0.0.1:54353'

/** Run a command; its output is returned, never printed (status carries test keys). */
function run(program, args) {
  const result = spawnSync(program, args, { cwd: root, encoding: 'utf8', timeout: 300_000 })
  if (result.error || result.status !== 0) {
    // CLI diagnostics may contain environment values. Never forward them.
    throw new Error(`${program} ${args.slice(0, 2).join(' ')} failed`)
  }
  return result.stdout
}

export function removeFake() {
  // Only this exact name: never another stack's containers. Bounded like every
  // other command here, so a stuck Docker cannot hang the cleanup. A missing
  // container is the usual case and not worth a word; a timeout is.
  const result = spawnSync('docker', ['rm', '--force', container], {
    stdio: 'ignore',
    timeout: 60_000,
  })
  if (result.error)
    console.error(`auth-stack: could not remove ${container}: ${result.error.message}`)
}

export function localStack() {
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
  if (!env.SECRET_KEY?.startsWith('sb_secret_')) throw new Error('No local secret key')
  if (new URL(env.API_URL).port !== '54351') throw new Error('Refusing a different local stack')
  return { url: new URL(env.API_URL).origin, key: env.PUBLISHABLE_KEY, secret: env.SECRET_KEY }
}

export async function startFake(signal, refuseRunning = false) {
  if (refuseRunning) {
    const running = spawnSync('docker', ['inspect', '--format', '{{.State.Running}}', container], {
      encoding: 'utf8',
      timeout: 60_000,
    })
    if (running.error) throw new Error('Could not check the fake GitHub container')
    if (running.status === 0 && running.stdout.trim() === 'true')
      throw new Error('Fake GitHub is already running; run stack tests sequentially')
  }
  removeFake()
  let started = false
  try {
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
    started = true
    for (let attempt = 0; attempt < 80; attempt++) {
      signal.throwIfAborted()
      try {
        if ((await fetch(`${github}/__health`, { signal: AbortSignal.timeout(1000) })).ok) return
      } catch {
        // Not listening yet.
      }
      await new Promise((done) => setTimeout(done, 250))
    }
    throw new Error('The fake GitHub did not start')
  } catch (error) {
    if (started) removeFake()
    throw error
  }
}
