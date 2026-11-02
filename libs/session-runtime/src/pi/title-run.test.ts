import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  planTitleRun,
  rememberTitleFailures,
  runTitleAttempts,
  titleRunEnv,
  type TitleMemory,
} from './title-run'
import { CLAUDE_TITLE_FALLBACK, type TitleAttempt } from './title-policy'

const state = vi.hoisted(() => ({
  catalogue: vi.fn(),
  packages: vi.fn(),
  paths: vi.fn(),
  print: vi.fn(),
}))
vi.mock('./print-mode', () => ({ runPrintMode: state.print }))
vi.mock('./packages', () => ({ listPackages: state.packages }))
vi.mock('./package-resources', () => ({ resolvePackagePaths: state.paths }))

const freshMemory = (): TitleMemory => ({
  fullBootProviders: new Set(),
  unusableTitleModels: new Set(),
})
const picked = { provider: 'vendor', id: 'chat-small' }
const fast: TitleAttempt = { model: picked, extensions: [] }
const full: TitleAttempt = { model: { ...picked }, extensions: null }
const fallback: TitleAttempt = { model: null, extensions: null }
const planFor = (
  memory: TitleMemory,
  defaults: { defaultProvider?: string; defaultModel?: string },
  fallback: TitleAttempt['model'],
) =>
  planTitleRun(memory, {
    cwd: '/repo',
    provider: defaults.defaultProvider,
    model: defaults.defaultModel,
    catalogue: state.catalogue,
    fallback,
  })
const settings = { defaultProvider: 'vendor', defaultModel: 'chat-large' }

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  state.catalogue.mockResolvedValue([
    { ...picked, cost: { input: 1, output: 1 } },
    { provider: 'vendor', id: 'chat-large', cost: { input: 10, output: 10 } },
  ])
  state.packages.mockResolvedValue([])
  state.paths.mockReturnValue({ extensions: [] })
})
afterEach(() => vi.useRealTimers())

it('plans picked fast boot, full boot, then the default without mutating memory', async () => {
  const memory = freshMemory()
  expect(await planFor(memory, settings, null)).toEqual([fast, full, fallback])
  expect(memory).toEqual(freshMemory())
})

it('learns full boot only for the same successful model and provider', async () => {
  const memory = freshMemory()
  rememberTitleFailures(memory, [fast], full, 'other')
  expect(memory.fullBootProviders).toEqual(new Set(['vendor']))
  expect(memory.unusableTitleModels.size).toBe(0)
  expect(await planFor(memory, settings, null)).toEqual([full, fallback])
  expect(await planFor(freshMemory(), settings, null)).toEqual([fast, full, fallback])
})

it('learns unusable models but not full boot when a different model succeeds', async () => {
  const memory = freshMemory()
  rememberTitleFailures(memory, [fast, full], fallback, 'vendor')
  expect(memory.unusableTitleModels).toEqual(new Set(['vendor/chat-small']))
  expect(memory.fullBootProviders.size).toBe(0)
  expect(await planFor(memory, settings, null)).toEqual([{ model: null, extensions: [] }, fallback])
})

it('does not confuse matching model ids on different providers', () => {
  const memory = freshMemory()
  rememberTitleFailures(
    memory,
    [fast],
    {
      model: { provider: 'other', id: picked.id },
      extensions: null,
    },
    'vendor',
  )
  expect(memory.fullBootProviders.size).toBe(0)
  expect(memory.unusableTitleModels).toEqual(new Set(['vendor/chat-small']))
})

it.each(['vendor', undefined])('learns default full boot with provider %s', (provider) => {
  const memory = freshMemory()
  rememberTitleFailures(memory, [{ model: null, extensions: [] }], fallback, provider)
  expect(memory.fullBootProviders).toEqual(new Set([provider ?? '']))
  expect(memory.unusableTitleModels.size).toBe(0)
})

it('does not learn from a first-attempt success', () => {
  const memory = freshMemory()
  rememberTitleFailures(memory, [], fast, 'vendor')
  expect(memory).toEqual(freshMemory())
})

it('uses executable Claude extensions and skips package lookup after full-boot learning', async () => {
  const memory = freshMemory()
  const claudeSettings = { defaultProvider: 'pi-claude-cli' }
  state.packages.mockResolvedValue([
    { name: '@saccolabs/pi-claude-cli', installed: false, installPath: '/wrong' },
    { name: '@saccolabs/pi-claude-cli', installed: true, installPath: '/pkg' },
  ])
  state.paths.mockReturnValue({ extensions: ['/pkg/index.ts'] })
  const plan = await planFor(memory, claudeSettings, CLAUDE_TITLE_FALLBACK)
  expect(plan).toEqual([
    { model: CLAUDE_TITLE_FALLBACK, extensions: ['/pkg/index.ts'] },
    { model: CLAUDE_TITLE_FALLBACK, extensions: null },
  ])
  expect(state.packages).toHaveBeenCalledWith('/repo', undefined)
  expect(state.paths).toHaveBeenCalledWith('/pkg')
  rememberTitleFailures(memory, [plan[0]!], plan[1]!, 'pi-claude-cli')
  state.packages.mockClear()
  expect(await planFor(memory, claudeSettings, CLAUDE_TITLE_FALLBACK)).toEqual([
    { model: CLAUDE_TITLE_FALLBACK, extensions: null },
  ])
  expect(state.packages).not.toHaveBeenCalled()
})

it('uses full Claude boot if package discovery fails', async () => {
  state.packages.mockRejectedValue(new Error('unavailable'))
  expect(
    await planFor(freshMemory(), { defaultProvider: 'pi-claude-cli' }, CLAUDE_TITLE_FALLBACK),
  ).toEqual([{ model: CLAUDE_TITLE_FALLBACK, extensions: null }])
})

it('falls back immediately if catalogue discovery rejects', async () => {
  state.catalogue.mockRejectedValue(new Error('unavailable'))
  expect(await planFor(freshMemory(), settings, null)).toEqual([
    { model: null, extensions: [] },
    fallback,
  ])
})

it('does not learn on an unsuccessful run that only planned attempts', async () => {
  const memory = freshMemory()
  const original = await planFor(memory, settings, null)
  expect(await planFor(memory, settings, null)).toEqual(original)
  expect(memory).toEqual(freshMemory())
})

const run = (memory?: TitleMemory, existingNames: string[] = []) =>
  runTitleAttempts({
    pi: { binaryPath: '/bin/pi', prefixArgs: ['entry.js'] },
    cwd: '/repo',
    env: { PATH: '/bin' },
    message: 'fix login',
    existingNames,
    plan: [fast, full, fallback],
    memory,
    defaultProvider: 'vendor',
    print: { timeoutMs: 30_000, maxOutputBytes: 4096, overflow: 'fail' },
  })

it('runs each attempt with the prompt last and the caller print limits', async () => {
  state.print.mockResolvedValue({ stdout: 'Here is a title:\n"Fix Login Bug."\n' })
  expect(await run(undefined, ['fix login bug'])).toEqual({
    title: 'Fix Login Bug 2',
    failures: [],
    used: fast,
  })
  const [binary, args, options] = state.print.mock.calls[0]!
  expect(binary).toBe('/bin/pi')
  expect(args[0]).toBe('entry.js')
  expect(args).toEqual(expect.arrayContaining(['-p', '--no-extensions', '--model', 'chat-small']))
  expect(args.at(-1)).toContain('2-5 words')
  expect(args.at(-1)).toContain('- fix login bug')
  expect(options).toEqual({
    cwd: '/repo',
    env: { PATH: '/bin' },
    timeoutMs: 30_000,
    maxOutputBytes: 4096,
    overflow: 'fail',
  })
})

it('retries to the fallback, learns only from the eventual success, and keeps fixed reasons', async () => {
  const memory = freshMemory()
  state.print
    .mockResolvedValueOnce({ stdout: '', error: 'exited 1: Unknown provider', reason: 'exit' })
    .mockResolvedValueOnce({ stdout: '   ' })
    .mockResolvedValueOnce({ stdout: 'Fix Login Bug' })
  const result = await run(memory)
  expect(result.title).toBe('Fix Login Bug')
  expect(result.used).toBe(fallback)
  expect(result.failures).toEqual([
    { reason: 'exit', error: 'exited 1: Unknown provider' },
    { reason: 'empty', error: 'empty reply' },
  ])
  expect(memory.unusableTitleModels).toEqual(new Set(['vendor/chat-small']))
})

it.each(['timeout', 'aborted'] as const)('stops after %s and learns nothing', async (reason) => {
  const memory = freshMemory()
  state.print.mockResolvedValue({ stdout: '""', error: reason, reason })
  expect(await run(memory)).toEqual({ title: null, failures: [{ reason, error: reason }] })
  expect(state.print).toHaveBeenCalledTimes(1)
  expect(memory).toEqual(freshMemory())
})

it('accepts partial stdout when the successful attempt timed out', async () => {
  state.print.mockResolvedValue({ stdout: 'Fix Login Bug', error: 'timed out', reason: 'timeout' })
  expect((await run()).title).toBe('Fix Login Bug')
})

it('builds the run env: base, pi-owned Claude context, one-shot exit, then the account', () => {
  expect(
    titleRunEnv(
      { PATH: '/bin', PI_CLAUDE_CLI_KEEPALIVE_MS: '999' },
      { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/accounts/second' },
    ),
  ).toEqual({
    PATH: '/bin',
    PI_CLAUDE_CLI_CONTEXT: 'pi',
    PI_CLAUDE_CLI_KEEPALIVE_MS: '0',
    PI_CLAUDE_CLI_EPHEMERAL: '1',
    CLAUDE_SECURESTORAGE_CONFIG_DIR: '/accounts/second',
  })
})
