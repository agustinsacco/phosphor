import { beforeEach, expect, it, vi } from 'vitest'
import type { SessionStartupRuntime } from '@phosphor/session-runtime/pi/session-startup'
import type * as FsPromises from 'node:fs/promises'
const state = vi.hoisted(() => ({
  factory: vi.fn(),
  embeds: vi.fn(),
  setMemory: vi.fn(),
  audit: vi.fn(),
  log: vi.fn(),
  prepare: vi.fn(),
  dispose: vi.fn(),
  stopEmbeddings: vi.fn(),
  registry: {},
  sessions: {},
  paths: {},
  openStore: vi.fn(),
  packaged: false,
  databaseStat: vi.fn(),
}))
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return state.packaged
    },
    getPath: () => '/profile',
    getAppPath: () => '/repo/apps/desktop',
  },
}))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  stat: state.databaseStat,
}))
vi.mock('../registry', () => ({ registry: state.registry }))
vi.mock('../pi/session-runtime', () => ({
  desktopSessions: state.sessions,
  setSessionMemory: state.setMemory,
}))
vi.mock('../pi/session-path-lock', () => ({ sessionPaths: state.paths }))
vi.mock('@phosphor/brain-runtime/tool-audit', () => ({ verifyBrainTools: state.audit }))
vi.mock('../debug-log', () => ({ log: state.log }))
vi.mock('./embedding-service', () => ({ createBrainEmbeddings: state.embeds }))
vi.mock('@phosphor/brain-runtime/service', () => ({ createBrainService: state.factory }))
vi.mock('./memory-service', () => ({ createDesktopMemory: state.openStore }))
vi.mock('./processor-resolver', () => ({ resolveBrainProcessor: vi.fn() }))
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  state.packaged = false
  state.databaseStat
    .mockReset()
    .mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
  state.prepare.mockReset().mockResolvedValue(undefined)
  state.dispose.mockReset().mockResolvedValue(undefined)
  state.embeds.mockReturnValue({ dispose: state.stopEmbeddings })
  state.factory.mockReset().mockResolvedValue({
    api: {},
    memory: { prepare: state.prepare },
    dispose: state.dispose,
  })
})
it('is lazy, shares the real session service and locks, and closes before further admission', async () => {
  const runtime = await import('./runtime')
  runtime.installBrainMemory()
  expect(state.factory).not.toHaveBeenCalled()
  const a = runtime.brainService(),
    b = runtime.brainService()
  expect(a).toBe(b)
  await a
  expect(state.factory).toHaveBeenCalledWith(
    expect.objectContaining({
      directory: '/profile/brain',
      sessions: state.sessions,
      registry: state.registry,
      sessionPaths: state.paths,
      resources: {
        workingExtension: '/repo/libs/pi-extensions/brain-ext/brain.mjs',
        processorExtension: '/repo/libs/pi-extensions/brain-ext/brain-processor.mjs',
      },
      openStore: expect.any(Function) as unknown,
    }),
  )
  const options = state.factory.mock.calls[0]![0] as { openStore(directory: string): unknown }
  options.openStore('/profile/brain')
  expect(state.openStore).toHaveBeenCalledWith(
    '/profile/brain',
    expect.stringMatching(/brain-memory-worker\.js$/),
  )
  expect(state.embeds).toHaveBeenCalledWith(
    expect.objectContaining({ directory: '/profile/brain/embeddings' }),
  )
  await runtime.disposeBrain()
  expect(state.dispose).toHaveBeenCalledOnce()
  await expect(runtime.brainService()).rejects.toThrow('shutting down')
})
it('reads empty learning metadata without creating local storage on shell startup', async () => {
  const runtime = await import('./runtime')
  expect(await runtime.learningInventory()).toEqual({
    items: [],
    truncated: false,
    policy: { enabled: false, workspaces: [], policyEpoch: 0 },
  })
  expect(state.factory).not.toHaveBeenCalled()
  expect(state.embeds).not.toHaveBeenCalled()
  expect(state.databaseStat).toHaveBeenCalledWith('/profile/brain/memory.sqlite')
})
it('does not fail ordinary startup on an unavailable Brain and retries its next acquisition', async () => {
  const runtime = await import('./runtime')
  state.factory.mockRejectedValueOnce(new Error('offline'))
  runtime.installBrainMemory()
  const memory = state.setMemory.mock.calls[0]![0] as NonNullable<SessionStartupRuntime['memory']>
  await expect(memory.prepare({ workspacePath: '/repo' })).resolves.toBeUndefined()
  expect(state.stopEmbeddings).toHaveBeenCalledOnce()
  expect(state.log).toHaveBeenCalledOnce()
  await memory.prepare({ workspacePath: '/repo' })
  expect(state.factory).toHaveBeenCalledTimes(2)
  expect(state.prepare).toHaveBeenCalledWith({ workspacePath: '/repo' })
  await runtime.disposeBrain()
})

it('does not create a service, worker or database for a fresh-profile exclusion check', async () => {
  const runtime = await import('./runtime')
  await expect(runtime.brainSourceExcluded('native-source')).resolves.toBe(false)
  expect(state.databaseStat).toHaveBeenCalledWith('/profile/brain/memory.sqlite')
  expect(state.factory).not.toHaveBeenCalled()
  expect(state.openStore).not.toHaveBeenCalled()
  expect(state.embeds).not.toHaveBeenCalled()
})
it('checks existing historical exclusion without a preference or recall gate', async () => {
  state.databaseStat.mockResolvedValue({ isFile: () => true })
  const excludedSource = vi.fn(async () => true)
  state.factory.mockResolvedValue({ excludedSource, dispose: state.dispose })
  const runtime = await import('./runtime')
  await expect(runtime.brainSourceExcluded('native-source')).resolves.toBe(true)
  expect(excludedSource).toHaveBeenCalledExactlyOnceWith('native-source')
  await runtime.disposeBrain()
})
it.each(['EACCES', 'EIO'])(
  'does not treat %s checking the existing authority as no store',
  async (code) => {
    state.databaseStat.mockRejectedValue(
      Object.assign(new Error('Synthetic stat failure'), { code }),
    )
    const runtime = await import('./runtime')
    await expect(runtime.brainSourceExcluded('native-source')).rejects.toThrow(
      'Synthetic stat failure',
    )
    expect(state.factory).not.toHaveBeenCalled()
  },
)
it('propagates an existing worker failure instead of returning not-excluded', async () => {
  state.databaseStat.mockResolvedValue({ isFile: () => true })
  state.factory.mockResolvedValue({
    excludedSource: vi.fn(async () => {
      throw new Error('Synthetic worker failure')
    }),
    dispose: state.dispose,
  })
  const runtime = await import('./runtime')
  await expect(runtime.brainSourceExcluded('native-source')).rejects.toThrow(
    'Synthetic worker failure',
  )
  await runtime.disposeBrain()
  await expect(runtime.brainSourceExcluded('native-source')).rejects.toThrow('shutting down')
})
it('refuses a non-file authority rather than silently opening a replacement', async () => {
  state.databaseStat.mockResolvedValue({ isFile: () => false })
  const runtime = await import('./runtime')
  await expect(runtime.brainSourceExcluded('native-source')).rejects.toThrow('not a regular file')
  expect(state.factory).not.toHaveBeenCalled()
})
it('rejects an invalid authority result rather than interpreting it as no exclusion', async () => {
  state.databaseStat.mockResolvedValue({ isFile: () => true })
  state.factory.mockResolvedValue({
    excludedSource: vi.fn(async () => undefined),
    dispose: state.dispose,
  })
  const runtime = await import('./runtime')
  await expect(runtime.brainSourceExcluded('native-source')).rejects.toThrow(
    'authority unavailable',
  )
  await runtime.disposeBrain()
})
