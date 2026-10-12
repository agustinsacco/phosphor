import { describe, expect, it, vi } from 'vitest'
import swarm, {
  applySwarmContext,
  parseSwarmStatus,
  savedSwarm,
  SWARM_COMMAND,
  SWARM_PROMPT,
  SWARM_SECTION,
} from './swarm'

function fixture() {
  const handlers = new Map<string, (e: unknown, c: unknown) => unknown>()
  const branch: unknown[] = []
  let command!: (args: string, ctx: unknown) => Promise<void>
  const pi = {
    on: (name: string, handler: (e: unknown, c: unknown) => unknown) =>
      void handlers.set(name, handler),
    getAllTools: vi.fn(() => [{ name: 'subagent' }]),
    getActiveTools: vi.fn(() => ['read', 'subagents_enable']),
    appendEntry: vi.fn((customType: string, data: unknown) =>
      branch.push({ type: 'custom', customType, data }),
    ),
    registerCommand: (_name: string, spec: { handler: typeof command }) => {
      command = spec.handler
    },
  }
  const ctx = {
    isIdle: vi.fn(() => true),
    sessionManager: { getSessionId: () => 'one', getBranch: () => branch },
    ui: { setStatus: vi.fn() },
  }
  const state = swarm(pi)
  const emit = (name: string, event: unknown = {}) => handlers.get(name)!(event, ctx)
  emit('session_start')
  const status = () => parseSwarmStatus(ctx.ui.setStatus.mock.lastCall?.[1])!
  const send = () => {
    const messages = [{ role: 'system', sections: { preamble: 'Keep all other rules' } }]
    emit('context_with_system', { messages })
    return JSON.stringify(messages)
  }
  return {
    pi,
    ctx,
    branch,
    state,
    status,
    emit,
    send,
    command: (args: string) => command(args, ctx),
  }
}

describe('lane Swarm authorization', () => {
  it('adds and removes only the short authorization on every request, with no tool activation', async () => {
    const f = fixture()
    expect(f.send()).not.toContain(SWARM_PROMPT)
    expect(f.state.tokens()).toBe(0)
    const tools = f.pi.getActiveTools()
    await f.command('on')
    expect(f.status()).toEqual({ version: 1, available: true, enabled: true, requested: true })
    expect(f.send()).toContain(SWARM_PROMPT)
    expect(f.send()).toContain('Keep all other rules')
    expect(f.state.tokens()).toBeGreaterThan(0)
    expect(f.state.tokens()).toBeLessThan(100)
    // Native background completion can request context without before_agent_start.
    expect(f.send()).toContain(SWARM_PROMPT)
    await f.command('off')
    expect(f.send()).not.toContain(SWARM_PROMPT)
    expect(f.state.tokens()).toBe(0)
    expect(f.pi.getActiveTools()).toEqual(tools)
    expect(f.branch).toEqual(
      [true, false].map((enabled) => ({
        type: 'custom',
        customType: SWARM_COMMAND,
        data: { enabled, sessionId: 'one' },
      })),
    )
  })

  it('defers changes during a run, allows cancellation and does not stop existing work', async () => {
    const f = fixture()
    f.ctx.isIdle.mockReturnValue(false)
    await f.command('on')
    expect(f.status()).toMatchObject({ requested: true, enabled: false })
    expect(f.send()).not.toContain(SWARM_PROMPT)
    await f.command('off') // cancel pending enable
    f.emit('agent_end')
    expect(f.status().enabled).toBe(false)
    await f.command('on')
    f.emit('agent_end')
    expect(f.send()).toContain(SWARM_PROMPT)
    await f.command('off')
    expect(f.status()).toMatchObject({ requested: false, enabled: true })
    expect(f.send()).toContain(SWARM_PROMPT)
    f.emit('agent_end') // also emitted after abort
    expect(f.send()).not.toContain(SWARM_PROMPT)
  })

  it('restores on resume/reload and compaction but follows the current branch on tree navigation', async () => {
    const f = fixture()
    await f.command('on')
    f.branch.push({ type: 'compaction', summary: 'Old work' })
    f.emit('session_start')
    expect(f.send()).toContain(SWARM_PROMPT)
    const saved = [...f.branch]
    f.branch.length = 0 // navigating before enable
    f.emit('session_tree')
    expect(f.status().enabled).toBe(false)
    f.branch.push(...saved)
    f.emit('session_tree')
    expect(f.status().enabled).toBe(true)
    f.ctx.sessionManager.getSessionId = () => 'clone'
    f.emit('session_start')
    expect(f.status().enabled).toBe(false)
  })

  it('keeps lanes independent', async () => {
    const a = fixture()
    const b = fixture()
    await a.command('on')
    expect(a.send()).toContain(SWARM_PROMPT)
    expect(b.send()).not.toContain(SWARM_PROMPT)
  })

  it('fails closed when the extension is missing or its execution tools are excluded', async () => {
    const f = fixture()
    f.pi.getAllTools.mockReturnValue([])
    await expect(f.command('on')).rejects.toThrow('requires pi-subagents')
    expect(f.pi.appendEntry).not.toHaveBeenCalled()
    f.pi.getAllTools.mockReturnValue([{ name: 'subagent' }])
    f.pi.getActiveTools.mockReturnValue(['read'])
    await expect(f.command('on')).rejects.toThrow('requires pi-subagents')
    f.pi.getActiveTools.mockReturnValue(['subagent']) // eager providers
    await f.command('on')
    expect(f.send()).toContain(SWARM_PROMPT)
    f.pi.getAllTools.mockReturnValue([])
    expect(f.send()).not.toContain(SWARM_PROMPT)
    expect(f.status()).toMatchObject({ enabled: false, available: false })
    await f.command('off') // disabling remains possible without the extension
    expect(f.status().requested).toBe(false)
  })

  it('does not acknowledge an invalid command or a failed persistence write', async () => {
    const f = fixture()
    await expect(f.command('yes')).rejects.toThrow('Expected')
    f.pi.appendEntry.mockImplementation(() => {
      throw new Error('disk failure')
    })
    await expect(f.command('on')).rejects.toThrow('disk failure')
    expect(f.status().enabled).toBe(false)
  })

  it('removes historical system patches without touching tools, messages or other policy', () => {
    const original = [
      {
        role: 'system',
        sections: { [SWARM_SECTION]: 'old', addendum: 'normal policy' },
        toolsAdded: [{ name: 'subagent' }],
      },
      { role: 'assistant', content: 'Past delegation result' },
      { role: 'system', sections: { [SWARM_SECTION]: 'old update' } },
    ]
    for (const enabled of [true, false, true, false]) {
      const messages = structuredClone(original)
      applySwarmContext(messages, enabled)
      expect(JSON.stringify(messages)).not.toContain('old')
      expect(JSON.stringify(messages)).toContain('normal policy')
      expect(messages[0]?.toolsAdded).toEqual([{ name: 'subagent' }])
      expect(messages[1]).toEqual(original[1])
      expect(messages[0]?.sections?.[SWARM_SECTION]?.includes(SWARM_PROMPT) ?? false).toBe(enabled)
      expect(messages[2]?.sections).toEqual({})
    }
    expect(original[0]?.sections?.[SWARM_SECTION]).toBe('old')
  })

  it('ignores malformed saved state and status payloads', () => {
    expect(
      savedSwarm([null, { type: 'custom', customType: SWARM_COMMAND, data: null }], 'one'),
    ).toBe(false)
    expect(
      savedSwarm(
        [
          {
            type: 'custom',
            customType: SWARM_COMMAND,
            data: { sessionId: 'one', enabled: 'true' },
          },
        ],
        'one',
      ),
    ).toBe(false)
    for (const text of [
      undefined,
      '',
      'null',
      '{}',
      '{"version":2}',
      '{"version":1,"enabled":"true"}',
    ]) {
      expect(parseSwarmStatus(text)).toBeNull()
    }
  })
})
