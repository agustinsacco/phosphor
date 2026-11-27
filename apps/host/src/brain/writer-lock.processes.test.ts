import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'

// Two Host processes with different configs (so different identity run locks) on one state
// folder: each builds its own `createHostBrain`, so only a cross-process writer lock keeps a
// second one from opening, recovering or writing the same `<state>/brain`.

type Report = Record<string, unknown>

interface BrainProcess {
  child: ChildProcessWithoutNullStreams
  send(command: 'enable' | 'status' | 'dispose'): Promise<Report>
}

let bundle: string
let stateDirectory: string
const children: ChildProcessWithoutNullStreams[] = []

beforeAll(async () => {
  const host = resolve(import.meta.dirname, '../..')
  const output = await build({
    absWorkingDir: host,
    entryPoints: [join(import.meta.dirname, '__fixtures__/brain-writer-process.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    write: false,
    tsconfig: join(host, 'tsconfig.json'),
    banner: {
      js: "import { createRequire } from 'node:module';const require = createRequire(import.meta.url);",
    },
  })
  bundle = output.outputFiles[0]!.text
}, 60_000)
beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'host-brain-writer-'))
})
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL')
  await rm(stateDirectory, { recursive: true, force: true })
})
afterAll(() => {
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
})

function startBrain(config: string): BrainProcess {
  const child = spawn(
    process.execPath,
    ['--no-warnings', '--input-type=module', '-e', bundle, stateDirectory, config],
    { stdio: 'pipe', cwd: resolve(import.meta.dirname, '../..') },
  )
  children.push(child)
  const waiting: ((line: string) => void)[] = []
  let buffered = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk
    for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
      const line = buffered.slice(0, end)
      buffered = buffered.slice(end + 1)
      waiting.shift()?.(line)
    }
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => (stderr += chunk))
  return {
    child,
    send: (command) =>
      new Promise<Report>((resolveReport, reject) => {
        const exited = () => reject(new Error(`brain process exited: ${stderr}`))
        child.once('exit', exited)
        waiting.push((line) => {
          child.off('exit', exited)
          resolveReport(JSON.parse(line) as Report)
        })
        child.stdin.write(command + '\n')
      }),
  }
}

async function kill(brain: BrainProcess): Promise<void> {
  const exited = new Promise((done) => brain.child.once('exit', done))
  brain.child.kill('SIGKILL')
  await exited
}

it('never creates a Brain while a fresh Host only reads its status', async () => {
  const reader = startBrain('config-a')
  expect(await reader.send('status')).toMatchObject({ state: 'off', service: false, exists: false })
  expect(existsSync(join(stateDirectory, 'brain'))).toBe(false)
})

it('admits one Brain writer across Host processes, releases a killed one and refuses a restart', async () => {
  const first = startBrain('config-a')
  const second = startBrain('config-b')
  expect(await first.send('enable')).toMatchObject({ enabled: true, state: 'ready' })

  expect(await second.send('enable')).toMatchObject({
    refused: 'Brain is open elsewhere on this Host.',
    state: 'refused',
  })
  expect(await second.send('status')).toMatchObject({ state: 'refused', service: false })

  // A writer killed without cleanup leaves its lock behind; the next writer reclaims it.
  await kill(first)
  expect(await second.send('enable')).toMatchObject({ enabled: true, state: 'ready' })

  // A restarted Host process is a second writer now, so it is refused until the holder disposes.
  const restarted = startBrain('config-a')
  expect(await restarted.send('status')).toMatchObject({ state: 'refused', service: false })
  expect(await restarted.send('enable')).toMatchObject({ state: 'refused' })
  expect(await second.send('dispose')).toMatchObject({ disposed: true })
  expect(await restarted.send('enable')).toMatchObject({ enabled: true, state: 'ready' })
}, 60_000)
