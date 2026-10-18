import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcInvokeChannel, IpcInvokeMap } from '@shared/ipc'
import type * as ModelCatalogue from '../pi/model-catalogue'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  health: vi.fn(),
  stub: vi.fn(),
  env: vi.fn(),
  models: vi.fn(),
  configModels: vi.fn(),
  commands: vi.fn(),
  invalidateCommands: vi.fn(),
  broadcast: vi.fn(),
  settings: vi.fn(),
  scoped: vi.fn(),
  patch: vi.fn(),
  check: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  resources: vi.fn(),
  web: vi.fn(),
  patchWeb: vi.fn(),
}))
vi.mock('./handle', () => ({
  handle: (name: string, cb: (...args: unknown[]) => unknown) => state.handlers.set(name, cb),
}))
vi.mock('../pi/agent-settings', () => ({
  listCatalogueModels: state.configModels,
  readAgentSettingsScoped: state.scoped,
  patchAgentSettings: state.patch,
  checkAgentSettings: state.check,
  readConfigFile: state.readFile,
  writeConfigFile: state.writeFile,
  listPiResources: state.resources,
  readWebSearchConfig: state.web,
  patchWebSearchConfig: state.patchWeb,
}))
vi.mock('@phosphor/session-runtime/pi/agent-settings', () => ({
  readAgentSettings: state.settings,
}))
vi.mock('../pi/model-catalogue', async (original) => ({
  ...(await original<typeof ModelCatalogue>()),
  listModelsViaRpc: state.models,
}))
vi.mock('../pi/health', () => ({ cachedPiHealth: state.health }))
vi.mock('../pi/stub', () => ({ piStubPath: state.stub }))
vi.mock('../pi/shell-env', () => ({ piProcessEnv: state.env }))
vi.mock('../pi/commands', () => ({
  probeCommandsCached: state.commands,
  invalidateCommandCaches: state.invalidateCommands,
}))
vi.mock('../broadcast', () => ({ broadcast: state.broadcast }))
vi.mock('../debug-log', () => ({ log: vi.fn() }))

const models = [{ id: 'm', name: 'Model', provider: 'p', reasoning: false }]

async function invoke<C extends IpcInvokeChannel>(
  channel: C,
  ...args: IpcInvokeMap[C]['args']
): Promise<IpcInvokeMap[C]['result']> {
  return state.handlers.get(channel)!(null, ...args) as IpcInvokeMap[C]['result']
}

beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(0)
  state.handlers.clear()
  state.health.mockResolvedValue({ ok: true, binaryPath: '/bin/pi' })
  state.env.mockResolvedValue({ PATH: '/shell/bin' })
  state.models.mockResolvedValue(models)
  state.configModels.mockResolvedValue(models)
  state.commands.mockResolvedValue([{ name: 'plan', description: 'Plan' }])
  const { registerPiConfigHandlers } = await import('./pi-config-handlers')
  registerPiConfigHandlers()
})

afterEach(() => vi.useRealTimers())

describe('pi config handler characterization', () => {
  it('caches pi catalogue results for five minutes', async () => {
    expect(await invoke('pi:catalogueModels')).toEqual({ models, source: 'pi' })
    vi.advanceTimersByTime(299_999)
    await invoke('pi:catalogueModels')
    expect(state.models).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    await invoke('pi:catalogueModels')
    expect(state.models).toHaveBeenCalledTimes(2)
  })

  it('retries pi after twenty seconds of a config fallback', async () => {
    state.models.mockRejectedValue(new Error('boot failed'))
    expect(await invoke('pi:catalogueModels')).toEqual({ models, source: 'config' })
    vi.advanceTimersByTime(19_999)
    await invoke('pi:catalogueModels')
    expect(state.models).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    await invoke('pi:catalogueModels')
    expect(state.models).toHaveBeenCalledTimes(2)
  })

  it('does not cache an empty catalogue', async () => {
    state.health.mockResolvedValue({ ok: false })
    state.configModels.mockResolvedValue([])
    expect(await invoke('pi:catalogueModels')).toEqual({ models: [], source: 'config' })
    state.configModels.mockResolvedValue(models)
    expect(await invoke('pi:catalogueModels')).toEqual({ models, source: 'config' })
    expect(state.configModels).toHaveBeenCalledTimes(2)
    expect(state.models).not.toHaveBeenCalled()
  })

  it('returns an empty result when health discovery rejects', async () => {
    state.health.mockRejectedValue(new Error('discovery failed'))
    expect(await invoke('pi:catalogueModels')).toEqual({ models: [], source: 'config' })
    expect(state.configModels).not.toHaveBeenCalled()
  })

  it('uses config models when the launch environment cannot be loaded', async () => {
    state.env.mockRejectedValue(new Error('environment failed'))
    expect(await invoke('pi:catalogueModels')).toEqual({ models, source: 'config' })
    expect(state.models).not.toHaveBeenCalled()
  })

  it('forwards catalogue launch prefixes and the shell environment', async () => {
    state.health.mockResolvedValue({ ok: true, binaryPath: '/node', prefixArgs: ['/pi.js'] })
    await invoke('pi:catalogueModels')
    expect(state.models).toHaveBeenCalledExactlyOnceWith('/node', ['/pi.js'], {
      PATH: '/shell/bin',
    })
  })

  it('isolates stub catalogue discovery from real pi and the shell', async () => {
    state.stub.mockReturnValue('/stub.cjs')
    await invoke('pi:catalogueModels')
    expect(state.models).toHaveBeenCalledExactlyOnceWith(process.execPath, ['/stub.cjs'])
    expect(state.health).not.toHaveBeenCalled()
    expect(state.env).not.toHaveBeenCalled()
  })

  it('forwards workspace and launch options to the command cache', async () => {
    state.health.mockResolvedValue({ ok: true, binaryPath: '/node', prefixArgs: ['/pi.js'] })
    expect(await invoke('pi:commands', '/repo')).toEqual({
      commands: [{ name: 'plan', description: 'Plan' }],
    })
    expect(state.commands).toHaveBeenCalledExactlyOnceWith({
      workspacePath: '/repo',
      binaryPath: '/node',
      prefixArgs: ['/pi.js'],
      env: { PATH: '/shell/bin' },
    })
  })

  it('uses a minimal stub command environment without a workspace', async () => {
    state.stub.mockReturnValue('/stub.cjs')
    await invoke('pi:commands')
    expect(state.commands).toHaveBeenCalledExactlyOnceWith({
      binaryPath: process.execPath,
      prefixArgs: ['/stub.cjs'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    })
    expect(state.health).not.toHaveBeenCalled()
    expect(state.env).not.toHaveBeenCalled()
  })

  it('omits absent launch prefixes and empty workspace arguments', async () => {
    await invoke('pi:commands', '')
    expect(state.commands).toHaveBeenCalledExactlyOnceWith({
      binaryPath: '/bin/pi',
      env: { PATH: '/shell/bin' },
    })
  })

  it.each([undefined, 'upgrade pi'])('preserves missing-pi command errors: %s', async (message) => {
    state.health.mockResolvedValue({ ok: false, message })
    expect(await invoke('pi:commands')).toEqual({
      commands: [],
      error: message ?? 'pi is not installed',
    })
    expect(state.commands).not.toHaveBeenCalled()
  })

  it.each([new Error('probe failed'), 'probe failed'])(
    'wraps rejected command probes: %s',
    async (cause) => {
      state.commands.mockRejectedValue(cause)
      expect(await invoke('pi:commands')).toEqual({ commands: [], error: 'probe failed' })
    },
  )

  it('forwards settings, file and web config arguments unchanged', async () => {
    await invoke('pi:agentSettings', '/repo')
    await invoke('pi:agentSettingsScoped', '/repo')
    await invoke('pi:readConfigFile', 'settings')
    await invoke('pi:writeConfigFile', 'settings', '{}')
    await invoke('pi:listResources')
    await invoke('pi:webSearchConfig')
    await invoke('pi:patchWebSearchConfig', { provider: 'brave' })
    expect(state.settings).toHaveBeenCalledExactlyOnceWith('/repo')
    expect(state.scoped).toHaveBeenCalledExactlyOnceWith('/repo')
    expect(state.readFile).toHaveBeenCalledExactlyOnceWith('settings')
    expect(state.writeFile).toHaveBeenCalledExactlyOnceWith('settings', '{}')
    expect(state.resources).toHaveBeenCalledExactlyOnceWith()
    expect(state.web).toHaveBeenCalledExactlyOnceWith()
    expect(state.patchWeb).toHaveBeenCalledExactlyOnceWith({ provider: 'brave' })
  })

  it('strips parsed malformed settings contents and preserves null project health', async () => {
    state.check.mockResolvedValue({
      global: { exists: true, malformed: true, error: 'bad JSON', content: { secret: 'value' } },
      project: null,
    })
    expect(await invoke('pi:checkAgentSettings', '/repo')).toEqual({
      global: { exists: true, malformed: true, error: 'bad JSON' },
      project: null,
    })
    expect(state.check).toHaveBeenCalledExactlyOnceWith('/repo')
    state.check.mockResolvedValue({
      global: { exists: false, malformed: false },
      project: { exists: true, malformed: false, content: {} },
    })
    expect(await invoke('pi:checkAgentSettings')).toEqual({
      global: { exists: false, malformed: false, error: undefined },
      project: { exists: true, malformed: false, error: undefined },
    })
  })

  it('invalidates models before a successful mutation and commands only after it', async () => {
    await invoke('pi:catalogueModels')
    state.patch.mockImplementation(async () => {
      await invoke('pi:catalogueModels')
      expect(state.models).toHaveBeenCalledTimes(2)
      expect(state.invalidateCommands).not.toHaveBeenCalled()
      expect(state.broadcast).not.toHaveBeenCalled()
      return { ok: true }
    })
    expect(await invoke('pi:patchAgentSettings', 'project', '/repo', { theme: 'dark' })).toEqual({
      ok: true,
    })
    expect(state.patch).toHaveBeenCalledExactlyOnceWith('project', '/repo', { theme: 'dark' })
    expect(state.invalidateCommands).toHaveBeenCalledOnce()
    expect(state.broadcast).toHaveBeenCalledExactlyOnceWith('pi:commandsChanged', {})
    expect(state.invalidateCommands.mock.invocationCallOrder[0]).toBeLessThan(
      state.broadcast.mock.invocationCallOrder[0]!,
    )
  })

  it('invalidates models but never commands when a mutation fails', async () => {
    await invoke('pi:catalogueModels')
    state.patch.mockRejectedValue(new Error('write failed'))
    await expect(invoke('pi:patchAgentSettings', 'global', undefined, {})).rejects.toThrow(
      'write failed',
    )
    await invoke('pi:catalogueModels')
    expect(state.models).toHaveBeenCalledTimes(2)
    expect(state.invalidateCommands).not.toHaveBeenCalled()
    expect(state.broadcast).not.toHaveBeenCalled()
  })
})
