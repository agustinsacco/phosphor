import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ spawn: vi.fn(), kill: vi.fn(), proof: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: h.spawn }))
vi.mock('./print-mode', () => ({ OWN_GROUP: true, killProcessTree: h.kill, runPrintMode: h.proof }))
const sender = { isDestroyed: () => false, send: vi.fn() }
function child() {
  return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
}
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

it('tracks independent children and stops only jobs that have not settled', async () => {
  const { startJob, disposePackageJobs } = await import('./package-jobs')
  const completed = child()
  const running = child()
  h.spawn.mockReturnValueOnce(completed).mockReturnValueOnce(running)
  const onExit = vi.fn()
  startJob(sender, '/first', [], { env: {}, onExit })
  const second = startJob(sender, '/second', [], { env: {}, onExit })
  completed.emit('close', 0)
  await disposePackageJobs()
  running.emit('close', null)
  expect(h.kill.mock.calls).toEqual([[running]])
  expect(onExit.mock.calls).toEqual([[0], [1]])
  expect(sender.send).toHaveBeenCalledWith(`packages:exit:${second.jobId}`, 1)
})

it('deadline terminates the process tree and late events cannot resettle it', async () => {
  const { startJob, disposePackageJobs } = await import('./package-jobs')
  const running = child()
  h.spawn.mockReturnValue(running)
  const onExit = vi.fn()
  const { jobId } = startJob(sender, '/hung', [], { env: {}, onExit })
  await vi.advanceTimersByTimeAsync(15 * 60_000 - 1)
  expect(h.kill).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(h.kill).toHaveBeenCalledExactlyOnceWith(running)
  running.emit('error', new Error('late'))
  running.emit('close', null)
  expect(onExit).toHaveBeenCalledExactlyOnceWith(1)
  expect(sender.send.mock.calls).toEqual([
    [`packages:output:${jobId}`, 'Stopped: still running after 15 minutes.\n'],
    [`packages:exit:${jobId}`, 1],
  ])
  await disposePackageJobs()
  expect(h.kill).toHaveBeenCalledTimes(1)
})

it('failed jobs defer notification until subscription and ignore destroyed senders', async () => {
  const { failedJob } = await import('./package-jobs')
  const { jobId } = failedJob(sender, 'unavailable')
  const destroyed = { isDestroyed: () => true, send: vi.fn() }
  failedJob(destroyed, 'unavailable')
  expect(sender.send).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(0)
  expect(sender.send.mock.calls).toEqual([
    [`packages:output:${jobId}`, 'unavailable\n'],
    [`packages:exit:${jobId}`, 127],
  ])
  expect(destroyed.send).not.toHaveBeenCalled()
})

it('print-mode jobs defer execution, stream results and abort on shutdown', async () => {
  const { startPrintModeJob, disposePackageJobs } = await import('./package-jobs')
  h.proof.mockImplementation(
    (_command, _args, options: { signal: AbortSignal; onStdout: (text: string) => void }) =>
      new Promise((resolve) => {
        options.onStdout('answer')
        options.signal.addEventListener('abort', () =>
          resolve({ stdout: 'answer', error: 'aborted' }),
        )
      }),
  )
  const { jobId } = startPrintModeJob(sender, '/pi', ['-p'], {
    cwd: '/tmp',
    env: {},
    timeoutMs: 123,
  })
  expect(h.proof).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(0)
  await disposePackageJobs()
  expect(h.proof.mock.calls[0]?.[2].signal.aborted).toBe(true)
  expect(sender.send.mock.calls).toEqual([
    [`packages:output:${jobId}`, 'answer'],
    [`packages:output:${jobId}`, 'Stopped: Phosphor is quitting.\n'],
    [`packages:output:${jobId}`, 'aborted\n'],
    [`packages:exit:${jobId}`, 1],
  ])
})
