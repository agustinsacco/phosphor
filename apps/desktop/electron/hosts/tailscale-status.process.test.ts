import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readTailscaleStatus, TAILSCALE_OPTIONS } from './tailscale-status'

it('kills a real SIGTERM-resistant executable and settles at the deadline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tailscale-timeout-'))
  const file = join(dir, 'tailscale')
  let pid: number | undefined
  let exited: Promise<unknown> | undefined
  try {
    await writeFile(
      file,
      `#!${process.execPath}\nprocess.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\n`,
      { mode: 0o755 },
    )
    const start = Date.now()
    const result = await readTailscaleStatus(true, (done) => {
      const child = execFile(file, ['status', '--json'], TAILSCALE_OPTIONS, (error, stdout) =>
        done(error, stdout),
      )
      pid = child.pid
      exited = new Promise((resolve) => child.once('exit', resolve))
      return () => {
        child.kill(TAILSCALE_OPTIONS.killSignal)
      }
    })
    expect(result).toEqual({ code: 'check-failed', discovery: true, peers: [] })
    expect(Date.now() - start).toBeGreaterThanOrEqual(4900)
    expect(Date.now() - start).toBeLessThan(6500)
    await Promise.race([
      exited,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('child survived deadline')), 500),
      ),
    ])
    expect(() => process.kill(pid!, 0)).toThrow()
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
}, 8000)

it('settles even when the runner never closes its output', async () => {
  const start = Date.now()
  expect(await readTailscaleStatus(false, () => undefined)).toEqual({
    code: 'check-failed',
    discovery: false,
    peers: [],
  })
  expect(Date.now() - start).toBeLessThan(6500)
}, 8000)
