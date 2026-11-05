import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { generateSessionTitle } from './session-title'
import { PiUnavailableError } from './invoker'

const state = vi.hoisted(() => ({
  invoker: vi.fn(),
  run: vi.fn(),
  catalogue: vi.fn(),
  log: vi.fn(),
}))
vi.mock('./invoker', () => ({
  PiUnavailableError: class extends Error {},
  resolvePiInvoker: state.invoker,
}))
vi.mock('@phosphor/session-runtime/pi/print-mode', () => ({ runPrintMode: state.run }))
vi.mock('./catalogue', () => ({ catalogueModels: state.catalogue }))
vi.mock('../claude/accounts', () => ({ primaryAccount: vi.fn(), claudeAccountEnv: vi.fn() }))
vi.mock('@phosphor/session-runtime/pi/agent-settings', () => ({
  readAgentSettings: async () => ({ defaultProvider: 'vendor', defaultModel: 'chat-large' }),
}))
vi.mock('../debug-log', () => ({ log: state.log }))

const generate = (names: string[] = []) => generateSessionTitle('/repo', 'fix login', names)

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  state.invoker.mockResolvedValue({
    binaryPath: '/bin/pi',
    prefixArgs: ['entry.js'],
    env: { PATH: '/bin' },
    stub: false,
  })
  state.catalogue.mockResolvedValue([
    { provider: 'vendor', id: 'chat-large', cost: { input: 10, output: 10 } },
    { provider: 'vendor', id: 'chat-small', cost: { input: 1, output: 1 } },
  ])
  state.run.mockResolvedValue({ stdout: 'Fix Login Bug' })
})
afterEach(() => vi.useRealTimers())

it('logs one diagnostic for a successful run and dedupes against existing names', async () => {
  state.run.mockImplementationOnce(async () => {
    vi.setSystemTime(1250)
    return { stdout: 'Fix Login Bug' }
  })
  expect(await generate(['Fix Login Bug'])).toBe('Fix Login Bug 2')
  expect(state.log).toHaveBeenCalledExactlyOnceWith('naming', 'generated a session name', {
    ms: 250,
    title: 'Fix Login Bug 2',
    model: 'vendor/chat-small',
    fastBoot: true,
  })
  expect(state.run).toHaveBeenCalledWith(
    '/bin/pi',
    expect.arrayContaining(['entry.js', '-p', '--no-tools', '--model', 'chat-small']),
    expect.objectContaining({ cwd: '/repo' }),
  )
})

it('logs every failed attempt error in order when no attempt names the session', async () => {
  state.run.mockResolvedValue({ stdout: '', error: 'offline', reason: 'exit' })
  expect(await generate()).toBeNull()
  expect(state.run).toHaveBeenCalledTimes(3)
  expect(state.log).toHaveBeenCalledExactlyOnceWith('naming', 'no session name', {
    ms: 0,
    title: null,
    model: 'default',
    fastBoot: false,
    errors: ['offline', 'offline', 'offline'],
  })
})

it('runs a stub with its own env and a single default attempt', async () => {
  state.invoker.mockResolvedValue({
    binaryPath: '/stub',
    prefixArgs: [],
    env: { STUB: '1' },
    stub: true,
  })
  expect(await generate()).toBe('Fix Login Bug')
  expect(state.run).toHaveBeenCalledExactlyOnceWith(
    '/stub',
    expect.not.arrayContaining(['--model', '--no-extensions']),
    expect.objectContaining({ env: { STUB: '1' } }),
  )
  expect(state.catalogue).not.toHaveBeenCalled()
})

it('returns null for unavailable pi without logging or executing', async () => {
  state.invoker.mockRejectedValue(new PiUnavailableError('missing'))
  expect(await generate()).toBeNull()
  expect(state.run).not.toHaveBeenCalled()
  expect(state.catalogue).not.toHaveBeenCalled()
  expect(state.log).not.toHaveBeenCalled()
})

it('retains rejection for unexpected invocation environment failures', async () => {
  state.invoker.mockRejectedValue(new Error('shell failed'))
  await expect(generate()).rejects.toThrow('shell failed')
  expect(state.run).not.toHaveBeenCalled()
  expect(state.log).not.toHaveBeenCalled()
})

it('names from the partial stdout of a timed-out or aborted attempt', async () => {
  for (const reason of ['timeout', 'aborted'] as const) {
    state.run.mockResolvedValueOnce({ stdout: 'Fix Login', error: reason, reason })
    expect(await generate()).toBe('Fix Login')
  }
})
