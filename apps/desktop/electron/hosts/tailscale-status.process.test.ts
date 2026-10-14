import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { readTailscaleStatus, TAILSCALE_OPTIONS } from './tailscale-status'

afterEach(() => {
  vi.useRealTimers()
})

it('settles at exactly the deadline and cancels the runner once, even if it never reports', async () => {
  vi.useFakeTimers()
  const cancel = vi.fn()
  let settled: unknown
  const pending = readTailscaleStatus(false, () => cancel).then((value) => (settled = value))
  await vi.advanceTimersByTimeAsync(TAILSCALE_OPTIONS.timeout - 1)
  expect(settled).toBeUndefined()
  expect(cancel).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  await pending
  expect(settled).toEqual({ code: 'check-failed', discovery: false, peers: [] })
  expect(cancel).toHaveBeenCalledTimes(1)
})

it('kills a real SIGTERM-resistant executable with SIGKILL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tailscale-timeout-'))
  const file = join(dir, 'tailscale')
  let pid: number | undefined
  try {
    // The fixture announces readiness only after its SIGTERM handler is installed.
    await writeFile(
      file,
      `#!${process.execPath}\nprocess.on('SIGTERM', () => {}); process.stderr.write('ready\\n'); setInterval(() => {}, 1000)\n`,
      { mode: 0o755 },
    )
    // Start the child with no deadline of its own, and finish every precondition before the
    // deadline under test is armed, so a slow machine cannot fail a correct implementation.
    const child = spawn(file, ['status', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] })
    pid = child.pid
    const exited = new Promise<NodeJS.Signals | null>((resolve) =>
      child.once('exit', (_code, signal) => resolve(signal)),
    )
    await new Promise<void>((resolve) =>
      child.stderr.on('data', (chunk: Buffer) => {
        if (String(chunk).includes('ready')) resolve()
      }),
    )
    // Prove the fixture really ignores SIGTERM, so only SIGKILL can end it.
    child.kill('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(child.exitCode).toBeNull()
    expect(child.signalCode).toBeNull()
    const result = await readTailscaleStatus(true, (done) => {
      child.once('exit', () => done({ code: 'killed' }, ''))
      return () => {
        child.kill(TAILSCALE_OPTIONS.killSignal)
      }
    })
    expect(result).toEqual({ code: 'check-failed', discovery: true, peers: [] })
    expect(await exited).toBe('SIGKILL')
  } finally {
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already reaped */
      }
    }
    await rm(dir, { recursive: true, force: true })
  }
}, 30_000)
