import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { planTitleRun, rememberTitleFailures, type TitleMemory } from './title-plan'
import { CLAUDE_TITLE_FALLBACK, type TitleAttempt } from './session-naming'

const state = vi.hoisted(() => ({ catalogue: vi.fn(), packages: vi.fn(), paths: vi.fn() }))
vi.mock('./catalogue', () => ({ catalogueModels: state.catalogue }))
vi.mock('@phosphor/session-runtime/pi/packages', () => ({ listPackages: state.packages }))
vi.mock('@phosphor/session-runtime/pi/package-resources', () => ({
  resolvePackagePaths: state.paths,
}))

const freshMemory = (): TitleMemory => ({
  fullBootProviders: new Set(),
  unusableTitleModels: new Set(),
})
const picked = { provider: 'vendor', id: 'chat-small' }
const fast: TitleAttempt = { model: picked, extensions: [] }
const full: TitleAttempt = { model: { ...picked }, extensions: null }
const fallback: TitleAttempt = { model: null, extensions: null }
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
  expect(await planTitleRun(memory, '/repo', settings, null)).toEqual([fast, full, fallback])
  expect(memory).toEqual(freshMemory())
})

it('learns full boot only for the same successful model and provider', async () => {
  const memory = freshMemory()
  rememberTitleFailures(memory, [fast], full, 'other')
  expect(memory.fullBootProviders).toEqual(new Set(['vendor']))
  expect(memory.unusableTitleModels.size).toBe(0)
  expect(await planTitleRun(memory, '/repo', settings, null)).toEqual([full, fallback])
  expect(await planTitleRun(freshMemory(), '/repo', settings, null)).toEqual([fast, full, fallback])
})

it('learns unusable models but not full boot when a different model succeeds', async () => {
  const memory = freshMemory()
  rememberTitleFailures(memory, [fast, full], fallback, 'vendor')
  expect(memory.unusableTitleModels).toEqual(new Set(['vendor/chat-small']))
  expect(memory.fullBootProviders.size).toBe(0)
  expect(await planTitleRun(memory, '/repo', settings, null)).toEqual([
    { model: null, extensions: [] },
    fallback,
  ])
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
  const plan = await planTitleRun(memory, '/repo', claudeSettings, CLAUDE_TITLE_FALLBACK)
  expect(plan).toEqual([
    { model: CLAUDE_TITLE_FALLBACK, extensions: ['/pkg/index.ts'] },
    { model: CLAUDE_TITLE_FALLBACK, extensions: null },
  ])
  expect(state.packages).toHaveBeenCalledWith('/repo')
  expect(state.paths).toHaveBeenCalledWith('/pkg')
  rememberTitleFailures(memory, [plan[0]!], plan[1]!, 'pi-claude-cli')
  state.packages.mockClear()
  expect(await planTitleRun(memory, '/repo', claudeSettings, CLAUDE_TITLE_FALLBACK)).toEqual([
    { model: CLAUDE_TITLE_FALLBACK, extensions: null },
  ])
  expect(state.packages).not.toHaveBeenCalled()
})

it('uses full Claude boot if package discovery fails', async () => {
  state.packages.mockRejectedValue(new Error('unavailable'))
  expect(
    await planTitleRun(
      freshMemory(),
      '/repo',
      { defaultProvider: 'pi-claude-cli' },
      CLAUDE_TITLE_FALLBACK,
    ),
  ).toEqual([{ model: CLAUDE_TITLE_FALLBACK, extensions: null }])
})

it('falls back immediately if catalogue discovery rejects', async () => {
  state.catalogue.mockRejectedValue(new Error('unavailable'))
  expect(await planTitleRun(freshMemory(), '/repo', settings, null)).toEqual([
    { model: null, extensions: [] },
    fallback,
  ])
})

it('does not learn on an unsuccessful run that only planned attempts', async () => {
  const memory = freshMemory()
  const original = await planTitleRun(memory, '/repo', settings, null)
  expect(await planTitleRun(memory, '/repo', settings, null)).toEqual(original)
  expect(memory).toEqual(freshMemory())
})
