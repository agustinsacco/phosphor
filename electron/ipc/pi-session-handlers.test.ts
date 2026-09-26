import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as HealthModule from '../pi/health'
import type * as FsPromises from 'node:fs/promises'

const state = vi.hoisted(() => {
  const session = {
    sessionId: 'live-1',
    workspacePath: '/repo',
    client: {
      pid: 123,
      alive: true,
      on: vi.fn(),
      request: vi.fn().mockResolvedValue({ success: true }),
    },
  }
  return {
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    session,
    create: vi.fn().mockReturnValue(session),
    listPackages: vi.fn(),
    list: vi.fn(),
    dispose: vi.fn(),
    access: vi.fn(),
    ensureCompactionReset: vi.fn(),
    runPrintMode: vi.fn(),
  }
})
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/app' } }))
vi.mock('./handle', () => ({
  handle: (name: string, cb: (...args: unknown[]) => unknown) => state.handlers.set(name, cb),
}))
vi.mock('../registry', () => ({
  registry: {
    create: state.create,
    get: () => state.session,
    list: state.list,
    dispose: state.dispose,
  },
}))
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof FsPromises>()),
  access: state.access,
}))
vi.mock('../pi/health', async (original) => ({
  ...(await original<typeof HealthModule>()),
  checkPiHealth: vi.fn().mockResolvedValue({ ok: true, binaryPath: '/bin/pi' }),
}))
vi.mock('../pi/stub', () => ({ piStubPath: () => undefined }))
vi.mock('../pi/shell-env', () => ({ piProcessEnv: vi.fn().mockResolvedValue({ PATH: '/bin' }) }))
vi.mock('../pi/packages', () => ({ listPackages: state.listPackages }))
vi.mock('../pi/compaction-reset', () => ({ ensureCompactionReset: state.ensureCompactionReset }))
vi.mock('../pi/print-mode', () => ({ runPrintMode: state.runPrintMode }))
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
  getLanePrefs: () => ({ nameMinWords: 2, nameMaxWords: 5, nameMaxLength: 60 }),
  // Identity: these fixtures use plain paths with no symlink to resolve, and
  // the real one would hit the filesystem for a directory that is not there.
  realPathOrNull: (path: string) => path,
}))
vi.mock('../debug-log', () => ({ log: vi.fn() }))
import { registerPiSessionHandlers } from './pi-session-handlers'
import { cancelSessionOpens } from '../pi/session-path-lock'

const event = { sender: { isDestroyed: () => false, send: vi.fn() } }
const pkg = (version: string) => [{ name: '@saccolabs/pi-claude-cli', version, installed: true }]

beforeEach(() => {
  vi.clearAllMocks()
  state.handlers.clear()
  state.list.mockReturnValue([])
  state.session.client.alive = true
  state.session.client.request.mockReset().mockResolvedValue({ success: true })
  state.dispose.mockReset().mockResolvedValue(undefined)
  state.access.mockReset().mockResolvedValue(undefined)
  state.create.mockReset().mockReturnValue(state.session)
  state.listPackages.mockResolvedValue(pkg('0.9.0'))
  state.ensureCompactionReset.mockReset().mockResolvedValue(undefined)
  registerPiSessionHandlers()
})

describe('session context policy integration', () => {
  it('serializes concurrent resumes and reuses the first writer', async () => {
    state.create.mockImplementation(() => {
      state.list.mockReturnValue([
        { sessionId: 'live-1', workspacePath: '/repo', diskPath: '/repo/session.jsonl' },
      ])
      return state.session
    })
    const open = () =>
      state.handlers.get('pi:createSession')!(event, {
        workspacePath: '/repo',
        sessionPath: '/repo/session.jsonl',
      })
    await Promise.all([open(), open(), open()])
    expect(state.create).toHaveBeenCalledTimes(1)
  })

  it('interrupts startup RPC when deletion cancels a resume', async () => {
    let reject!: (error: Error) => void
    state.session.client.request.mockReturnValue(
      new Promise((_resolve, fail) => {
        reject = fail
      }),
    )
    state.dispose.mockImplementation(async () => {
      state.session.client.alive = false
      reject(new Error('process stopped'))
    })
    const opening = Promise.resolve(
      state.handlers.get('pi:createSession')!(event, {
        workspacePath: '/repo',
        sessionPath: '/repo/hung.jsonl',
      }),
    )
    const result = opening.catch((error: Error) => error.name)
    await vi.waitFor(() => expect(state.session.client.request).toHaveBeenCalled())
    cancelSessionOpens('/repo/hung.jsonl')
    expect(await result).toBe('AbortError')
    expect(state.dispose).toHaveBeenCalledWith('live-1')
  })

  it('repairs leftover compaction settings before pi starts', async () => {
    let finish!: () => void
    state.ensureCompactionReset.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve
      }),
    )
    const opening = state.handlers.get('pi:createSession')!(event, { workspacePath: '/repo' })
    await vi.waitFor(() => expect(state.ensureCompactionReset).toHaveBeenCalled())
    expect(state.create).not.toHaveBeenCalled()
    finish()
    await opening
    expect(state.create).toHaveBeenCalledOnce()
  })

  it('disposes a pi that exits during startup and reports why', async () => {
    state.session.client.request.mockRejectedValueOnce(new Error('pi exited (code=1, signal=null)'))
    await expect(
      state.handlers.get('pi:createSession')!(event, { workspacePath: '/repo' }),
    ).rejects.toThrow('pi exited (code=1')
    expect(state.dispose).toHaveBeenCalledExactlyOnceWith('live-1')
  })

  it('disposes a pi that is gone by the time it answers', async () => {
    state.session.client.request.mockImplementationOnce(async () => {
      state.session.client.alive = false
      return { success: true }
    })
    await expect(
      state.handlers.get('pi:createSession')!(event, { workspacePath: '/repo' }),
    ).rejects.toThrow('Session stopped during startup.')
    expect(state.dispose).toHaveBeenCalledExactlyOnceWith('live-1')
  })

  it('does not create a replacement when a queued resume finds a deleted file', async () => {
    state.access.mockRejectedValue(new Error('ENOENT'))
    await expect(
      state.handlers.get('pi:createSession')!(event, {
        workspacePath: '/repo',
        sessionPath: '/repo/missing.jsonl',
      }),
    ).rejects.toThrow('ENOENT')
    expect(state.create).not.toHaveBeenCalled()
  })

  it.each(['pi-claude-cli', 'openai-codex'])(
    'retains pi project discovery and carries the context policy for %s',
    async (provider) => {
      await state.handlers.get('pi:createSession')!(event, { workspacePath: '/repo', provider })
      const options = state.create.mock.calls[0]![1]
      expect(options).not.toHaveProperty('noContextFiles')
      expect(options.ownProcessGroup).toBe(true)
      expect(options.env).toMatchObject({
        PI_CLAUDE_CLI_CONTEXT: 'pi',
      })
      expect(options.env).not.toHaveProperty('PI_CLAUDE_CLI_SYSTEM_PROMPT')
      expect(options.env).not.toHaveProperty('PI_CLAUDE_CLI_KEEPALIVE_MS')
      expect(options.appendSystemPrompt).toContain('pi subagent: follow its advertised schema')
    },
  )

  it.each(['pi-claude-cli', 'openai-codex'])(
    'does not override pi compaction when switching to %s',
    async (provider) => {
      const command = { type: 'set_model', provider, modelId: 'test-model' }
      await state.handlers.get('pi:command')!(event, 'live-1', command)
      expect(state.session.client.request).toHaveBeenCalledExactlyOnceWith(command)
    },
  )

  it('refuses an old Claude package before creating a process', async () => {
    state.listPackages.mockResolvedValue(pkg('0.7.0'))
    await expect(
      state.handlers.get('pi:createSession')!(event, {
        workspacePath: '/repo',
        provider: 'pi-claude-cli',
      }),
    ).rejects.toThrow('0.9.0 or newer (found 0.7.0)')
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
    ).rejects.toThrow('0.9.0 or newer (found 0.7.0)')
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
    ).rejects.toThrow('0.9.0 or newer (found 0.7.0)')
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

  it('names a session under pi ownership, in a run that exits once it answers', async () => {
    state.runPrintMode.mockResolvedValue({ stdout: 'Fix Login Bug\n' })
    const title = await state.handlers.get('pi:generateTitle')!(event, '/repo', 'fix login', [])
    expect(title).toBe('Fix Login Bug')
    expect(state.runPrintMode.mock.calls[0]![2].env).toMatchObject({
      PI_CLAUDE_CLI_CONTEXT: 'pi',
      PI_CLAUDE_CLI_KEEPALIVE_MS: '0',
      PI_CLAUDE_CLI_EPHEMERAL: '1',
    })
  })
})
