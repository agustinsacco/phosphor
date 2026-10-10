import { describe, expect, it, vi } from 'vitest'
import { prepareSessionPolicy, type SessionPolicyRuntime } from './session-policy'

const launch = {
  stub: false,
  binaryPath: '/bin/node',
  prefixArgs: ['/pi.js'],
  extensions: ['/ext.ts'],
  env: { PI_CLAUDE_CLI_CONTEXT: 'pi', ORDER: 'base' },
}
function ports() {
  return {
    git: vi
      .fn()
      .mockResolvedValue({ isRepo: true, isWorktree: true, mainRepoPath: '/repo', branch: 'lane' }),
    preferences: () => ({
      agentDirectives: {
        worktreeGuard: false,
        laneCharter: false,
        subagentPolicy: false,
        custom: 'global',
      },
      agentDirectivesByProject: {
        '/repo': {
          worktreeGuard: true,
          laneCharter: true,
          subagentPolicy: true,
          custom: 'project',
        },
      },
    }),
    defaultProvider: vi.fn().mockResolvedValue('pi-claude-cli'),
    packages: vi
      .fn()
      .mockResolvedValue([
        { name: '@saccolabs/pi-claude-cli', version: '0.10.0', installed: true },
      ]),
    account: vi.fn().mockResolvedValue({
      id: 'billing',
      env: { CLAUDE_CONFIG_DIR: '/account', ORDER: 'account' },
    }),
    compressionEnvironment: vi.fn().mockReturnValue({ ORDER: 'proxy' }),
    resetCompaction: vi.fn().mockResolvedValue(undefined),
  } satisfies SessionPolicyRuntime
}

describe('portable session policy', () => {
  it.each(['pi-claude-cli', 'openai-codex'])(
    'preserves spawn inputs and project rules for %s',
    async (provider) => {
      const runtime = ports()
      const options = {
        workspacePath: '/repo/lane',
        sessionPath: '/session',
        forkFrom: '/fork',
        name: 'name',
        provider,
        model: 'model',
        thinkingLevel: 'high',
      }
      const { spawnOptions, accountId } = await prepareSessionPolicy(options, {}, launch, runtime)
      const { workspacePath, ...forwarded } = options
      expect(runtime.git).toHaveBeenCalledWith(workspacePath)
      expect(spawnOptions).toMatchObject({
        ...forwarded,
        ownProcessGroup: true,
        binaryPath: '/bin/node',
        prefixArgs: ['/pi.js'],
        extensions: ['/ext.ts'],
      })
      expect(spawnOptions).not.toHaveProperty('workspacePath')
      expect(spawnOptions).not.toHaveProperty('noContextFiles')
      expect(spawnOptions.appendSystemPrompt).toContain('Working directory: /repo/lane')
      expect(spawnOptions.appendSystemPrompt).toContain('Branch: lane')
      expect(spawnOptions.appendSystemPrompt).toContain('pi subagent: follow its advertised schema')
      expect(spawnOptions.appendSystemPrompt).toMatch(/project$/)
      expect(spawnOptions.env).toMatchObject({ PI_CLAUDE_CLI_CONTEXT: 'pi', ORDER: 'proxy' })
      expect(runtime.resetCompaction).toHaveBeenCalledOnce()
      if (provider === 'pi-claude-cli') {
        expect(accountId).toBe('billing')
        expect(runtime.account).toHaveBeenCalledWith({ sessionPath: '/session' })
        expect(spawnOptions.env?.CLAUDE_CONFIG_DIR).toBe('/account')
      } else {
        expect(accountId).toBeUndefined()
        expect(runtime.packages).not.toHaveBeenCalled()
        expect(runtime.account).not.toHaveBeenCalled()
      }
      expect(launch.env).toEqual({ PI_CLAUDE_CLI_CONTEXT: 'pi', ORDER: 'base' })
    },
  )

  it('hands the lane its starting context-file state, and clears an inherited one', async () => {
    const runtime = {
      ...ports(),
      preferences: () => ({
        ...ports().preferences(),
        contextFiles: { claude: false, agents: true },
      }),
    }
    const off = await prepareSessionPolicy({ workspacePath: '/repo' }, {}, launch, runtime)
    expect(off.spawnOptions.env?.PHOSPHOR_CONTEXT_FILES).toBe('claude=off')
    const inherited = { ...launch, env: { ...launch.env, PHOSPHOR_CONTEXT_FILES: 'agents=off' } }
    const on = await prepareSessionPolicy({ workspacePath: '/repo' }, {}, inherited, ports())
    expect(on.spawnOptions.env?.PHOSPHOR_CONTEXT_FILES).toBe('')
  })

  it('omits only the lane charter for report execution', async () => {
    const { spawnOptions } = await prepareSessionPolicy(
      { workspacePath: '/repo/lane' },
      { intent: 'report' },
      launch,
      ports(),
    )
    expect(spawnOptions.appendSystemPrompt).not.toContain('<phosphor_lane>')
    expect(spawnOptions.appendSystemPrompt).toContain('<phosphor_workspace>')
    expect(spawnOptions.appendSystemPrompt).toContain('project')
  })

  it('refuses an old provider before account selection or settings repair', async () => {
    const runtime = ports()
    runtime.packages.mockResolvedValue([
      { name: '@saccolabs/pi-claude-cli', version: '0.9.0', installed: true },
    ])
    await expect(
      prepareSessionPolicy({ workspacePath: '/repo' }, {}, launch, runtime),
    ).rejects.toThrow('0.10.0')
    expect(runtime.account).not.toHaveBeenCalled()
    expect(runtime.resetCompaction).not.toHaveBeenCalled()
  })

  it('keeps best-effort account selection but propagates compaction repair failures', async () => {
    const runtime = ports()
    runtime.account.mockRejectedValue(new Error('account unavailable'))
    const prepared = await prepareSessionPolicy({ workspacePath: '/repo' }, {}, launch, runtime)
    expect(prepared.accountId).toBeUndefined()
    expect(prepared.spawnOptions.env).not.toHaveProperty('CLAUDE_CONFIG_DIR')
    runtime.resetCompaction.mockRejectedValue(new Error('repair failed'))
    await expect(
      prepareSessionPolicy({ workspacePath: '/repo' }, {}, launch, runtime),
    ).rejects.toThrow('repair failed')
  })

  it('keeps stub discovery/provider/proxy/repair bypasses and global custom directives', async () => {
    const runtime = ports()
    const prepared = await prepareSessionPolicy(
      { workspacePath: '/stub' },
      {},
      { ...launch, stub: true },
      runtime,
    )
    expect(prepared.spawnOptions.appendSystemPrompt).toBe('global')
    expect(prepared.spawnOptions).not.toHaveProperty('extensions')
    for (const call of [
      runtime.git,
      runtime.defaultProvider,
      runtime.packages,
      runtime.account,
      runtime.compressionEnvironment,
      runtime.resetCompaction,
    ])
      expect(call).not.toHaveBeenCalled()
  })
})
