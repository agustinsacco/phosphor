import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: h.spawn, execFile: vi.fn() }))
vi.mock('./binary-lookup', () => ({
  resolveBinary: async () => '/usr/bin/npm',
  windowsWhereOutput: vi.fn(),
}))
vi.mock('./shell-env', () => ({ piProcessEnv: async () => ({ PATH: '/shell' }) }))
vi.mock('./print-mode', () => ({
  OWN_GROUP: true,
  killProcessTree: vi.fn(),
  runPrintMode: vi.fn(),
}))

type Child = EventEmitter & { stdout: PassThrough; stderr: PassThrough }
const children: Child[] = []
const sent: Array<[string, unknown]> = []
const sender = {
  isDestroyed: () => false,
  send: (channel: string, payload: unknown) => sent.push([channel, payload]),
}
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
  children.length = 0
  sent.length = 0
  h.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    })
    children.push(child)
    return child
  })
})
afterEach(() => vi.useRealTimers())

it('runs one npm pi install at a time and refuses a second click while it runs', async () => {
  const { runPiInstall } = await import('./packages')
  const [first, second] = await Promise.all([runPiInstall(sender), runPiInstall(sender)])
  const third = await runPiInstall(sender)
  await vi.advanceTimersByTimeAsync(0)
  expect(h.spawn).toHaveBeenCalledOnce()
  for (const refused of [second, third]) {
    expect(sent).toContainEqual([
      `packages:output:${refused.jobId}`,
      'pi is already being installed.\n',
    ])
    expect(sent).toContainEqual([`packages:exit:${refused.jobId}`, 127])
  }
  children[0]!.emit('close', 0)
  expect(sent).toContainEqual([`packages:exit:${first.jobId}`, 0])
  await runPiInstall(sender)
  expect(h.spawn).toHaveBeenCalledTimes(2)
})

it('admits a new install after the last one failed to spawn', async () => {
  const { runPiInstall } = await import('./packages')
  await runPiInstall(sender)
  children[0]!.emit('error', new Error('spawn npm ENOENT'))
  await runPiInstall(sender)
  expect(h.spawn).toHaveBeenCalledTimes(2)
})
