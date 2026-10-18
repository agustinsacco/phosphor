import type * as ChildProcessModule from 'node:child_process'
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runPrintMode, type PrintModeOptions } from './print-mode'

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof ChildProcessModule>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

let child: ChildProcess & { stdout: PassThrough }
beforeEach(() => {
  child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    pid: 7654321,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(),
  }) as unknown as typeof child
  vi.mocked(spawn).mockReset().mockReturnValue(child)
  vi.spyOn(process, 'kill').mockReturnValue(true)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const run = (options: Partial<PrintModeOptions> = {}, args: string[] = []) =>
  runPrintMode(process.execPath, args, {
    cwd: process.cwd(),
    env: {},
    timeoutMs: 5_000,
    stderr: 'ignore',
    maxOutputBytes: 4096,
    overflow: 'fail',
    ...options,
  })

it('accepts exactly 4096 bytes with stderr ignored and an explicit caller environment', async () => {
  const pending = run({ env: { ONE_SHOT: 'caller-owned' } })
  child.stdout.write('é'.repeat(2048))
  child.emit('close', 0)
  expect(await pending).toEqual({ stdout: 'é'.repeat(2048) })
  expect(spawn).toHaveBeenCalledWith(
    process.execPath,
    [],
    expect.objectContaining({
      env: { ONE_SHOT: 'caller-owned' },
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: process.platform !== 'win32',
    }),
  )
})

it('hard-fails a multibyte overflow before close and ignores later completion', async () => {
  const pending = run()
  child.stdout.write('é'.repeat(2048))
  child.stdout.write('x')
  expect(await pending).toEqual({
    stdout: '',
    error: 'stdout exceeded 4096 bytes',
    reason: 'overflow',
  })
  child.emit('close', 0)
  child.emit('error', new Error('late'))
  if (process.platform !== 'win32')
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(-7654321, 'SIGKILL')
})

it('exposes a timeout reason so the Host can reject partial output', async () => {
  vi.useFakeTimers()
  const pending = run({ timeoutMs: 25 })
  child.stdout.write('partial')
  await vi.advanceTimersByTimeAsync(25)
  expect(await pending).toEqual({
    stdout: 'partial',
    error: 'timed out after 25ms',
    reason: 'timeout',
  })
})

it('does not spawn for an already aborted signal', async () => {
  const controller = new AbortController()
  controller.abort()
  expect(await run({ signal: controller.signal })).toEqual({
    stdout: '',
    error: 'aborted',
    reason: 'aborted',
  })
  expect(spawn).not.toHaveBeenCalled()
})

it('aborts after spawn and removes its listener without streaming after completion', async () => {
  const controller = new AbortController()
  const removed = vi.spyOn(controller.signal, 'removeEventListener')
  const stream = vi.fn()
  const pending = run({ signal: controller.signal, onStdout: stream })
  child.stdout.write('partial')
  controller.abort()
  child.stdout.write('late')
  child.emit('close', 0)
  expect(await pending).toEqual({ stdout: 'partial', error: 'aborted', reason: 'aborted' })
  expect(stream).toHaveBeenCalledExactlyOnceWith('partial')
  expect(removed).toHaveBeenCalledWith('abort', expect.any(Function))
})

it('handles an abort that occurs inside spawn before the listener is installed', async () => {
  const controller = new AbortController()
  vi.mocked(spawn).mockImplementationOnce(() => {
    controller.abort()
    return child
  })
  expect(await run({ signal: controller.signal })).toEqual({
    stdout: '',
    error: 'aborted',
    reason: 'aborted',
  })
})

it('waits for close and drops output from a nonzero exit without stderr', async () => {
  const pending = run()
  child.emit('exit', 1)
  child.stdout.write('final but failed')
  child.emit('close', 1)
  expect(await pending).toEqual({ stdout: '', error: 'exited 1', reason: 'exit' })
})

it.skipIf(process.platform === 'win32').each(['close', 'timeout', 'abort', 'overflow'])(
  'leaves no real provider process group alive after %s',
  async (completion) => {
    vi.mocked(process.kill).mockRestore()
    const actual = await vi.importActual<typeof ChildProcessModule>('node:child_process')
    let pid: number | undefined
    const controller = new AbortController()
    vi.mocked(spawn).mockImplementationOnce((...args: Parameters<typeof spawn>) => {
      const real = actual.spawn(...args)
      pid = real.pid
      return real
    })
    const source = [
      "const { spawn } = require('node:child_process')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      'child.unref()',
      "process.stdout.write('ready')",
      completion === 'close' ? '' : 'setInterval(() => {}, 1000)',
    ].join(';')
    try {
      const result = await run(
        {
          timeoutMs: 1_000,
          signal: controller.signal,
          maxOutputBytes: completion === 'overflow' ? 1 : 4096,
          onStdout: () => {
            if (completion === 'abort') controller.abort()
          },
        },
        ['-e', source],
      )
      expect(result.reason).toBe(
        completion === 'close' ? undefined : completion === 'abort' ? 'aborted' : completion,
      )
      expect(pid).toBeTypeOf('number')
      await vi.waitFor(() => expect(() => process.kill(-pid!, 0)).toThrow(), { timeout: 3_000 })
    } finally {
      if (pid) {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
    }
  },
)
