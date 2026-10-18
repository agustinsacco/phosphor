import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ModelCatalogue from './model-catalogue'

const state = vi.hoisted(() => ({
  health: vi.fn(),
  stub: vi.fn(),
  env: vi.fn(),
  models: vi.fn(),
  configModels: vi.fn(),
  clients: vi.fn(),
  spawn: vi.fn(),
  request: vi.fn(),
  dispose: vi.fn(),
  broadcast: vi.fn(),
}))
vi.mock('./agent-settings', () => ({ listCatalogueModels: state.configModels }))
vi.mock('./model-catalogue', async (original) => ({
  ...(await original<typeof ModelCatalogue>()),
  listModelsViaRpc: state.models,
}))
vi.mock('./health', () => ({ cachedPiHealth: state.health }))
vi.mock('./stub', () => ({ piStubPath: state.stub }))
vi.mock('./shell-env', () => ({ piProcessEnv: state.env }))
vi.mock('./desktop-rpc-client', () => ({
  PiRpcClient: class {
    spawn = state.spawn
    request = state.request
    dispose = state.dispose
    constructor(options: unknown) {
      state.clients(options)
    }
  },
}))
vi.mock('../broadcast', () => ({ broadcast: state.broadcast }))
vi.mock('../debug-log', () => ({ log: vi.fn() }))

const models = [{ id: 'm', name: 'Model', provider: 'p', reasoning: false }]
const commands = [{ name: 'plan', description: 'Plan' }]
const response = { success: true, data: { commands } }

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(0)
  state.health.mockResolvedValue({ ok: true, binaryPath: '/bin/pi' })
  state.env.mockResolvedValue({ PATH: '/shell/bin' })
  state.models.mockResolvedValue(models)
  state.configModels.mockResolvedValue(models)
  state.request.mockResolvedValue(response)
  state.dispose.mockResolvedValue(undefined)
})

afterEach(() => vi.useRealTimers())

describe('catalogue service', () => {
  it('deduplicates concurrent picker and session-naming loads', async () => {
    const { catalogueResult, catalogueModels } = await import('./catalogue')
    let finish!: (value: typeof models) => void
    state.models.mockReturnValue(new Promise<typeof models>((resolve) => (finish = resolve)))
    const picker = catalogueResult()
    const naming = catalogueModels()
    await vi.waitFor(() => expect(state.models).toHaveBeenCalledOnce())
    finish(models)
    expect(await picker).toEqual({ models, source: 'pi' })
    expect(await naming).toEqual(models)
    expect(state.models).toHaveBeenCalledOnce()
  })

  it('expires pi results at five minutes', async () => {
    const { catalogueResult } = await import('./catalogue')
    await catalogueResult()
    vi.advanceTimersByTime(299_999)
    await catalogueResult()
    expect(state.models).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(1)
    await catalogueResult()
    expect(state.models).toHaveBeenCalledTimes(2)
  })

  it('uses a twenty-second no-pi fallback before trying newly installed pi', async () => {
    const { catalogueResult } = await import('./catalogue')
    state.health.mockResolvedValue({ ok: false })
    expect(await catalogueResult()).toEqual({ models, source: 'config' })
    expect(state.models).not.toHaveBeenCalled()
    expect(state.env).not.toHaveBeenCalled()
    state.health.mockResolvedValue({ ok: true, binaryPath: '/new/pi' })
    vi.advanceTimersByTime(19_999)
    expect(await catalogueResult()).toEqual({ models, source: 'config' })
    vi.advanceTimersByTime(1)
    expect(await catalogueResult()).toEqual({ models, source: 'pi' })
    expect(state.models).toHaveBeenCalledExactlyOnceWith('/new/pi', [], {
      PATH: '/shell/bin',
    })
  })

  it('does not cache empty results and keeps session-naming rejection distinct', async () => {
    const { catalogueResult, catalogueModels } = await import('./catalogue')
    state.models.mockResolvedValue([])
    state.configModels.mockResolvedValue([])
    expect(await catalogueResult()).toEqual({ models: [], source: 'config' })
    await expect(catalogueModels()).rejects.toThrow('no models available')
    state.models.mockResolvedValue(models)
    expect(await catalogueModels()).toEqual(models)
    expect(state.models).toHaveBeenCalledTimes(3)
  })

  it('reloads immediately on catalogue invalidation', async () => {
    const { catalogueResult, invalidateCatalogueModels } = await import('./catalogue')
    await catalogueResult()
    invalidateCatalogueModels()
    await catalogueResult()
    expect(state.models).toHaveBeenCalledTimes(2)
    expect(state.broadcast).not.toHaveBeenCalled()
  })

  it('never discovers real pi or loads the shell environment for stub probes', async () => {
    const { catalogueResult, piCommands } = await import('./catalogue')
    state.stub.mockReturnValue('/stub.cjs')
    expect(await catalogueResult()).toEqual({ models, source: 'pi' })
    expect(await piCommands('/repo')).toEqual({ commands })
    expect(state.models).toHaveBeenCalledExactlyOnceWith(process.execPath, ['/stub.cjs'])
    expect(state.clients).toHaveBeenCalledExactlyOnceWith({
      cwd: '/repo',
      binaryPath: process.execPath,
      prefixArgs: ['/stub.cjs'],
      noSession: true,
      env: { ELECTRON_RUN_AS_NODE: '1' },
    })
    expect(state.health).not.toHaveBeenCalled()
    expect(state.env).not.toHaveBeenCalled()
  })
})

describe('command result service', () => {
  it('deduplicates concurrent command probes for one folder', async () => {
    const { piCommands } = await import('./catalogue')
    let finish!: (value: typeof response) => void
    state.request.mockReturnValue(new Promise<typeof response>((resolve) => (finish = resolve)))
    const first = piCommands('/repo')
    const second = piCommands('/repo')
    await vi.waitFor(() => expect(state.request).toHaveBeenCalledOnce())
    finish(response)
    expect(await first).toEqual({ commands })
    expect(await second).toEqual({ commands })
    expect(state.request).toHaveBeenCalledExactlyOnceWith({ type: 'get_commands' })
    expect(state.spawn).toHaveBeenCalledOnce()
    expect(state.dispose).toHaveBeenCalledOnce()
  })

  it('keeps command caches per folder and expires them at sixty seconds', async () => {
    const { piCommands } = await import('./catalogue')
    await Promise.all([piCommands('/one'), piCommands('/two')])
    expect(state.spawn).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(59_999)
    await piCommands('/one')
    expect(state.spawn).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1)
    await piCommands('/one')
    expect(state.spawn).toHaveBeenCalledTimes(3)
  })

  it('invalidates all folders before delivering the commands-changed notification', async () => {
    const { piCommands, invalidatePiCommands } = await import('./catalogue')
    await Promise.all([piCommands('/one'), piCommands('/two')])
    let reload: Promise<unknown> | undefined
    state.broadcast.mockImplementation(() => {
      reload = Promise.all([piCommands('/one'), piCommands('/two')])
    })
    invalidatePiCommands()
    expect(state.broadcast).toHaveBeenCalledExactlyOnceWith('pi:commandsChanged', {})
    await reload
    expect(state.spawn).toHaveBeenCalledTimes(4)
  })

  it('does not spawn for missing pi and preserves the legacy default error', async () => {
    const { piCommands } = await import('./catalogue')
    state.health.mockResolvedValue({ ok: false })
    expect(await piCommands()).toEqual({ commands: [], error: 'pi is not installed' })
    expect(state.spawn).not.toHaveBeenCalled()
    expect(state.env).not.toHaveBeenCalled()
    state.health.mockResolvedValue({ ok: false, message: 'upgrade pi' })
    expect(await piCommands()).toEqual({ commands: [], error: 'upgrade pi' })
  })

  it('reads unhealthy pi once per command call and reports that reading', async () => {
    const { piCommands } = await import('./catalogue')
    state.health.mockReset()
    state.health
      .mockResolvedValueOnce({ ok: false, message: 'first reading' })
      .mockResolvedValue({ ok: false, message: 'second reading' })
    expect(await piCommands()).toEqual({ commands: [], error: 'first reading' })
    expect(state.health).toHaveBeenCalledTimes(1)
  })

  it('retries failed command probes without caching their errors', async () => {
    const { piCommands } = await import('./catalogue')
    state.request.mockRejectedValueOnce(new Error('probe failed'))
    expect(await piCommands('/repo')).toEqual({ commands: [], error: 'probe failed' })
    expect(await piCommands('/repo')).toEqual({ commands })
    expect(state.spawn).toHaveBeenCalledTimes(2)
    expect(state.dispose).toHaveBeenCalledTimes(2)
  })

  it('passes real launch prefixes and the current shell environment', async () => {
    const { piCommands } = await import('./catalogue')
    state.health.mockResolvedValue({ ok: true, binaryPath: '/node', prefixArgs: ['/pi.js'] })
    await piCommands('/repo')
    expect(state.clients).toHaveBeenCalledExactlyOnceWith({
      cwd: '/repo',
      binaryPath: '/node',
      prefixArgs: ['/pi.js'],
      noSession: true,
      env: { PATH: '/shell/bin' },
    })
  })
})
