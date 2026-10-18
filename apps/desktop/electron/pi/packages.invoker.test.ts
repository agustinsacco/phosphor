import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MIN_PI_VERSION } from '@shared/models'
import { runClaudeProviderTest, runPackageAction } from './packages'

const h = vi.hoisted(() => ({
  spawn: vi.fn(),
  health: vi.fn(),
  env: vi.fn(),
  proof: vi.fn(),
}))
vi.mock('node:child_process', () => ({ spawn: h.spawn, execFile: vi.fn() }))
vi.mock('./health', () => ({ cachedPiHealth: h.health }))
vi.mock('./shell-env', () => ({ piProcessEnv: h.env }))
vi.mock('./stub', () => ({ piStubPath: () => '/implicit-stub.cjs' }))
vi.mock('./print-mode', () => ({
  OWN_GROUP: true,
  killProcessTree: vi.fn(),
  runPrintMode: h.proof,
}))
vi.mock('./provider-detect', () => ({
  claudeProviderSpawnEnv: () => ({ PROVIDER: 'policy' }),
  claudeOneShotEnv: () => ({ ONE_SHOT: '1' }),
}))
const sender = { isDestroyed: () => false, send: vi.fn() }
let child: EventEmitter & { stdout: PassThrough; stderr: PassThrough }
beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  })
  h.spawn.mockReturnValue(child)
  h.health.mockResolvedValue({
    ok: true,
    binaryPath: '/node',
    prefixArgs: ['/pi.js'],
    minVersion: MIN_PI_VERSION,
  })
  h.env.mockResolvedValue({ PATH: '/shell', SECRET: 'shell' })
  h.proof.mockResolvedValue({ stdout: '' })
})
afterEach(() => vi.useRealTimers())

it.each([
  ['install', 'npm:pkg', 'global', undefined, ['install', 'npm:pkg']],
  ['remove', 'npm:pkg', 'project', '/workspace', ['remove', 'npm:pkg', '-l']],
  ['update', undefined, 'global', undefined, ['update', '--extensions']],
  ['update', 'npm:pkg', 'project', '/workspace', ['update', 'npm:pkg', '-l']],
] as const)(
  'preserves %s %s %s action argv and shell env',
  async (action, spec, scope, cwd, args) => {
    await runPackageAction(sender, action, spec, scope, cwd)
    expect(h.spawn).toHaveBeenCalledWith('/node', ['/pi.js', ...args], {
      cwd,
      env: { PATH: '/shell', SECRET: 'shell' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    child.emit('close', 0)
  },
)

it('explicit stubs inherit process env, not shell env, and bypass discovery', async () => {
  await runPackageAction(sender, 'install', 'pkg', 'global', undefined, '/explicit.cjs')
  expect(h.spawn).toHaveBeenCalledWith(
    process.execPath,
    ['/explicit.cjs', 'install', 'pkg'],
    expect.objectContaining({
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    }),
  )
  expect(h.health).not.toHaveBeenCalled()
  expect(h.env).not.toHaveBeenCalled()
  child.emit('close', 0)
})

it('reports unavailable pi and missing project workspace through deferred job channels', async () => {
  h.health.mockResolvedValueOnce({ ok: false, minVersion: MIN_PI_VERSION })
  const missing = await runPackageAction(sender, 'install', 'pkg', 'global')
  expect(sender.send).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(0)
  expect(sender.send.mock.calls).toEqual([
    [`packages:output:${missing.jobId}`, 'pi binary not found on PATH\n'],
    [`packages:exit:${missing.jobId}`, 127],
  ])
  sender.send.mockClear()
  await runPackageAction(sender, 'install', 'pkg', 'project')
  await vi.advanceTimersByTimeAsync(0)
  expect(sender.send.mock.calls[0]?.[1]).toBe('project scope requires a workspace\n')
  expect(h.spawn).not.toHaveBeenCalled()
})

it('propagates environment failures rather than reporting missing pi', async () => {
  h.env.mockRejectedValueOnce(new Error('shell failed'))
  await expect(runPackageAction(sender, 'update', undefined, 'global')).rejects.toThrow(
    'shell failed',
  )
})

it('provider proof keeps its print-mode argv, inherited env and policy overlays', async () => {
  await runClaudeProviderTest(sender, '/proof.cjs')
  expect(h.proof).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(0)
  expect(h.proof).toHaveBeenCalledWith(
    process.execPath,
    [
      '/proof.cjs',
      '-p',
      '--model',
      'pi-claude-cli/claude-haiku-4-5',
      'Reply with exactly: phosphor-provider-ok',
    ],
    expect.objectContaining({
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PROVIDER: 'policy', ONE_SHOT: '1' },
      timeoutMs: 30_000,
      signal: expect.any(AbortSignal),
    }),
  )
})
