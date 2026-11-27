/**
 * Runs a fixture as a separate Host process: esbuild bundles it once, each child takes one
 * command per stdin line and answers one JSON line each. Children are killed on `stopAll`.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

export type Report = Record<string, unknown>

export interface LineProcess {
  readonly child: ChildProcessWithoutNullStreams
  /** Writes one command line and resolves with the next JSON line the child prints. */
  send(command: string): Promise<Report>
  /** The next JSON line, without writing a command. */
  next(): Promise<Report>
  /** SIGKILL, so nothing the child holds is cleaned up. */
  kill(): Promise<void>
}

const HOST = resolve(import.meta.dirname, '../../..')

export async function bundleFixture(entry: string): Promise<string> {
  const output = await build({
    absWorkingDir: HOST,
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    write: false,
    tsconfig: join(HOST, 'tsconfig.json'),
    banner: {
      js: "import { createRequire } from 'node:module';const require = createRequire(import.meta.url);",
    },
  })
  return output.outputFiles[0]!.text
}

const children: ChildProcessWithoutNullStreams[] = []

export function stopAll(): void {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL')
}

export function startLineProcess(bundle: string, args: readonly string[]): LineProcess {
  const directory = mkdtempSync(join(tmpdir(), 'host-line-process-'))
  const entry = join(directory, 'fixture.mjs')
  const cleanup = () => rmSync(directory, { recursive: true, force: true })
  let child: ChildProcessWithoutNullStreams
  try {
    writeFileSync(entry, bundle, { mode: 0o600 })
    child = spawn(process.execPath, ['--no-warnings', entry, ...args], { stdio: 'pipe', cwd: HOST })
  } catch (error) {
    cleanup()
    throw error
  }
  child.once('close', cleanup)
  children.push(child)
  const waiting: ((line: string) => void)[] = []
  const lines: string[] = []
  let buffered = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk
    for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
      const line = buffered.slice(0, end)
      buffered = buffered.slice(end + 1)
      const waiter = waiting.shift()
      if (waiter) waiter(line)
      else lines.push(line)
    }
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => (stderr += chunk))
  const next = () =>
    new Promise<Report>((resolveReport, reject) => {
      const queued = lines.shift()
      if (queued !== undefined) return resolveReport(JSON.parse(queued) as Report)
      const exited = () => reject(new Error(`fixture process exited: ${stderr}`))
      child.once('exit', exited)
      waiting.push((line) => {
        child.off('exit', exited)
        resolveReport(JSON.parse(line) as Report)
      })
    })
  return {
    child,
    next,
    send(command) {
      const answer = next()
      child.stdin.write(command + '\n')
      return answer
    },
    async kill() {
      if (child.exitCode !== null) return
      const exited = new Promise((done) => child.once('exit', done))
      child.kill('SIGKILL')
      await exited
    },
  }
}
