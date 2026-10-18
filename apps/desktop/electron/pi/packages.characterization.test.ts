import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ spawn: vi.fn(), exec: vi.fn(), lookup: vi.fn(), kill: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: h.spawn, execFile: h.exec }))
vi.mock('node:util', () => ({ promisify: () => h.exec }))
vi.mock('./binary-lookup', () => ({
  lookupPosixBinary: h.lookup,
  resolveBinary: h.lookup,
  windowsWhereOutput: vi.fn(),
}))
vi.mock('./shell-env', () => ({ piProcessEnv: async () => ({ PATH: '/shell' }) }))
vi.mock('./stub', () => ({ piStubPath: () => undefined }))
vi.mock('./print-mode', () => ({ OWN_GROUP: true, killProcessTree: h.kill, runPrintMode: vi.fn() }))
let child: EventEmitter & { stdout: PassThrough; stderr: PassThrough }
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
  child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  })
  h.spawn.mockReturnValue(child)
  h.lookup.mockResolvedValue('/claude')
  h.exec.mockResolvedValue({ stdout: '{"loggedIn":true}' })
})
afterEach(() => vi.useRealTimers())

it('streams stdout and stderr before callback and one terminal exit', async () => {
  const packages = await import('./packages')
  const events: unknown[] = []
  const sender = {
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => events.push([channel, payload]),
  }
  const { jobId } = packages.startJob(sender, '/command', ['arg'], {
    env: {},
    onExit: (code) => events.push(['callback', code]),
  })
  child.stdout.emit('data', Buffer.from('out'))
  child.stderr.emit('data', Buffer.from('err'))
  child.emit('close', 2)
  child.stdout.emit('data', Buffer.from('late'))
  child.emit('error', new Error('late'))
  child.emit('close', 0)
  expect(events).toEqual([
    [`packages:output:${jobId}`, 'out'],
    [`packages:output:${jobId}`, 'err'],
    ['callback', 2],
    [`packages:exit:${jobId}`, 2],
  ])
})

it('destroyed senders hear nothing but callbacks settle and quit completes', async () => {
  const packages = await import('./packages')
  const send = vi.fn()
  const onExit = vi.fn()
  packages.startJob({ isDestroyed: () => true, send }, '/command', [], { env: {}, onExit })
  child.stdout.emit('data', Buffer.from('out'))
  child.emit('close', 0)
  await packages.disposePackageJobs()
  expect(onExit).toHaveBeenCalledExactlyOnceWith(0)
  expect(send).not.toHaveBeenCalled()
  expect(h.kill).not.toHaveBeenCalled()
})

it('spawn failure reports the error then callback and exit 127 once', async () => {
  const packages = await import('./packages')
  const events: unknown[] = []
  const { jobId } = packages.startJob(
    { isDestroyed: () => false, send: (channel, payload) => events.push([channel, payload]) },
    '/missing',
    [],
    {
      env: {},
      onExit: (code) => events.push(['callback', code]),
    },
  )
  child.emit('error', new Error('missing'))
  child.emit('close', -2)
  expect(events).toEqual([
    [`packages:output:${jobId}`, 'missing\n'],
    ['callback', 127],
    [`packages:exit:${jobId}`, 127],
  ])
})

it('quit kills the tree, reports once and closes admission with deferred failure', async () => {
  const packages = await import('./packages')
  const send = vi.fn()
  const onExit = vi.fn()
  const sender = { isDestroyed: () => false, send }
  const { jobId } = packages.startJob(sender, '/command', [], { env: {}, onExit })
  const disposal = packages.disposePackageJobs()
  expect(packages.disposePackageJobs()).toBe(disposal)
  await disposal
  child.emit('close', null)
  expect(h.kill).toHaveBeenCalledExactlyOnceWith(child)
  expect(onExit).toHaveBeenCalledExactlyOnceWith(1)
  expect(send.mock.calls).toEqual([
    [`packages:output:${jobId}`, 'Stopped: Phosphor is quitting.\n'],
    [`packages:exit:${jobId}`, 1],
  ])
  send.mockClear()
  const rejected = packages.startJob(sender, '/command', [], { env: {} })
  expect(send).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(0)
  expect(send.mock.calls).toEqual([
    [`packages:output:${rejected.jobId}`, 'Phosphor is shutting down. New work cannot start.\n'],
    [`packages:exit:${rejected.jobId}`, 127],
  ])
  expect(h.spawn).toHaveBeenCalledTimes(1)
})

it('package project actions preserve stub args, cwd and inherited environment', async () => {
  const { runPackageAction } = await import('./packages')
  await runPackageAction(
    { isDestroyed: () => false, send: vi.fn() },
    'update',
    undefined,
    'project',
    '/workspace',
    '/stub.cjs',
  )
  expect(h.spawn).toHaveBeenCalledWith(
    process.execPath,
    ['/stub.cjs', 'update', '--extensions', '-l'],
    {
      cwd: '/workspace',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  )
  child.emit('close', 0)
})

it('Claude nonzero auth status still parses logged-out JSON and version', async () => {
  const { claudeStatus } = await import('./packages')
  h.exec
    .mockResolvedValueOnce({ stdout: 'Claude Code 2.1.219 (native)' })
    .mockRejectedValueOnce({ stdout: 'banner\n{"loggedIn":false}', message: 'exit 1' })
  expect(await claudeStatus()).toEqual({
    binary: { found: true, path: '/claude', version: '2.1.219' },
    auth: { ok: true, loggedIn: false },
  })
})

it('missing Claude binary reports unavailable without starting subprocesses', async () => {
  const { claudeStatus } = await import('./packages')
  h.lookup.mockResolvedValue(null)
  expect(await claudeStatus()).toEqual({
    binary: { found: false },
    auth: { ok: false, error: 'claude not found' },
  })
  expect(h.exec).not.toHaveBeenCalled()
})
