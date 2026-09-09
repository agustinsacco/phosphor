import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as HealthModule from '../pi/health'

const state = vi.hoisted(() => {
  const session = {
    sessionId: 'live-1',
    workspacePath: '/repo',
    client: { pid: 123, on: vi.fn(), request: vi.fn().mockResolvedValue({ success: true }) },
  }
  return {
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    session,
    create: vi.fn().mockReturnValue(session),
    listPackages: vi.fn(),
  }
})
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/app' } }))
vi.mock('./handle', () => ({
  handle: (name: string, cb: (...args: unknown[]) => unknown) => state.handlers.set(name, cb),
}))
vi.mock('../registry', () => ({ registry: { create: state.create, get: () => state.session } }))
vi.mock('../pi/health', async (original) => ({
  ...(await original<typeof HealthModule>()),
  checkPiHealth: vi.fn().mockResolvedValue({ ok: true, binaryPath: '/bin/pi' }),
}))
vi.mock('../pi/stub', () => ({ piStubPath: () => undefined }))
vi.mock('../pi/shell-env', () => ({ piProcessEnv: vi.fn().mockResolvedValue({ PATH: '/bin' }) }))
vi.mock('../pi/packages', () => ({ listPackages: state.listPackages }))
vi.mock('../pi/agent-settings', () => ({
  readAgentSettings: vi.fn().mockResolvedValue({ defaultProvider: 'openai-codex' }),
}))
vi.mock('../claude/accounts', () => ({
  accountForSpawn: vi.fn().mockResolvedValue(null),
  claudeAccountEnv: () => ({}),
  holdAccount: vi.fn(),
  primaryAccount: vi.fn(),
}))
vi.mock('../headroom/proxy', () => ({ headroomSupervisor: () => ({ sessionEnv: () => ({}) }) }))
vi.mock('../fs/git-info', () => ({
  gitInfoBatch: vi.fn().mockResolvedValue({ '/repo': { isRepo: false } }),
}))
vi.mock('../store', () => ({
  getPrefs: () => ({
    agentDirectivesByProject: {},
    agentDirectives: { worktreeGuard: false, laneCharter: false, subagentPolicy: true, custom: '' },
  }),
  recordWorkspace: vi.fn(),
  getLanePrefs: vi.fn(),
}))
vi.mock('../debug-log', () => ({ log: vi.fn() }))
import { registerPiSessionHandlers } from './pi-session-handlers'

const event = { sender: { isDestroyed: () => false, send: vi.fn() } }
const pkg = (version: string) => [{ name: '@saccolabs/pi-claude-cli', version, installed: true }]

beforeEach(() => {
  vi.clearAllMocks()
  state.handlers.clear()
  state.listPackages.mockResolvedValue(pkg('0.7.1'))
  registerPiSessionHandlers()
})

describe('session context policy integration', () => {
  it.each(['pi-claude-cli', 'openai-codex'])(
    'retains pi project discovery and carries the context policy for %s',
    async (provider) => {
      await state.handlers.get('pi:createSession')!(event, { workspacePath: '/repo', provider })
      const options = state.create.mock.calls[0]![1]
      expect(options).not.toHaveProperty('noContextFiles')
      expect(options.env).toMatchObject({
        PI_CLAUDE_CLI_CONTEXT: 'pi',
        PI_CLAUDE_CLI_STRICT_MCP: '1',
      })
      expect(options.env).not.toHaveProperty('PI_CLAUDE_CLI_SYSTEM_PROMPT')
      expect(options.env).not.toHaveProperty('PI_CLAUDE_CLI_KEEPALIVE_MS')
      expect(options.appendSystemPrompt).toContain('pi subagent: follow its advertised schema')
    },
  )

  it('refuses an old Claude package before creating a process', async () => {
    state.listPackages.mockResolvedValue(pkg('0.7.0'))
    await expect(
      state.handlers.get('pi:createSession')!(event, {
        workspacePath: '/repo',
        provider: 'pi-claude-cli',
      }),
    ).rejects.toThrow('0.7.1+')
    expect(state.create).not.toHaveBeenCalled()
  })

  it('checks the version when a native session switches to Claude, without forwarding on failure', async () => {
    state.listPackages.mockResolvedValue(pkg('0.7.0'))
    await expect(
      state.handlers.get('pi:command')!(event, 'live-1', {
        type: 'set_model',
        provider: 'pi-claude-cli',
        modelId: 'claude-opus-5',
      }),
    ).rejects.toThrow('0.7.1+')
    expect(state.session.client.request).not.toHaveBeenCalled()
  })

  it('gates the resolved Claude model before a prompt, even if spawn-time prediction missed it', async () => {
    state.listPackages.mockResolvedValue(pkg('0.7.0'))
    state.session.client.request.mockResolvedValueOnce({
      success: true,
      data: { model: { provider: 'pi-claude-cli' } },
    })
    await expect(
      state.handlers.get('pi:command')!(event, 'live-1', { type: 'prompt', message: 'hi' }),
    ).rejects.toThrow('0.7.1+')
    expect(state.session.client.request).toHaveBeenCalledExactlyOnceWith({ type: 'get_state' })
  })

  it.each(['openai-codex', 'pi-claude-cli'])('forwards a verified %s prompt', async (provider) => {
    state.session.client.request.mockResolvedValueOnce({
      success: true,
      data: { model: { provider } },
    })
    const command = { type: 'prompt', message: 'hi' }
    await state.handlers.get('pi:command')!(event, 'live-1', command)
    expect(state.session.client.request).toHaveBeenLastCalledWith(command)
    if (provider === 'openai-codex') expect(state.listPackages).not.toHaveBeenCalled()
  })

  it('does not forward a prompt when the active model cannot be verified', async () => {
    state.session.client.request.mockResolvedValueOnce({ success: false })
    await expect(
      state.handlers.get('pi:command')!(event, 'live-1', { type: 'prompt', message: 'hi' }),
    ).rejects.toThrow('Cannot verify')
    expect(state.session.client.request).toHaveBeenCalledExactlyOnceWith({ type: 'get_state' })
  })

  it('does not require Claude to switch to a native provider', async () => {
    state.listPackages.mockResolvedValue([])
    const command = { type: 'set_model', provider: 'openai-codex', modelId: 'test' }
    await state.handlers.get('pi:command')!(event, 'live-1', command)
    expect(state.session.client.request).toHaveBeenCalledWith(command)
    expect(state.listPackages).not.toHaveBeenCalled()
  })
})
