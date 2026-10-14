import { execFile } from 'node:child_process'
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
    let ready!: () => void
    const isReady = new Promise<void>((resolve) => (ready = resolve))
    let exited!: Promise<NodeJS.Signals | null>
    const start = Date.now()
    const result = readTailscaleStatus(true, (done) => {
      const child = execFile(file, ['status', '--json'], TAILSCALE_OPTIONS, (error, stdout) =>
        done(error, stdout),
      )
      pid = child.pid
      child.stderr?.on('data', (chunk: Buffer | string) => {
        if (String(chunk).includes('ready')) ready()
      })
      exited = new Promise((resolve) => child.once('exit', (_code, signal) => resolve(signal)))
      return () => {
        child.kill(TAILSCALE_OPTIONS.killSignal)
      }
    })
    await isReady
    // Prove the fixture really ignores SIGTERM, so only SIGKILL can end it.
    process.kill(pid!, 'SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(() => process.kill(pid!, 0)).not.toThrow()
    expect(await result).toEqual({ code: 'check-failed', discovery: true, peers: [] })
    expect(Date.now() - start).toBeGreaterThanOrEqual(TAILSCALE_OPTIONS.timeout - 100)
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
