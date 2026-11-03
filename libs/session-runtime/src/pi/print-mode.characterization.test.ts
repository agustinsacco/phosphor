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

import { createLaneNamer, type LaneNamingJob } from '../../../../apps/host/src/lanes/naming'
import { titleArgs, titlePrompt } from './title-policy'

// The Host's printTitle was deleted when the Host moved onto the shared title
// runner; these re-pin its transport contracts through the Host namer.
const hostMachine = { pi: { binaryPath: process.execPath, prefixArgs: [] }, env: {} }
const hostJob = (overrides: Partial<LaneNamingJob> = {}): LaneNamingJob => ({
  sessionId: 'session-1',
  cwd: process.cwd(),
  message: 'fix sidebar',
  model: { provider: 'native', id: 'model' },
  models: [],
  existingNames: [],
  current: () => true,
  apply: vi.fn(async () => {}),
  outcome: vi.fn(),
  ...overrides,
})

describe('Host print transport contracts through the lane namer', () => {
  it('Host completes a real child only after stdin EOF, with stderr not captured', async () => {
    const actual = await vi.importActual<typeof ChildProcessModule>('node:child_process')
    vi.mocked(spawn).mockImplementationOnce(actual.spawn)
    const script =
      "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('EOF title\\n'))"
    const job = hostJob()
    createLaneNamer({
      ...hostMachine,
      pi: { ...hostMachine.pi, prefixArgs: ['-e', script, '--'] },
    })(job)
    await vi.waitFor(() => expect(job.apply).toHaveBeenCalledWith('EOF title'), { timeout: 5_000 })
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(['-e', script]),
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'ignore'] }),
    )
  })

  it('Host rejects partial stdout on timeout', async () => {
    vi.useFakeTimers()
    const job = hostJob()
    createLaneNamer(hostMachine)(job)
    await vi.advanceTimersByTimeAsync(0)
    expect(spawn).toHaveBeenCalledOnce()
    child.stdout.write('partial')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(job.apply).not.toHaveBeenCalled()
    expect(job.outcome).toHaveBeenCalledExactlyOnceWith('print-timeout', {
      reason: 'timeout',
      attempts: 1,
    })
  })

  it('Host drains final stdout after exit, before close', async () => {
    const job = hostJob()
    createLaneNamer(hostMachine)(job)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    child.emit('exit', 0)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(job.apply).not.toHaveBeenCalled()
    child.stdout.write('Final title\n')
    child.emit('close', 0)
    await vi.waitFor(() => expect(job.apply).toHaveBeenCalledExactlyOnceWith('Final title'))
  })

  it.skipIf(process.platform === 'win32')('Host cancellation kills its process group', async () => {
    const job = hostJob()
    const name = createLaneNamer(hostMachine)
    name(job)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    child.stdout.write('partial')
    name.cancel()
    await vi.waitFor(() => expect(job.outcome).toHaveBeenCalledExactlyOnceWith('stale'))
    expect(job.apply).not.toHaveBeenCalled()
    expect(process.kill).toHaveBeenCalledWith(-7654321, 'SIGKILL')
  })

  it('Host names with the shared title argv, prompt, sanitizing and dedupe', async () => {
    const model = { provider: 'native', id: 'model' }
    const existingNames = [' sidebar fix ', 'SIDEBAR FIX 2']
    const job = hostJob({ model, existingNames })
    createLaneNamer(hostMachine)(job)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual([
      ...titleArgs({ model, extensions: [] }),
      titlePrompt('fix sidebar', existingNames),
    ])
    child.stdout.write('Here is the name:\n\n“Sidebar   Fix.”\n')
    child.emit('close', 0)
    await vi.waitFor(() => expect(job.apply).toHaveBeenCalledExactlyOnceWith('Sidebar Fix 3'))
  })
})
