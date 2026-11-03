import type * as ChildProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createLaneNamer, hostLaneNaming, type LaneNamingJob } from './naming'
import { listPackages } from '@phosphor/session-runtime/pi/packages'
import { resolvePackagePaths } from '@phosphor/session-runtime/pi/package-resources'
import { promptTitle } from './live'
import { DEFAULT_CLAUDE_ACCOUNT_PREFS } from '@phosphor/shared/models'
import type { HostConfigV1 } from '../config/schema'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
const job = (overrides: Partial<LaneNamingJob> = {}): LaneNamingJob => ({
  sessionId: 'session-1',
  cwd: '/repo',
  message: 'first',
  model: { provider: 'native', id: 'model' },
  models: [],
  existingNames: [],
  current: () => true,
  apply: vi.fn(async () => {}),
  ...overrides,
})
it('ignores stdin, owns and kills its group on clean finish, and fails past 4 KiB', async () => {
  const outcome = vi.fn()
  const name = createLaneNamer(machine)
  const first = job()
  name(first)
  await vi.waitFor(() => expect(children).toHaveLength(1))
  expect(spawn).toHaveBeenCalledWith(
    '/test/pi',
    expect.arrayContaining(['-p']),
    expect.objectContaining({ stdio: ['ignore', 'pipe', 'ignore'], detached: true }),
  )
  children[0]?.stdout.write('A short title\n')
  children[0]?.emit('close', 0)
  await vi.waitFor(() => expect(first.apply).toHaveBeenCalledWith('A short title'))
  expect(process.kill).toHaveBeenCalledWith(-7654321, 'SIGKILL')
  name(job({ outcome, model: { provider: 'native', id: 'large' } }))
  await vi.waitFor(() => expect(children).toHaveLength(2))
  children[1]?.stdout.write('x'.repeat(4097))
  await vi.waitFor(() => expect(children).toHaveLength(3))
  children[2]?.stdout.write('y'.repeat(4097))
  await vi.waitFor(() => expect(outcome).toHaveBeenCalled())
  expect(outcome).toHaveBeenCalledExactlyOnceWith('print-failed', {
    reason: 'overflow',
    attempts: 2,
  })
})
it('times out after 30 s, kills the group and stops retrying', async () => {
  vi.useFakeTimers()
  const outcome = vi.fn()
  const timedOut = job({ outcome })
  createLaneNamer(machine)(timedOut)
  await vi.advanceTimersByTimeAsync(0)
  expect(children).toHaveLength(1)
  children[0]?.stdout.write('partial')
  await vi.advanceTimersByTimeAsync(30_000)
  expect(timedOut.apply).not.toHaveBeenCalled()
  expect(outcome).toHaveBeenCalledExactlyOnceWith('print-timeout', {
    reason: 'timeout',
    attempts: 1,
  })
  expect(process.kill).toHaveBeenCalledWith(-7654321, 'SIGKILL')
  expect(children).toHaveLength(1)
})
it('serializes at one, bounds the queue, uses the lane provider, and skips stale work', async () => {
  const name = createLaneNamer(machine)
  const apply = vi.fn(async () => {})
  const job = {
    cwd: '/repo',
    sessionId: 'session-1',
    existingNames: [],
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
    sessionId: 'session-1',
    existingNames: [],
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
    sessionId: 'session-1',
    existingNames: [],
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
        sessionId: 'session-1',
        existingNames: [],
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
  const drained = job()
  createLaneNamer(machine)(drained)
  await vi.waitFor(() => expect(children).toHaveLength(1))
  children[0]?.emit('exit', 0)
  children[0]?.stdout.write('Drained title')
  children[0]?.emit('close', 0)
  await vi.waitFor(() => expect(drained.apply).toHaveBeenCalledWith('Drained title'))
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
    sessionId: 'session-1',
    existingNames: [],
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
  ['stale', ['stale']],
  ['print-failed', ['print-failed', { reason: 'exit', attempts: 2 }]],
  ['print-timeout', ['print-timeout', { reason: 'timeout', attempts: 1 }]],
  ['set-failed', ['set-failed']],
] as const)('reports %s without including private naming data', async (expected, reported) => {
  vi.useFakeTimers()
  const outcome = vi.fn()
  const apply = vi.fn(async () => {
    throw new Error('private failure')
  })
  createLaneNamer(machine)(
    job({
      cwd: '/private/repo',
      message: 'private prompt',
      current: () => expected !== 'stale',
      apply,
      outcome,
    }),
  )
  await vi.advanceTimersByTimeAsync(0)
  if (expected === 'print-timeout') await vi.advanceTimersByTimeAsync(30_000)
  if (expected === 'print-failed') {
    children[0]?.stdout.write('private output')
    children[0]?.emit('close', 1)
    await vi.advanceTimersByTimeAsync(0)
    children[1]?.emit('close', 1)
  }
  if (expected === 'set-failed') {
    children[0]?.stdout.write('Private title')
    children[0]?.emit('close', 0)
  }
  await vi.advanceTimersByTimeAsync(0)
  expect(outcome.mock.calls).toEqual([reported])
  expect(JSON.stringify(outcome.mock.calls)).not.toMatch(/private/i)
  if (expected !== 'set-failed') expect(apply).not.toHaveBeenCalled()
})

const routedJob = (overrides: Partial<LaneNamingJob> = {}) => ({
  sessionId: 'session-2',
  cwd: '/repo',
  message: 'private prompt',
  model: { provider: 'native', id: 'chat-large' },
  models: [
    { provider: 'native', id: 'chat-large', cost: { input: 10, output: 20 } },
    { provider: 'native', id: 'chat-small', cost: { input: 1, output: 2 } },
  ],
  existingNames: [],
  current: () => true,
  apply: vi.fn(async () => {}),
  ...overrides,
})

it('names with the lane routed Claude account env and the provider spawn env', async () => {
  const accountEnv = vi.fn(async () => ({ CLAUDE_SECURESTORAGE_CONFIG_DIR: '/accounts/second' }))
  createLaneNamer(machine, { accountEnv })(routedJob())
  await vi.waitFor(() => expect(children).toHaveLength(1))
  expect(accountEnv).toHaveBeenCalledWith('session-2')
  expect(spawn).toHaveBeenCalledWith(
    '/test/pi',
    expect.any(Array),
    expect.objectContaining({
      env: {
        PATH: '/test',
        PI_CLAUDE_CLI_CONTEXT: 'pi',
        PI_CLAUDE_CLI_KEEPALIVE_MS: '0',
        PI_CLAUDE_CLI_EPHEMERAL: '1',
        CLAUDE_SECURESTORAGE_CONFIG_DIR: '/accounts/second',
      },
    }),
  )
})

it('retries a failed fast boot with a full boot, then the fallback model', async () => {
  const job = routedJob()
  createLaneNamer(machine)(job)
  await vi.waitFor(() => expect(children).toHaveLength(1))
  children[0]?.emit('close', 1)
  await vi.waitFor(() => expect(children).toHaveLength(2))
  children[1]?.emit('close', 1)
  await vi.waitFor(() => expect(children).toHaveLength(3))
  children[2]?.stdout.write('Named')
  children[2]?.emit('close', 0)
  await vi.waitFor(() => expect(job.apply).toHaveBeenCalledWith('Named'))
  const argv = vi.mocked(spawn).mock.calls.map((call) => call[1] as string[])
  expect(argv[0]).toEqual(expect.arrayContaining(['--no-extensions', '--model', 'chat-small']))
  expect(argv[1]).toEqual(expect.arrayContaining(['--model', 'chat-small']))
  expect(argv[1]).not.toContain('--no-extensions')
  expect(argv[2]).toEqual(expect.arrayContaining(['--model', 'chat-large']))
  expect(argv[2]).not.toContain('--no-extensions')
})

it('reports a fixed failure reason and attempt count, never output', async () => {
  const outcome = vi.fn()
  createLaneNamer(machine)(routedJob({ outcome }))
  for (let i = 0; i < 3; i++) {
    await vi.waitFor(() => expect(children).toHaveLength(i + 1))
    children[i]?.stdout.write('private output')
    children[i]?.emit('close', 1)
  }
  await vi.waitFor(() => expect(outcome).toHaveBeenCalled())
  expect(outcome).toHaveBeenCalledExactlyOnceWith('print-failed', { reason: 'exit', attempts: 3 })
})

it('asks for a title unlike its sibling lanes and dedupes the reply against them', async () => {
  const job = routedJob({ existingNames: ['Named', 'Other Lane'] })
  createLaneNamer(machine)(job)
  await vi.waitFor(() => expect(children).toHaveLength(1))
  expect(vi.mocked(spawn).mock.calls[0]?.[1]?.at(-1)).toContain('- Named\n- Other Lane')
  children[0]?.stdout.write('Named')
  children[0]?.emit('close', 0)
  await vi.waitFor(() => expect(job.apply).toHaveBeenCalledWith('Named 2'))
})

it('keeps a deduplicated title within 60 characters', async () => {
  const sibling = 'A'.repeat(60)
  const job = routedJob({ existingNames: [sibling] })
  createLaneNamer(machine)(job)
  await vi.waitFor(() => expect(children).toHaveLength(1))
  children[0]?.stdout.write(sibling)
  children[0]?.emit('close', 0)
  await vi.waitFor(() => expect(job.apply).toHaveBeenCalledWith(`${'A'.repeat(58)} 2`))
})

it('reads automatic naming live and resolves the routed account for each session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-naming-'))
  const path = join(dir, 'config.json')
  const base: HostConfigV1 = {
    version: 1,
    pi: { executable: '/usr/bin/pi' },
    repositories: ['/srv'],
  }
  try {
    writeFileSync(path, JSON.stringify(base), { mode: 0o600 })
    const second = { id: 'second', label: 'Second', credentialDir: '/accounts/second', addedAt: 1 }
    const ports = hostLaneNaming(
      { path, config: base },
      { accountForSession: (id) => (id === 'routed' ? 'second' : id === 'gone' ? 'x' : undefined) },
      { loadAccounts: async () => ({ ...DEFAULT_CLAUDE_ACCOUNT_PREFS, accounts: [second] }) },
    )
    expect(ports.enabled?.()).toBe(true)
    writeFileSync(path, JSON.stringify({ ...base, autoNameLanes: false }))
    expect(ports.enabled?.()).toBe(false)
    expect(await ports.accountEnv?.('routed')).toEqual({
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '/accounts/second',
    })
    expect(await ports.accountEnv?.('unrouted')).toEqual({})
    await expect(ports.accountEnv?.('gone')).rejects.toThrow()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
