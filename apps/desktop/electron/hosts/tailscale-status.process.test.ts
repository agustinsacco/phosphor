import { spawn } from 'node:child_process'
import type { Readable } from 'node:stream'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { readTailscaleStatus, TAILSCALE_OPTIONS } from './tailscale-status'

// Cleanup lives in afterEach, not finally: vitest runs hooks after a timed-out test, but never
// unwinds the timed-out async body, so a finally block there would leak the child.
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  vi.useRealTimers()
  // Every cleanup runs even if an earlier one fails; the first failure is reported afterwards.
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw failures[0]
})

/** Bound a wait that only a broken implementation can exceed, and fail with a clear message. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function stderrMessage(stderr: Readable, message: string): Promise<void> {
  return new Promise((resolve) => {
    let output = ''
    const onData = (chunk: Buffer) => {
      output += String(chunk)
      if (!output.includes(message)) return
      stderr.off('data', onData)
      resolve()
    }
    stderr.on('data', onData)
  })
}

it('settles at exactly the deadline and cancels the runner once, even if it never reports', async () => {
  vi.useFakeTimers()
  const cancel = vi.fn()
  let settled: unknown
  const pending = readTailscaleStatus(() => cancel).then((value) => (settled = value))
  await vi.advanceTimersByTimeAsync(TAILSCALE_OPTIONS.timeout - 1)
  expect(settled).toBeUndefined()
  expect(cancel).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  await pending
  expect(settled).toEqual({ code: 'check-failed' })
  expect(cancel).toHaveBeenCalledTimes(1)
})

it('kills a real SIGTERM-resistant executable with SIGKILL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tailscale-timeout-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'tailscale')
  // The fixture announces readiness only after its SIGTERM handler is installed.
  await writeFile(
    file,
    `#!${process.execPath}\nprocess.on('SIGTERM', () => process.stderr.write('sigterm-handled\\n')); process.stderr.write('ready\\n'); setInterval(() => {}, 1000)\n`,
    { mode: 0o755 },
  )
  // Start the child with no deadline of its own, and finish every precondition before the
  // deadline under test is armed, so a slow machine cannot fail a correct implementation.
  const child = spawn(file, ['status', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = new Promise<NodeJS.Signals | null>((resolve) =>
    child.once('exit', (_code, signal) => resolve(signal)),
  )
  // A spawn failure emits 'error' and never 'exit'; surface it instead of waiting forever.
  const spawnFailed = new Promise<never>((_, reject) => child.once('error', reject))
  spawnFailed.catch(() => undefined)
  cleanups.push(async () => {
    if (child.pid === undefined) return
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await within(exited, 5_000, 'fixture exit during cleanup')
  })
  await within(
    Promise.race([spawnFailed, stderrMessage(child.stderr, 'ready\n')]),
    20_000,
    'fixture readiness',
  )
  // Prove the fixture really ignores SIGTERM, so only SIGKILL can end it.
  const handled = stderrMessage(child.stderr, 'sigterm-handled\n')
  child.kill('SIGTERM')
  await within(Promise.race([spawnFailed, handled]), 5_000, 'fixture SIGTERM acknowledgement')
  expect(child.exitCode).toBeNull()
  expect(child.signalCode).toBeNull()
  const result = await readTailscaleStatus((done) => {
    child.once('exit', () => done({ code: 'killed' }, ''))
    return () => {
      child.kill(TAILSCALE_OPTIONS.killSignal)
    }
  })
  expect(result).toEqual({ code: 'check-failed' })
  expect(await within(exited, 10_000, 'child exit after the deadline')).toBe('SIGKILL')
}, 45_000)
