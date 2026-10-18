import type * as ChildProcessModule from 'node:child_process'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { killProcessTree, runPrintMode } from './print-mode'

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof ChildProcessModule>()
  return { ...actual, spawn: vi.fn(actual.spawn), execFile: vi.fn(actual.execFile) }
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const run = (source: string, options: Partial<Parameters<typeof runPrintMode>[2]> = {}) =>
  runPrintMode(process.execPath, ['-e', source], {
    cwd: process.cwd(),
    env: {},
    timeoutMs: 5_000,
    ...options,
  })

it('completes a real child blocked on stdin EOF without inheriting the environment', async () => {
  expect(
    await run(
      "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('EOF title\\n'))",
    ),
  ).toEqual({ stdout: 'EOF title\n' })
  expect(spawn).toHaveBeenLastCalledWith(
    process.execPath,
    expect.any(Array),
    expect.objectContaining({ env: {}, stdio: ['ignore', 'pipe', 'pipe'] }),
  )
})

it('drops stdout on nonzero exit and captures bounded diagnostic stderr', async () => {
  expect(
    await run(
      "process.stdout.write('partial'); process.stderr.write('nope\\n'); process.exitCode = 3",
    ),
  ).toEqual({ stdout: '', error: 'exited 3: nope', reason: 'exit' })
  expect(await run("process.stderr.write('warning'); process.stdout.write('ok')")).toEqual({
    stdout: 'ok',
  })
})

it('reports both asynchronous and synchronous spawn failures without rejecting', async () => {
  expect(
    await runPrintMode('/no/such/phosphor-print-binary', [], { cwd: process.cwd(), env: {} }),
  ).toEqual({ stdout: '', error: expect.stringContaining('ENOENT'), reason: 'spawn' })
  expect(await runPrintMode('bad\0binary', [], { cwd: process.cwd(), env: {} })).toEqual({
    stdout: '',
    error: expect.stringContaining('spawn failed:'),
    reason: 'spawn',
  })
})

it('keeps a real answer on timeout and streams it before completion', async () => {
  const chunks: string[] = []
  const result = await run("process.stdout.write('answer'); setInterval(() => {}, 1000)", {
    timeoutMs: 1_000,
    onStdout: (chunk) => chunks.push(chunk),
  })
  expect(result).toEqual({ stdout: 'answer', error: 'timed out after 1000ms', reason: 'timeout' })
  expect(chunks.join('')).toBe('answer')
})

it('preserves Desktop soft stdout and stderr caps at chunk boundaries', async () => {
  const result = await run("process.stdout.write('x'.repeat(2 * 1024 * 1024))")
  expect(result.error).toBeUndefined()
  expect(result.stdout.length).toBeGreaterThanOrEqual(1024 * 1024)
  expect(result.stdout.length).toBeLessThan(2 * 1024 * 1024)
  const failed = await run(
    "process.stderr.write('e'.repeat(2 * 1024 * 1024)); process.exitCode = 1",
  )
  expect(failed.error).toMatch(/^exited 1: e/)
  expect(failed.error!.length).toBeLessThan(2 * 1024 * 1024)
})

function mockChild(): ChildProcess & { stdout: PassThrough; stderr: PassThrough } {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 7654321,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(),
  }) as unknown as ChildProcess & { stdout: PassThrough; stderr: PassThrough }
  vi.mocked(spawn).mockReturnValueOnce(child)
  vi.spyOn(process, 'kill').mockReturnValue(true)
  return child
}

it('waits for close, drains final data, and settles only once', async () => {
  const child = mockChild()
  const streaming = vi.fn()
  const pending = run('', { onStdout: streaming })
  let settled = false
  void pending.then(() => {
    settled = true
  })
  child.emit('exit', 0)
  await Promise.resolve()
  expect(settled).toBe(false)
  child.stdout.write('final')
  child.emit('close', 0)
  child.emit('error', new Error('late error'))
  child.stdout.write('too late')
  expect(await pending).toEqual({ stdout: 'final' })
  expect(streaming).toHaveBeenCalledExactlyOnceWith('final')
})

it('uses the 30-second default and removes the abort listener on timeout', async () => {
  vi.useFakeTimers()
  const child = mockChild()
  const controller = new AbortController()
  const removed = vi.spyOn(controller.signal, 'removeEventListener')
  const pending = run('', { timeoutMs: undefined, signal: controller.signal })
  child.stdout.write('partial')
  await vi.advanceTimersByTimeAsync(29_999)
  expect(removed).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(await pending).toEqual({
    stdout: 'partial',
    error: 'timed out after 30000ms',
    reason: 'timeout',
  })
  expect(removed).toHaveBeenCalledWith('abort', expect.any(Function))
  controller.abort()
  child.emit('close', 0)
})

async function windowsCleanup() {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  try {
    vi.resetModules()
    const module = await import('./print-mode')
    vi.mocked(execFile).mockImplementationOnce(() => new EventEmitter() as ChildProcess)
    return module.killProcessTree
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
}

it('bounds Windows taskkill and falls back only while the child is still live', async () => {
  const cleanup = await windowsCleanup()
  const child = mockChild()
  cleanup(child)
  const [command, args, options, callback] = vi.mocked(execFile).mock.lastCall!
  expect([command, args, options]).toEqual([
    'taskkill',
    ['/pid', '7654321', '/T', '/F'],
    { timeout: 5_000, windowsHide: true },
  ])
  ;(callback as (error: Error) => void)(new Error('timeout'))
  expect(child.kill).toHaveBeenCalledWith('SIGKILL')
})

it('does not run Windows taskkill for a stale or missing pid', async () => {
  const cleanup = await windowsCleanup()
  const child = mockChild()
  Object.assign(child, { exitCode: 0 })
  const calls = vi.mocked(execFile).mock.calls.length
  cleanup(child)
  Object.assign(child, { exitCode: null, signalCode: 'SIGKILL' })
  cleanup(child)
  expect(vi.mocked(execFile).mock.calls).toHaveLength(calls)
  expect(child.kill).not.toHaveBeenCalled()
  killProcessTree({ pid: undefined } as ChildProcess)
})
