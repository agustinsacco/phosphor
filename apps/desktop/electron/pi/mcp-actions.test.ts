import { homedir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectorAuthState } from '@shared/models'
import { authorizeMcpServer, cancelMcpLogin, listMcpServers, logoutMcpServer } from './mcp-actions'

const state = vi.hoisted(() => ({
  health: vi.fn(),
  env: vi.fn(),
  stub: vi.fn(),
  list: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  cancel: vi.fn(),
}))
vi.mock('./health', () => ({ checkPiHealth: state.health }))
vi.mock('./shell-env', () => ({ piProcessEnv: state.env }))
vi.mock('./stub', () => ({ piStubPath: state.stub }))
vi.mock('./mcp-cli', () => ({
  listMcpServers: state.list,
  loginMcpServer: state.login,
  logoutMcpServer: state.logout,
  cancelMcpLogin: state.cancel,
}))

beforeEach(() => {
  vi.resetAllMocks()
  state.health.mockResolvedValue({ ok: true, binaryPath: '/bin/pi' })
  state.env.mockResolvedValue({ PATH: '/shell/bin', PI_CODING_AGENT_DIR: '/agent' })
})
afterEach(() => vi.unstubAllEnvs())

describe('MCP actions', () => {
  it('uses the workspace cwd and shell environment including launch prefixes', async () => {
    state.health.mockResolvedValue({ ok: true, binaryPath: '/node', prefixArgs: ['/pi.js'] })
    const result = { ok: true, servers: [], errors: [] }
    state.list.mockResolvedValue(result)
    expect(await listMcpServers('/workspace')).toBe(result)
    expect(state.list).toHaveBeenCalledExactlyOnceWith({
      binaryPath: '/node',
      prefixArgs: ['/pi.js'],
      cwd: '/workspace',
      env: { PATH: '/shell/bin', PI_CODING_AGENT_DIR: '/agent' },
    })
  })

  it('uses home cwd without a workspace and keeps the absent prefix shape', async () => {
    await listMcpServers(undefined)
    expect(state.list).toHaveBeenCalledExactlyOnceWith({
      binaryPath: '/bin/pi',
      cwd: homedir(),
      env: { PATH: '/shell/bin', PI_CODING_AGENT_DIR: '/agent' },
    })
  })

  it('inherits the stub environment and runs the stub under node without probing pi', async () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', '/stub-agent')
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '0')
    state.stub.mockReturnValue('/stub.cjs')
    await listMcpServers('/workspace')
    expect(state.list).toHaveBeenCalledExactlyOnceWith({
      binaryPath: process.execPath,
      prefixArgs: ['/stub.cjs'],
      cwd: '/workspace',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    expect(state.health).not.toHaveBeenCalled()
    expect(state.env).not.toHaveBeenCalled()
    await logoutMcpServer('docs', undefined)
    expect(state.logout).toHaveBeenCalledWith(expect.objectContaining({ cwd: homedir() }), 'docs')
  })

  it('admits a present binary even when health reports a too-old version', async () => {
    state.health.mockResolvedValue({
      ok: false,
      reason: 'too-old',
      binaryPath: '/old-node',
      prefixArgs: ['/old-pi.js'],
    })
    await listMcpServers('/workspace')
    expect(state.list).toHaveBeenCalledExactlyOnceWith({
      binaryPath: '/old-node',
      prefixArgs: ['/old-pi.js'],
      cwd: '/workspace',
      env: { PATH: '/shell/bin', PI_CODING_AGENT_DIR: '/agent' },
    })
  })

  it('probes afresh for each action and uses the current environment', async () => {
    await listMcpServers('/workspace')
    state.health.mockResolvedValue({ ok: false, binaryPath: '/new-pi' })
    state.env.mockResolvedValue({ PATH: '/new-shell' })
    await logoutMcpServer('docs', '/workspace')
    expect(state.health).toHaveBeenCalledTimes(2)
    expect(state.env).toHaveBeenCalledTimes(2)
    expect(state.logout).toHaveBeenCalledExactlyOnceWith(
      {
        binaryPath: '/new-pi',
        cwd: '/workspace',
        env: { PATH: '/new-shell' },
      },
      'docs',
    )
  })

  it('returns unavailable shapes and reports failed auth without starting a command', async () => {
    state.health.mockResolvedValue({ ok: false })
    const emit = vi.fn()
    expect(await listMcpServers(undefined)).toEqual({ ok: false, message: 'pi is not available.' })
    expect(await logoutMcpServer('docs', undefined)).toEqual({
      ok: false,
      message: 'pi is not available.',
    })
    expect(await authorizeMcpServer('docs', undefined, emit)).toBeUndefined()
    expect(emit).toHaveBeenCalledExactlyOnceWith({
      phase: 'failed',
      message: 'pi is not available.',
    })
    expect(state.list).not.toHaveBeenCalled()
    expect(state.logout).not.toHaveBeenCalled()
    expect(state.login).not.toHaveBeenCalled()
    expect(state.env).not.toHaveBeenCalled()
  })

  it('returns after starting auth while pi continues reporting browser and connection states', async () => {
    const emit = vi.fn()
    let report: ((auth: ConnectorAuthState) => void) | undefined
    state.login.mockImplementation((_cli, _name, onState: typeof report) => {
      report = onState
      onState!({ phase: 'starting' })
      return new Promise<void>(() => {})
    })
    expect(await authorizeMcpServer('docs', '/workspace', emit)).toBeUndefined()
    expect(state.login).toHaveBeenCalledExactlyOnceWith(
      {
        binaryPath: '/bin/pi',
        cwd: '/workspace',
        env: { PATH: '/shell/bin', PI_CODING_AGENT_DIR: '/agent' },
      },
      'docs',
      emit,
    )
    report!({ phase: 'awaiting-browser', authorizationUrl: 'https://example.com/auth' })
    report!({ phase: 'connected' })
    expect(emit.mock.calls).toEqual([
      [{ phase: 'starting' }],
      [{ phase: 'awaiting-browser', authorizationUrl: 'https://example.com/auth' }],
      [{ phase: 'connected' }],
    ])
  })

  it('delegates cancel without pi preparation and returns the logout result unchanged', async () => {
    cancelMcpLogin('docs')
    expect(state.cancel).toHaveBeenCalledExactlyOnceWith('docs')
    expect(state.health).not.toHaveBeenCalled()
    const result = { ok: false, message: 'pi refused logout' }
    state.logout.mockResolvedValue(result)
    expect(await logoutMcpServer('docs', '/workspace')).toBe(result)
    expect(state.logout).toHaveBeenCalledExactlyOnceWith(
      {
        binaryPath: '/bin/pi',
        cwd: '/workspace',
        env: { PATH: '/shell/bin', PI_CODING_AGENT_DIR: '/agent' },
      },
      'docs',
    )
  })

  it('propagates health and environment failures without converting them to missing pi', async () => {
    const error = new Error('discovery failed')
    state.health.mockRejectedValueOnce(error)
    await expect(listMcpServers(undefined)).rejects.toBe(error)
    state.env.mockRejectedValue(error)
    const emit = vi.fn()
    await expect(authorizeMcpServer('docs', undefined, emit)).rejects.toBe(error)
    await expect(logoutMcpServer('docs', undefined)).rejects.toBe(error)
    expect(emit).not.toHaveBeenCalled()
  })
})
