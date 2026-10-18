import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { generateSessionTitle } from './session-title'
import { PiUnavailableError } from './invoker'
import type { TitleAttempt } from './session-naming'

const state = vi.hoisted(() => ({
  invoker: vi.fn(),
  run: vi.fn(),
  plan: vi.fn(),
  remember: vi.fn(),
  log: vi.fn(),
  prefs: { nameMinWords: 2, nameMaxWords: 5, nameMaxLength: 60 },
}))
vi.mock('./invoker', () => ({
  PiUnavailableError: class extends Error {},
  resolvePiInvoker: state.invoker,
}))
vi.mock('./print-mode', () => ({ runPrintMode: state.run }))
vi.mock('./title-plan', () => ({
  planTitleRun: state.plan,
  rememberTitleFailures: state.remember,
  modelKey: (model: { provider: string; id: string }) => `${model.provider}/${model.id}`,
}))
vi.mock('../claude/accounts', () => ({ primaryAccount: vi.fn(), claudeAccountEnv: vi.fn() }))
vi.mock('@phosphor/session-runtime/pi/agent-settings', () => ({
  readAgentSettings: async () => ({ defaultProvider: 'vendor' }),
}))
vi.mock('../store', () => ({ getLanePrefs: () => state.prefs }))
vi.mock('../debug-log', () => ({ log: state.log }))

const model = { provider: 'vendor', id: 'chat-small' }
const plan: TitleAttempt[] = [
  { model, extensions: [] },
  { model, extensions: null },
  { model: null, extensions: null },
]
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
  state.plan.mockResolvedValue(plan)
  state.run.mockResolvedValue({ stdout: 'Fix Login Bug' })
})
afterEach(() => vi.useRealTimers())

it('logs successful attempt diagnostics before deduplication', async () => {
  state.run.mockImplementationOnce(async () => {
    vi.setSystemTime(1250)
    return { stdout: 'Fix Login Bug' }
  })
  expect(await generate(['Fix Login Bug'])).toBe('Fix Login Bug 2')
  expect(state.log).toHaveBeenCalledExactlyOnceWith('naming', 'generated a session name', {
    ms: 250,
    title: 'Fix Login Bug',
    model: 'vendor/chat-small',
    fastBoot: true,
  })
  expect(state.run).toHaveBeenCalledWith(
    '/bin/pi',
    expect.arrayContaining(['entry.js', '-p', '--no-tools']),
    expect.objectContaining({ cwd: '/repo' }),
  )
  expect(state.remember).toHaveBeenCalledWith(expect.any(Object), [], plan[0], 'vendor')
})

it('accepts partial stdout even when the successful attempt timed out', async () => {
  state.run.mockResolvedValue({
    stdout: 'Explanation\n"Fix Login Bug."',
    error: 'timed out after 30000ms',
  })
  expect(await generate()).toBe('Fix Login Bug')
  expect(state.run).toHaveBeenCalledTimes(1)
  expect(state.log).toHaveBeenCalledExactlyOnceWith('naming', 'generated a session name', {
    ms: 0,
    title: 'Fix Login Bug',
    model: 'vendor/chat-small',
    fastBoot: true,
  })
})

it('learns earlier failures only after an eventual success and logs errors in order', async () => {
  state.run
    .mockResolvedValueOnce({ stdout: '', error: 'Unknown provider' })
    .mockResolvedValueOnce({ stdout: '   ' })
  expect(await generate()).toBe('Fix Login Bug')
  expect(state.remember).toHaveBeenCalledExactlyOnceWith(
    expect.any(Object),
    plan.slice(0, 2),
    plan[2],
    'vendor',
  )
  expect(state.log).toHaveBeenCalledExactlyOnceWith('naming', 'generated a session name', {
    ms: 0,
    title: 'Fix Login Bug',
    model: 'default',
    fastBoot: false,
    errors: ['Unknown provider', 'empty reply'],
  })
})

it('stops on a timeout whose stdout sanitizes to no title', async () => {
  state.run.mockResolvedValueOnce({ stdout: '""', error: 'timed out after 30000ms' })
  expect(await generate()).toBeNull()
  expect(state.run).toHaveBeenCalledTimes(1)
  expect(state.remember).not.toHaveBeenCalled()
  expect(state.log).toHaveBeenCalledExactlyOnceWith('naming', 'no session name', {
    ms: 0,
    title: null,
    model: 'default',
    fastBoot: false,
    errors: ['timed out after 30000ms'],
  })
})

it('does not learn on total failure and retries the same plan on the next run', async () => {
  state.run.mockResolvedValue({ stdout: '', error: 'offline' })
  expect(await generate()).toBeNull()
  expect(await generate()).toBeNull()
  expect(state.run).toHaveBeenCalledTimes(6)
  expect(state.remember).not.toHaveBeenCalled()
  expect(state.plan.mock.calls[0]![0]).toBe(state.plan.mock.calls[1]![0])
  expect(state.log).toHaveBeenLastCalledWith('naming', 'no session name', {
    ms: 0,
    title: null,
    model: 'default',
    fastBoot: false,
    errors: ['offline', 'offline', 'offline'],
  })
})

it('returns null for unavailable pi without logging or executing', async () => {
  state.invoker.mockRejectedValue(new PiUnavailableError('missing'))
  expect(await generate()).toBeNull()
  expect(state.run).not.toHaveBeenCalled()
  expect(state.plan).not.toHaveBeenCalled()
  expect(state.log).not.toHaveBeenCalled()
})

it('retains rejection for unexpected invocation environment failures', async () => {
  state.invoker.mockRejectedValue(new Error('shell failed'))
  await expect(generate()).rejects.toThrow('shell failed')
  expect(state.run).not.toHaveBeenCalled()
  expect(state.log).not.toHaveBeenCalled()
})
