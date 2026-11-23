import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { OWNER_LOCK_FILE } from '@phosphor/shared/host-local'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import { acquireOwnerLock, ownerLockPorts, readOwnerLock } from './owner-lock'
import { readProcessStart } from './process-start'
import { OwnerLockBusy, type OwnerLockRecord } from './types'

// Two real processes on one temporary agent folder, with the default ports:
// process.kill(pid, 0) and the process start time from ps or /proc.

type Report =
  | { acquired: OwnerLockRecord }
  | { busy: OwnerLockRecord }
  | { unavailable: string }
  | { released: true }
  | { error: string }

interface Holder {
  child: ChildProcessWithoutNullStreams
  next(): Promise<Report>
}

let bundle: string
let agentDir: string
const children: ChildProcessWithoutNullStreams[] = []

beforeAll(async () => {
  const library = resolve(import.meta.dirname, '../..')
  const output = await build({
    absWorkingDir: library,
    entryPoints: [join(import.meta.dirname, '__fixtures__/owner-lock-holder.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    tsconfig: join(library, 'tsconfig.json'),
  })
  bundle = output.outputFiles[0]!.text
})
beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'owner-lock-processes-'))
  await chmod(agentDir, 0o755)
})
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL')
  await rm(agentDir, { recursive: true, force: true })
})
afterAll(() => {
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
})

function startHolder(owner: 'desktop' | 'daemon'): Holder {
  const child = spawn(process.execPath, ['--input-type=module', '-e', bundle, agentDir, owner], {
    stdio: 'pipe',
  })
  children.push(child)
  const lines: string[] = []
  const waiting: ((line: string) => void)[] = []
  let buffered = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk
    for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
      const line = buffered.slice(0, end)
      buffered = buffered.slice(end + 1)
      const resolveLine = waiting.shift()
      if (resolveLine) resolveLine(line)
      else lines.push(line)
    }
  })
  return {
    child,
    next: () =>
      new Promise<Report>((resolveReport, reject) => {
        const settle = (line: string) => resolveReport(JSON.parse(line) as Report)
        const line = lines.shift()
        if (line !== undefined) return settle(line)
        waiting.push(settle)
        child.once('exit', (code) => reject(new Error(`holder exited ${code} without a report`)))
      }),
  }
}

const exited = (child: ChildProcessWithoutNullStreams) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((done) => child.once('exit', () => done()))

const pidOf = (holder: Holder) => holder.child.pid

it('a second process cannot acquire while the first holds the lock, and can once it releases', async () => {
  const first = startHolder('desktop')
  expect(await first.next()).toMatchObject({ acquired: { owner: 'desktop', pid: pidOf(first) } })
  const second = startHolder('daemon')
  expect(await second.next()).toMatchObject({ busy: { owner: 'desktop', pid: pidOf(first) } })
  await expect(acquireOwnerLock(agentDir, 'daemon')).rejects.toBeInstanceOf(OwnerLockBusy)
  first.child.stdin.end()
  expect(await first.next()).toEqual({ released: true })
  expect(await readdir(agentDir)).toEqual([])
  const third = startHolder('daemon')
  expect(await third.next()).toMatchObject({ acquired: { owner: 'daemon', pid: pidOf(third) } })
  third.child.stdin.end()
  expect(await third.next()).toEqual({ released: true })
}, 30_000)

it('reclaims the lock of a holder that was killed', async () => {
  const first = startHolder('daemon')
  expect(await first.next()).toMatchObject({ acquired: { pid: pidOf(first) } })
  first.child.kill('SIGKILL')
  await exited(first.child)
  expect(await readOwnerLock(agentDir)).toMatchObject({ pid: pidOf(first) })
  const second = startHolder('desktop')
  expect(await second.next()).toMatchObject({ acquired: { owner: 'desktop', pid: pidOf(second) } })
  second.child.stdin.end()
  expect(await second.next()).toEqual({ released: true })
}, 30_000)

it('reclaims a live pid that started at another time, and never one that started at the same time', async () => {
  const start = await readProcessStart(process.pid)
  if (process.platform === 'darwin' || process.platform === 'linux') expect(start).not.toBeNull()
  const record = (processStart: string | null) =>
    JSON.stringify({
      version: 1,
      owner: 'daemon',
      pid: process.pid,
      processStart,
      token: 'a'.repeat(64),
      startedAt: '2026-11-22T22:00:00.000Z',
      program: 'phosphor',
    }) + '\n'
  await writeFile(join(agentDir, OWNER_LOCK_FILE), record(start), { mode: 0o600 })
  const refused = startHolder('desktop')
  expect(await refused.next()).toMatchObject({ busy: { pid: process.pid, processStart: start } })
  await writeFile(join(agentDir, OWNER_LOCK_FILE), record('darwin:Thu Jan 1 00:00:00 1970'), {
    mode: 0o600,
  })
  const reclaimer = startHolder('desktop')
  expect(await reclaimer.next()).toMatchObject({ acquired: { pid: pidOf(reclaimer) } })
  reclaimer.child.stdin.end()
  expect(await reclaimer.next()).toEqual({ released: true })
}, 30_000)

it('two processes racing for a free lock: exactly one wins', async () => {
  for (let round = 0; round < 3; round++) {
    const racers = [startHolder('desktop'), startHolder('daemon')]
    const reports = await Promise.all(racers.map((racer) => racer.next()))
    const winners = reports.filter((report) => 'acquired' in report)
    expect(winners).toHaveLength(1)
    for (const report of reports)
      if (!('acquired' in report)) expect(report).toMatchObject({ busy: expect.any(Object) })
    expect(await readOwnerLock(agentDir)).toEqual(
      (winners[0] as { acquired: OwnerLockRecord }).acquired,
    )
    for (const racer of racers) racer.child.stdin.end()
    await Promise.all(racers.map((racer) => exited(racer.child)))
    expect(await readdir(agentDir)).toEqual([])
  }
}, 60_000)

it('the default ports read this process as alive with a stable start time', async () => {
  expect(ownerLockPorts.pid).toBe(process.pid)
  expect(ownerLockPorts.isAlive(process.pid)).toBe(true)
  expect(await ownerLockPorts.processStart(process.pid)).toBe(await readProcessStart(process.pid))
})
