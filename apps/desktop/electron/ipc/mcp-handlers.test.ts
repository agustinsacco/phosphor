import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcInvokeChannel, IpcInvokeMap } from '@shared/ipc'
import type { ConnectorAuthState } from '@shared/models'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  readConfigs: vi.fn(),
  readFile: vi.fn(),
  remove: vi.fn(),
  enable: vi.fn(),
  upsert: vi.fn(),
  writeFile: vi.fn(),
  plan: vi.fn(),
  migrate: vi.fn(),
  cancel: vi.fn(),
  list: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  health: vi.fn(),
  env: vi.fn(),
  stub: vi.fn(),
  broadcast: vi.fn(),
  invalidate: vi.fn(),
}))
vi.mock('./handle', () => ({
  handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
    state.handlers.set(channel, handler),
}))
vi.mock('../pi/mcp-config', () => ({
  readMcpConfigs: state.readConfigs,
  readMcpFile: state.readFile,
  removeMcpServer: state.remove,
  setMcpServerEnabled: state.enable,
  upsertMcpServer: state.upsert,
  writeMcpFile: state.writeFile,
}))
vi.mock('../pi/mcp-migration', () => ({
  planMcpMigration: state.plan,
  runMcpMigration: state.migrate,
}))
vi.mock('../pi/mcp-cli', () => ({
  cancelMcpLogin: state.cancel,
  listMcpServers: state.list,
  loginMcpServer: state.login,
  logoutMcpServer: state.logout,
}))
vi.mock('../pi/health', () => ({ checkPiHealth: state.health }))
vi.mock('../pi/shell-env', () => ({ piProcessEnv: state.env }))
vi.mock('../pi/stub', () => ({ piStubPath: state.stub }))
vi.mock('../broadcast', () => ({ broadcast: state.broadcast }))
vi.mock('../pi/catalogue', () => ({ invalidatePiCommands: state.invalidate }))

async function invoke<C extends IpcInvokeChannel>(
  channel: C,
  ...args: IpcInvokeMap[C]['args']
): Promise<IpcInvokeMap[C]['result']> {
  return state.handlers.get(channel)!(null, ...args) as IpcInvokeMap[C]['result']
}

beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  state.handlers.clear()
  state.health.mockResolvedValue({ ok: true, binaryPath: '/bin/pi' })
  state.env.mockResolvedValue({ PATH: '/shell/bin' })
  const { registerMcpHandlers } = await import('./mcp-handlers')
  registerMcpHandlers()
})

describe('MCP handler characterization', () => {
  it('registers only the built-in MCP channels, with no fake callback response', () => {
    expect([...state.handlers.keys()]).toEqual([
      'mcp:readConfigs',
      'mcp:upsertServer',
      'mcp:removeServer',
      'mcp:setEnabled',
      'mcp:readFile',
      'mcp:writeFile',
      'mcp:list',
      'mcp:readChecks',
      'mcp:laneControl',
      'mcp:checkServer',
      'mcp:cancelCheck',
      'mcp:setExposure',
      'mcp:authorize',
      'mcp:cancelAuth',
      'mcp:logout',
      'mcp:migrationPlan',
      'mcp:migrate',
    ])
  })

  it('forwards config reads and file writes and returns their results without invalidation', async () => {
    const configs = { servers: [], files: [], errors: [], projectTrust: null, legacy: false }
    state.readConfigs.mockResolvedValue(configs)
    state.readFile.mockResolvedValue('file content')
    state.writeFile.mockResolvedValue({ ok: true })
    expect(await invoke('mcp:readConfigs', undefined)).toBe(configs)
    expect(state.readConfigs).toHaveBeenCalledExactlyOnceWith(undefined)
    expect(await invoke('mcp:readFile', 'project', '/workspace')).toBe('file content')
    expect(state.readFile).toHaveBeenCalledExactlyOnceWith('project', '/workspace')
    expect(await invoke('mcp:writeFile', 'global', undefined, '{}')).toEqual({ ok: true })
    expect(state.writeFile).toHaveBeenCalledExactlyOnceWith('global', undefined, '{}')
    expect(state.invalidate).not.toHaveBeenCalled()
  })

  it('forwards server mutation arguments and results without invalidating commands', async () => {
    const config = { url: 'https://example.com/mcp' }
    state.upsert.mockResolvedValue('upserted')
    state.remove.mockResolvedValue('removed')
    state.enable.mockResolvedValue('enabled')
    expect(await invoke('mcp:upsertServer', 'global', undefined, 'docs', config)).toBe('upserted')
    expect(state.upsert).toHaveBeenCalledExactlyOnceWith('global', undefined, 'docs', config)
    expect(await invoke('mcp:removeServer', 'project', '/workspace', 'docs')).toBe('removed')
    expect(state.remove).toHaveBeenCalledExactlyOnceWith('project', '/workspace', 'docs')
    expect(await invoke('mcp:setEnabled', 'project', '/workspace', 'docs', false)).toBe('enabled')
    expect(state.enable).toHaveBeenCalledExactlyOnceWith('project', '/workspace', 'docs', false)
    expect(state.invalidate).not.toHaveBeenCalled()
  })

  it('propagates every config operation error without command invalidation', async () => {
    const error = new Error('config failed')
    for (const mock of [
      state.readConfigs,
      state.readFile,
      state.writeFile,
      state.upsert,
      state.remove,
      state.enable,
    ]) {
      mock.mockRejectedValue(error)
    }
    await expect(invoke('mcp:readConfigs', '/workspace')).rejects.toBe(error)
    await expect(invoke('mcp:readFile', 'global', undefined)).rejects.toBe(error)
    await expect(invoke('mcp:writeFile', 'global', undefined, '{}')).rejects.toBe(error)
    await expect(
      invoke('mcp:upsertServer', 'global', undefined, 'docs', { command: 'docs' }),
    ).rejects.toBe(error)
    await expect(invoke('mcp:removeServer', 'global', undefined, 'docs')).rejects.toBe(error)
    await expect(invoke('mcp:setEnabled', 'global', undefined, 'docs', true)).rejects.toBe(error)
    expect(state.invalidate).not.toHaveBeenCalled()
  })

  it('returns the existing unavailable list/logout shapes and emits failed auth', async () => {
    state.health.mockResolvedValue({ ok: false })
    const failure = { ok: false, message: 'pi is not available.' }
    expect(await invoke('mcp:list', undefined)).toEqual(failure)
    expect(await invoke('mcp:logout', 'docs', '/workspace')).toEqual(failure)
    expect(await invoke('mcp:authorize', 'docs', undefined)).toBeUndefined()
    expect(state.broadcast).toHaveBeenCalledExactlyOnceWith('mcp:authState', {
      serverName: 'docs',
      state: { phase: 'failed', message: 'pi is not available.' },
    })
    expect(state.list).not.toHaveBeenCalled()
    expect(state.logout).not.toHaveBeenCalled()
    expect(state.login).not.toHaveBeenCalled()
    expect(state.env).not.toHaveBeenCalled()
  })

  it('forwards list and logout results and preserves their CLI arguments', async () => {
    const listed = { ok: true, servers: [], errors: [] }
    const loggedOut = { ok: false, message: 'pi refused' }
    state.list.mockResolvedValue(listed)
    state.logout.mockResolvedValue(loggedOut)
    expect(await invoke('mcp:list', '/workspace')).toBe(listed)
    expect(state.list).toHaveBeenCalledExactlyOnceWith({
      binaryPath: '/bin/pi',
      cwd: '/workspace',
      env: { PATH: '/shell/bin' },
    })
    expect(await invoke('mcp:logout', 'docs', '/workspace')).toBe(loggedOut)
    expect(state.logout).toHaveBeenCalledExactlyOnceWith(
      {
        binaryPath: '/bin/pi',
        cwd: '/workspace',
        env: { PATH: '/shell/bin' },
      },
      'docs',
    )
  })

  it('starts auth without waiting for login and broadcasts each pi-owned state', async () => {
    let emit: ((auth: ConnectorAuthState) => void) | undefined
    state.login.mockImplementation((_cli, _name, onState: typeof emit) => {
      emit = onState
      return new Promise<void>(() => {})
    })
    expect(await invoke('mcp:authorize', 'docs', '/workspace')).toBeUndefined()
    expect(state.login).toHaveBeenCalledWith(
      {
        binaryPath: '/bin/pi',
        cwd: '/workspace',
        env: { PATH: '/shell/bin' },
      },
      'docs',
      expect.any(Function),
    )
    const states: ConnectorAuthState[] = [
      { phase: 'starting' },
      { phase: 'awaiting-browser', authorizationUrl: 'https://example.com/auth' },
      { phase: 'connected' },
      { phase: 'failed', message: 'pi failed' },
    ]
    for (const auth of states) emit!(auth)
    expect(state.broadcast.mock.calls).toEqual(
      states.map((auth) => ['mcp:authState', { serverName: 'docs', state: auth }]),
    )
  })

  it('cancels only the named login without resolving pi', async () => {
    expect(await invoke('mcp:cancelAuth', 'docs')).toBeUndefined()
    expect(state.cancel).toHaveBeenCalledExactlyOnceWith('docs')
    expect(state.health).not.toHaveBeenCalled()
  })

  it('propagates preparation errors without inventing auth failure states', async () => {
    const error = new Error('discovery failed')
    state.health.mockRejectedValue(error)
    await expect(invoke('mcp:list', undefined)).rejects.toBe(error)
    await expect(invoke('mcp:logout', 'docs', undefined)).rejects.toBe(error)
    await expect(invoke('mcp:authorize', 'docs', undefined)).rejects.toBe(error)
    expect(state.broadcast).not.toHaveBeenCalled()
  })

  it('forwards migration plans without invalidating commands', async () => {
    const plan = { servers: [], blocked: [] }
    state.plan.mockResolvedValue(plan)
    expect(await invoke('mcp:migrationPlan', '/workspace')).toBe(plan)
    expect(state.plan).toHaveBeenCalledExactlyOnceWith('/workspace')
    expect(state.invalidate).not.toHaveBeenCalled()
    const error = new Error('plan failed')
    state.plan.mockRejectedValue(error)
    await expect(invoke('mcp:migrationPlan', undefined)).rejects.toBe(error)
  })

  it('invalidates commands only after migration resolves and returns the same result', async () => {
    let finish: ((result: { written: string[]; backups: [] }) => void) | undefined
    state.migrate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const pending = invoke('mcp:migrate', '/workspace')
    expect(state.migrate).toHaveBeenCalledExactlyOnceWith('/workspace')
    expect(state.invalidate).not.toHaveBeenCalled()
    const result = { written: ['/workspace/.pi/mcp.json'], backups: [] as [] }
    finish!(result)
    expect(await pending).toBe(result)
    expect(state.invalidate).toHaveBeenCalledExactlyOnceWith()
  })

  it('propagates migration failure without invalidating commands', async () => {
    const error = new Error('invalid JSON')
    state.migrate.mockRejectedValue(error)
    await expect(invoke('mcp:migrate', undefined)).rejects.toBe(error)
    expect(state.migrate).toHaveBeenCalledExactlyOnceWith(undefined)
    expect(state.invalidate).not.toHaveBeenCalled()
  })
})
