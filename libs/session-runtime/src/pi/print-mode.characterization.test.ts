import type * as ChildProcessModule from 'node:child_process'
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runPrintMode } from '../../../../apps/desktop/electron/pi/print-mode'

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof ChildProcessModule>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

let child: ChildProcess & { stdout: PassThrough; stderr: PassThrough }

beforeEach(() => {
  child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 7654321,
    kill: vi.fn(),
    exitCode: null,
    signalCode: null,
  }) as unknown as typeof child
  vi.mocked(spawn).mockReset().mockReturnValue(child)
  vi.spyOn(process, 'kill').mockReturnValue(true)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const desktop = (timeoutMs = 5_000, signal?: AbortSignal) =>
  runPrintMode(process.execPath, [], { cwd: process.cwd(), env: {}, timeoutMs, signal })

describe('original print transport contracts', () => {
  it('Desktop completes a real child only after stdin EOF', async () => {
    const actual = await vi.importActual<typeof ChildProcessModule>('node:child_process')
    vi.mocked(spawn).mockImplementationOnce(actual.spawn)
    const args = [
      '-e',
      "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('EOF title\\n'))",
    ]
    const result = await runPrintMode(process.execPath, args, {
      cwd: process.cwd(),
      env: {},
      timeoutMs: 5_000,
    })
    expect(result).toEqual({ stdout: 'EOF title\n' })
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      args,
      expect.objectContaining({
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    )
  })

  it('Desktop retains partial stdout on timeout', async () => {
    vi.useFakeTimers()
    const pending = desktop(25)
    child.stdout.write('partial')
    await vi.advanceTimersByTimeAsync(25)
    expect(await pending).toEqual({ stdout: 'partial', error: 'timed out after 25ms' })
  })

  it('Desktop drains final stdout after exit, before close', async () => {
    const pending = desktop()
    let settled = false
    void pending.then(() => {
      settled = true
    })
    child.emit('exit', 0)
    await Promise.resolve()
    expect(settled).toBe(false)
    child.stdout.write('Final title\n')
    child.emit('close', 0)
    expect(await pending).toEqual({ stdout: 'Final title\n' })
  })

  it.skipIf(process.platform === 'win32')(
    'Desktop cancellation kills its process group',
    async () => {
      const controller = new AbortController()
      const pending = desktop(5_000, controller.signal)
      child.stdout.write('partial')
      controller.abort()
      expect(await pending).toEqual({ stdout: 'partial', error: 'aborted' })
      expect(process.kill).toHaveBeenCalledWith(-7654321, 'SIGKILL')
    },
  )
})
