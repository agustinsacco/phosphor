import type * as ChildProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { printTitle, createLaneNamer } from './naming'
import { listPackages } from '@phosphor/session-runtime/pi/packages'
import { resolvePackagePaths } from '@phosphor/session-runtime/pi/package-resources'
import { promptTitle } from './live'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('@phosphor/session-runtime/pi/packages', () => ({ listPackages: vi.fn(async () => []) }))
vi.mock('@phosphor/session-runtime/pi/package-resources', () => ({ resolvePackagePaths: vi.fn() }))
import { spawn } from 'node:child_process'
const machine = { pi: { binaryPath: '/test/pi', prefixArgs: [] }, env: { PATH: '/test' } }
let children: (EventEmitter & {
  stdout: PassThrough
  pid: number
  kill: ReturnType<typeof vi.fn>
})[]
beforeEach(() => {
  vi.mocked(spawn).mockReset()
  children = []
  vi.mocked(spawn).mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      pid: 7654321,
      kill: vi.fn(),
    })
    children.push(child)
    return child as unknown as ReturnType<typeof spawn>
  })
  vi.spyOn(process, 'kill').mockReturnValue(true)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})
it('ignores stdin, owns and kills its group on clean finish, with bounded output', async () => {
  const run = printTitle(machine, '/repo', ['-p'])
  expect(spawn).toHaveBeenCalledWith(
    '/test/pi',
    ['-p'],
    expect.objectContaining({ stdio: ['ignore', 'pipe', 'ignore'], detached: true }),
  )
  children[0]?.stdout.write('A short title\n')
  children[0]?.emit('close', 0)
  expect(await run).toBe('A short title')
  expect(process.kill).toHaveBeenCalledWith(-7654321, 'SIGKILL')
  const large = printTitle(machine, '/repo', [])
  children[1]?.stdout.write('x'.repeat(4097))
  children[1]?.emit('close', 0)
  expect(await large).toBeNull()
})
it('times out and kills without returning partial output', async () => {
  vi.useFakeTimers()
  const run = printTitle(machine, '/repo', [], 25)
  children[0]?.stdout.write('partial')
  let settled = false
  void run.then(() => {
    settled = true
  })
  await vi.advanceTimersByTimeAsync(25)
  expect(settled).toBe(true)
  expect(await run).toBeNull()
  expect(process.kill).toHaveBeenCalledWith(-7654321, 'SIGKILL')
})
it('serializes at one, bounds the queue, uses the lane provider, and skips stale work', async () => {
  const name = createLaneNamer(machine)
  const apply = vi.fn(async () => {})
  const job = {
    cwd: '/repo',
    message: 'first prompt',
    model: { provider: 'native', id: 'expensive' },
    models: [
      { provider: 'native', id: 'expensive', cost: { input: 10, output: 20 } },
      { provider: 'native', id: 'cheap', cost: { input: 1, output: 2 } },
    ],
    current: () => true,
    apply,
  }
  name(job)
  for (let i = 0; i < 65; i++) name({ ...job, current: () => false })
  await vi.waitFor(() => expect(children).toHaveLength(1))
  const args = vi.mocked(spawn).mock.calls[0]?.[1]
  expect(args).toEqual(
    expect.arrayContaining([
      '--thinking',
      'off',
      '--no-extensions',
      '--provider',
      'native',
      '--model',
      'expensive',
    ]),
  )
  children[0]?.stdout.write('Named')
  children[0]?.emit('close', 0)
  await vi.waitFor(() => expect(apply).toHaveBeenCalledWith('Named'))
  expect(children).toHaveLength(1)
})
it('matches the local first-line fallback and 80-character cap', () => {
  expect(promptTitle('\n  First line  \nsecond')).toBe('First line')
  expect(promptTitle('a'.repeat(81))).toBe('a'.repeat(79) + '…')
  expect(promptTitle('😀'.repeat(60))).toBe('😀'.repeat(39) + '…')
  expect(promptTitle('  ')).toBeNull()
})

it('runs at most 64 admitted jobs and never more than one print subprocess', async () => {
  const name = createLaneNamer(machine)
  const apply = vi.fn(async () => {})
  const job = {
    cwd: '/repo',
    message: 'first',
    model: { provider: 'native', id: 'model' },
    models: [],
    current: () => true,
    apply,
  }
  for (let i = 0; i < 66; i++) name(job)
  for (let i = 0; i < 64; i++) {
    await vi.waitFor(() => expect(children).toHaveLength(i + 1))
    children[i]?.stdout.write('Named')
    children[i]?.emit('close', 0)
  }
  await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(64))
  expect(children).toHaveLength(64)
})

it('cancels active naming and discards all queued and future work on shutdown', async () => {
  const name = createLaneNamer(machine)
  const apply = vi.fn(async () => {})
  const job = {
    cwd: '/repo',
    message: 'first',
    model: { provider: 'native', id: 'model' },
    models: [],
    current: () => true,
    apply,
  }
  name(job)
  name(job)
  await vi.waitFor(() => expect(children).toHaveLength(1))
  name.cancel()
  name(job)
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(process.kill).toHaveBeenCalledWith(-7654321, 'SIGKILL')
  expect(children).toHaveLength(1)
  expect(apply).not.toHaveBeenCalled()
})

it.skipIf(process.platform === 'win32')(
  'shutdown cancellation leaves no real naming process group alive',
  async () => {
    vi.mocked(process.kill).mockRestore()
    const actual = await vi.importActual<typeof ChildProcess>('node:child_process')
    let pid: number | undefined
    let ready = false
    vi.mocked(spawn).mockImplementationOnce((...args: Parameters<typeof spawn>) => {
      const child = actual.spawn(...args)
      pid = child.pid
      child.stdout?.on('data', () => {
        ready = true
      })
      return child
    })
    const name = createLaneNamer({
      pi: {
        binaryPath: process.execPath,
        prefixArgs: [
          '-e',
          "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); process.stdout.write('ready'); setInterval(() => {}, 1000)",
          '--',
        ],
      },
      env: {},
    })
    try {
      name({
        cwd: process.cwd(),
        message: 'first',
        model: { provider: 'native', id: 'test' },
        models: [],
        current: () => true,
        apply: async () => {},
      })
      await vi.waitFor(() => expect(ready).toBe(true))
      name.cancel()
      await vi.waitFor(() => {
        expect(pid).toBeTypeOf('number')
        expect(() => process.kill(-pid!, 0)).toThrow()
      })
    } finally {
      name.cancel()
      if (pid) {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          /* Already gone. */
        }
      }
    }
  },
)

it('waits for close when exit arrives before the final stdout data', async () => {
  const run = printTitle(machine, '/repo', [])
  children[0]?.emit('exit', 0)
  children[0]?.stdout.write('Drained title')
  children[0]?.emit('close', 0)
  expect(await run).toBe('Drained title')
})

it('loads executable provider paths, never package display names, and reports applied', async () => {
  vi.mocked(listPackages).mockResolvedValueOnce([
    {
      name: '@saccolabs/pi-claude-cli',
      installed: true,
      installPath: '/package',
      spec: 'npm:@saccolabs/pi-claude-cli',
      scope: 'global',
      kind: 'npm',
      filtered: false,
      resources: { extensions: ['index.ts'], skills: [], prompts: [], themes: [] },
    },
  ])
  vi.mocked(resolvePackagePaths).mockReturnValueOnce({
    extensions: ['/package/nested/index.ts'],
    skills: [],
    prompts: [],
    themes: [],
  })
  const outcome = vi.fn()
  const apply = vi.fn(async () => {})
  createLaneNamer(machine)({
    cwd: '/repo',
    message: 'private prompt',
    model: { provider: 'pi-claude-cli', id: 'claude-test' },
    models: [],
    current: () => true,
    apply,
    outcome,
  })
  await vi.waitFor(() => expect(children).toHaveLength(1))
  expect(spawn).toHaveBeenCalledWith(
    '/test/pi',
    expect.arrayContaining(['-e', '/package/nested/index.ts']),
    expect.anything(),
  )
  expect(spawn).not.toHaveBeenCalledWith(
    '/test/pi',
    expect.arrayContaining(['index.ts']),
    expect.anything(),
  )
  children[0]?.stdout.write('Private title')
  children[0]?.emit('close', 0)
  await vi.waitFor(() => expect(outcome).toHaveBeenCalledExactlyOnceWith('applied'))
})

it.each([
  'stale',
  'skipped-no-provider-package',
  'print-failed',
  'print-timeout',
  'set-failed',
] as const)('reports %s without including private naming data', async (expected) => {
  vi.useFakeTimers()
  const outcome = vi.fn()
  const apply = vi.fn(async () => {
    throw new Error('private failure')
  })
  createLaneNamer(machine)({
    cwd: '/private/repo',
    message: 'private prompt',
    model: {
      provider: expected === 'skipped-no-provider-package' ? 'pi-claude-cli' : 'native',
      id: 'model',
    },
    models: [],
    current: () => expected !== 'stale',
    apply,
    outcome,
  })
  await vi.advanceTimersByTimeAsync(0)
  if (expected === 'print-timeout') await vi.advanceTimersByTimeAsync(30_000)
  if (expected === 'print-failed') children[0]?.emit('close', 1)
  if (expected === 'set-failed') {
    children[0]?.stdout.write('Private title')
    children[0]?.emit('close', 0)
  }
  await vi.advanceTimersByTimeAsync(0)
  expect(outcome).toHaveBeenCalledExactlyOnceWith(expected)
  if (expected !== 'set-failed') expect(apply).not.toHaveBeenCalled()
})
