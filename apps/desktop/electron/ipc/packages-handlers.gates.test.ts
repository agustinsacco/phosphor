import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  app: { isPackaged: false },
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  sender: { id: 17 },
  invalidateCatalogueModels: vi.fn(),
  invalidatePiCommands: vi.fn(),
  listPackages: vi.fn(),
  checkClaudeCliUpdate: vi.fn(),
  checkPackageUpdates: vi.fn(),
  claudeStatus: vi.fn(),
  detectBinaries: vi.fn(),
  runClaudeProviderTest: vi.fn(),
  runClaudeUpdate: vi.fn(),
  runPackageAction: vi.fn(),
  runPiInstall: vi.fn(),
}))
vi.mock('electron', () => ({ app: state.app }))
vi.mock('./handle', () => ({
  handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
    state.handlers.set(channel, handler),
}))
vi.mock('../pi/catalogue', () => ({
  invalidateCatalogueModels: state.invalidateCatalogueModels,
  invalidatePiCommands: state.invalidatePiCommands,
}))
vi.mock('@phosphor/session-runtime/pi/packages', () => ({ listPackages: state.listPackages }))
vi.mock('../pi/packages', () => ({
  checkClaudeCliUpdate: state.checkClaudeCliUpdate,
  checkPackageUpdates: state.checkPackageUpdates,
  claudeStatus: state.claudeStatus,
  detectBinaries: state.detectBinaries,
  runClaudeProviderTest: state.runClaudeProviderTest,
  runClaudeUpdate: state.runClaudeUpdate,
  runPackageAction: state.runPackageAction,
  runPiInstall: state.runPiInstall,
}))
import { registerPackagesHandlers } from './packages-handlers'

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = state.handlers.get(channel)
  if (!handler) throw new Error(`missing handler: ${channel}`)
  return handler({ sender: state.sender }, ...args)
}

beforeEach(() => {
  vi.resetAllMocks()
  state.app.isPackaged = false
  state.handlers.clear()
  vi.stubEnv('PHOSPHOR_PI_STUB', '/test/pi.cjs')
  vi.stubEnv('PHOSPHOR_CLAUDE_BIN', '/test/claude')
  registerPackagesHandlers()
})
afterEach(() => vi.unstubAllEnvs())

describe('packages handler executable gates', () => {
  it.each([
    { packaged: true, env: '/test/override', expected: undefined },
    { packaged: false, env: '/test/override', expected: '/test/override' },
    { packaged: false, env: '', expected: undefined },
    { packaged: false, env: undefined, expected: undefined },
  ])('forwards gated binaries for $packaged / $env', async ({ packaged, env, expected }) => {
    state.app.isPackaged = packaged
    vi.stubEnv('PHOSPHOR_PI_STUB', env)
    // Distinct values, so a handler that reads the wrong gate fails here.
    vi.stubEnv('PHOSPHOR_CLAUDE_BIN', env && `${env}-claude`)
    const claude = expected && `${expected}-claude`
    await invoke('packages:run', 'install', 'npm:test', 'project', '/workspace')
    expect(state.runPackageAction).toHaveBeenCalledWith(
      state.sender,
      'install',
      'npm:test',
      'project',
      '/workspace',
      expected,
      expect.any(Function),
    )
    await invoke('packages:testClaudeProvider')
    expect(state.runClaudeProviderTest).toHaveBeenCalledWith(state.sender, expected)
    await invoke('packages:detect')
    expect(state.detectBinaries).toHaveBeenCalledWith(claude)
    await invoke('packages:claudeStatus')
    expect(state.claudeStatus).toHaveBeenCalledWith(claude)
    await invoke('packages:updateClaudeCli')
    expect(state.runClaudeUpdate).toHaveBeenCalledWith(state.sender, claude)
  })

  it('reads environment and packaging at invocation, not registration', async () => {
    await invoke('packages:detect')
    expect(state.detectBinaries).toHaveBeenLastCalledWith('/test/claude')
    vi.stubEnv('PHOSPHOR_CLAUDE_BIN', '/test/changed')
    await invoke('packages:detect')
    expect(state.detectBinaries).toHaveBeenLastCalledWith('/test/changed')
    state.app.isPackaged = true
    await invoke('packages:detect')
    expect(state.detectBinaries).toHaveBeenLastCalledWith(undefined)
  })

  it('returns job results and invalidates both caches only on completion', async () => {
    const result = { jobId: 'install-job' }
    state.runPackageAction.mockReturnValue(result)
    expect(await invoke('packages:run', 'remove', 'npm:test', 'user')).toBe(result)
    expect(state.invalidateCatalogueModels).not.toHaveBeenCalled()
    expect(state.invalidatePiCommands).not.toHaveBeenCalled()
    const complete: unknown = state.runPackageAction.mock.calls[0]?.[6]
    if (typeof complete !== 'function') throw new Error('missing completion callback')
    complete()
    expect(state.invalidateCatalogueModels).toHaveBeenCalledOnce()
    expect(state.invalidatePiCommands).toHaveBeenCalledOnce()
    expect(state.invalidateCatalogueModels.mock.invocationCallOrder[0]).toBeLessThan(
      state.invalidatePiCommands.mock.invocationCallOrder[0]!,
    )
  })

  it.each([
    ['packages:run', state.runPackageAction],
    ['packages:testClaudeProvider', state.runClaudeProviderTest],
    ['packages:updateClaudeCli', state.runClaudeUpdate],
    ['packages:installPi', state.runPiInstall],
  ] as const)('preserves %s job results and errors', async (channel, job) => {
    const result = { jobId: channel }
    job.mockReturnValueOnce(result)
    expect(await invoke(channel, 'install', 'npm:test', 'user')).toBe(result)
    const error = new Error(`${channel} failed`)
    job.mockRejectedValueOnce(error)
    await expect(invoke(channel, 'install', 'npm:test', 'user')).rejects.toBe(error)
  })

  it('preserves package listing, update inputs and CLI version results', async () => {
    const packages = [{ source: 'npm:test' }]
    const updates = [{ source: 'npm:test', latest: '2.0.0' }]
    state.listPackages.mockResolvedValue(packages)
    state.checkPackageUpdates.mockResolvedValue(updates)
    state.checkClaudeCliUpdate.mockResolvedValue('2.0.0')
    expect(await invoke('packages:list', '/workspace')).toBe(packages)
    expect(await invoke('packages:checkUpdates', '/workspace')).toBe(updates)
    expect(state.listPackages).toHaveBeenCalledWith('/workspace')
    expect(state.checkPackageUpdates).toHaveBeenCalledWith(packages)
    expect(await invoke('packages:claudeCliLatest')).toBe('2.0.0')
    const error = new Error('listing failed')
    state.listPackages.mockRejectedValueOnce(error)
    await expect(invoke('packages:checkUpdates')).rejects.toBe(error)
  })
})
