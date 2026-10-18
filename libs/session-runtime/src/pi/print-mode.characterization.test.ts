import type * as ChildProcessModule from 'node:child_process'
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runPrintMode } from '../../../../apps/desktop/electron/pi/print-mode'
import { printTitle } from '../../../../apps/host/src/lanes/naming'

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof ChildProcessModule>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

const machine = { pi: { binaryPath: process.execPath, prefixArgs: [] }, env: {} }
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
const host = (timeoutMs = 5_000, signal?: AbortSignal) =>
  printTitle(machine, process.cwd(), [], timeoutMs, signal)

describe('original print transport contracts', () => {
  it.each(['Desktop', 'Host'])('%s completes a real child only after stdin EOF', async (entry) => {
    const actual = await vi.importActual<typeof ChildProcessModule>('node:child_process')
    vi.mocked(spawn).mockImplementationOnce(actual.spawn)
    const args = [
      '-e',
      "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('EOF title\\n'))",
    ]
    const result =
      entry === 'Desktop'
        ? await runPrintMode(process.execPath, args, {
            cwd: process.cwd(),
            env: {},
            timeoutMs: 5_000,
          })
        : await printTitle(machine, process.cwd(), args, 5_000)
    expect(result).toEqual(entry === 'Desktop' ? { stdout: 'EOF title\n' } : 'EOF title')
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      args,
      expect.objectContaining({
        stdio: ['ignore', 'pipe', entry === 'Desktop' ? 'pipe' : 'ignore'],
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

  it('Host rejects partial stdout on timeout', async () => {
    vi.useFakeTimers()
    const pending = host(25)
    child.stdout.write('partial')
    await vi.advanceTimersByTimeAsync(25)
    expect(await pending).toBeNull()
  })

  it.each(['Desktop', 'Host'])('%s drains final stdout after exit, before close', async (entry) => {
    const pending = entry === 'Desktop' ? desktop() : host()
    let settled = false
    void pending.then(() => {
      settled = true
    })
    child.emit('exit', 0)
    await Promise.resolve()
    expect(settled).toBe(false)
    child.stdout.write('Final title\n')
    child.emit('close', 0)
    expect(await pending).toEqual(entry === 'Desktop' ? { stdout: 'Final title\n' } : 'Final title')
  })

  it.skipIf(process.platform === 'win32').each(['Desktop', 'Host'])(
    '%s cancellation kills its process group',
    async (entry) => {
      const controller = new AbortController()
      const pending =
        entry === 'Desktop' ? desktop(5_000, controller.signal) : host(5_000, controller.signal)
      child.stdout.write('partial')
      controller.abort()
      expect(await pending).toEqual(
        entry === 'Desktop' ? { stdout: 'partial', error: 'aborted' } : null,
      )
      expect(process.kill).toHaveBeenCalledWith(-7654321, 'SIGKILL')
    },
  )
})
