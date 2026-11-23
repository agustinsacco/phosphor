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
    ui: { setStatus: vi.fn(), notify: vi.fn() },
  }
  const state = swarm(pi)
  const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx)
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

  it.each(['agent_settled', 'agent_start'])(
    'applies changes made after agent_end at %s, before another request',
    async (boundary) => {
      for (const next of [true, false]) {
        const f = fixture()
        await f.command(next ? 'off' : 'on')
        f.ctx.isIdle.mockReturnValue(false)
        f.emit('agent_end')
        // Pi remains busy during post-run compaction / before-settle handlers.
        await f.command(next ? 'on' : 'off')
        expect(f.status()).toMatchObject({ requested: next, enabled: !next })
        // It can either settle or continue directly into a queued/recovery run.
        f.emit(boundary)
        expect(f.status()).toMatchObject({ requested: next, enabled: next })
        expect(f.send().includes(SWARM_PROMPT)).toBe(next)
      }
    },
  )

  it('applies a change during pre-run compaction before the first agent request', async () => {
    const f = fixture()
    await f.command('on')
    f.ctx.isIdle.mockReturnValue(false)
    await f.command('off')
    expect(f.status().enabled).toBe(true)
    f.emit('agent_start')
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

  it('adopts copied authorization only for a session with a parent, then persists its own identity', async () => {
    const f = fixture()
    await f.command('on')
    f.ctx.sessionManager.getSessionId = () => 'clone'
    Object.assign(f.ctx.sessionManager, { getHeader: () => ({ parentSession: '/parent.jsonl' }) })
    f.emit('session_start')
    expect(f.status().requested).toBe(true)
    expect(f.pi.appendEntry).toHaveBeenLastCalledWith(SWARM_COMMAND, {
      enabled: true,
      sessionId: 'clone',
    })
    const writes = f.pi.appendEntry.mock.calls.length
    f.emit('session_start')
    expect(f.pi.appendEntry).toHaveBeenCalledTimes(writes)
    await f.command('off')
    f.ctx.sessionManager.getSessionId = () => 'second-clone'
    f.emit('session_start')
    expect(f.status().requested).toBe(false)
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

it('accepts additive status fields at version 1', () => {
  const status = { version: 1, available: true, enabled: false, requested: true, by: 'user' }
  expect(parseSwarmStatus(JSON.stringify(status))).toEqual(status)
})

it('applies an agent decision on the very next request and restores its attribution without re-notifying', async () => {
  const f = fixture()
  const control = f.state.control
  expect(control).toBeDefined()
  f.ctx.isIdle.mockReturnValue(false)
  f.emit('agent_start')
  expect(f.send()).not.toContain(SWARM_PROMPT)
  expect(control.facts().userOff).toBe(false)
  const reason = 'Review independent changes'
  await control.agentSet(true, reason, f.ctx)
  expect(f.send()).toContain(SWARM_PROMPT)
  expect(f.ctx.ui.notify.mock.calls).toEqual([[`Agent turned on Swarm: ${reason}.`]])
  expect(f.pi.appendEntry).toHaveBeenLastCalledWith(SWARM_COMMAND, {
    sessionId: 'one',
    enabled: true,
    by: 'agent',
    reason,
  })
  f.emit('session_start')
  expect(f.status()).toMatchObject({
    version: 1,
    enabled: true,
    requested: true,
    source: 'agent',
    reason,
  })
  f.ctx.sessionManager.getSessionId = () => 'fork'
  Object.assign(f.ctx.sessionManager, { getHeader: () => ({ parentSession: 'parent.jsonl' }) })
  f.emit('session_start')
  expect(f.pi.appendEntry).toHaveBeenLastCalledWith(SWARM_COMMAND, {
    sessionId: 'fork',
    enabled: true,
    by: 'agent',
    reason,
  })
  expect(f.ctx.ui.notify).toHaveBeenCalledTimes(1)
  await f.command('off')
  expect(control.facts()).toEqual({
    available: true,
    enabled: true,
    requested: false,
    lastBy: 'user',
    userOff: true,
  })
  await expect(async () => control.agentSet(true, reason, f.ctx)).rejects.toThrow(
    'The user turned Swarm off',
  )
  expect(f.status()).not.toHaveProperty('source')
  f.emit('agent_end')
  expect(f.send()).not.toContain(SWARM_PROMPT)
})

it('treats a legacy off as the user’s on its branch and does not let an agent off erase it', async () => {
  const f = fixture()
  const control = f.state.control
  expect(control).toBeDefined()
  f.pi.appendEntry(SWARM_COMMAND, { sessionId: 'one', enabled: false })
  f.emit('session_start')
  expect(control.facts().userOff).toBe(true)
  await control.agentSet(false, 'No delegation needed', f.ctx)
  await expect(async () => control.agentSet(true, 'Parallel review', f.ctx)).rejects.toThrow(
    'The user turned Swarm off',
  )
  expect(f.pi.appendEntry).toHaveBeenCalledTimes(1)
  f.branch.length = 0
  f.emit('session_tree')
  expect(control.facts().userOff).toBe(false)
  await expect(async () => control.agentSet(true, '  ', f.ctx)).rejects.toThrow(/reason/i)
  f.pi.getActiveTools.mockReturnValue([])
  await expect(async () => control.agentSet(true, 'Parallel review', f.ctx)).rejects.toThrow(
    'requires pi-subagents',
  )
  expect(f.pi.appendEntry).toHaveBeenCalledTimes(1)
  expect(f.ctx.ui.notify).not.toHaveBeenCalled()
})

it('normalizes only the version-one attribution fields', () => {
  const old = { version: 1, available: true, requested: true, enabled: true }
  expect(parseSwarmStatus(JSON.stringify({ ...old, source: 'user', reason: 42 }))).toEqual(old)
  expect(
    parseSwarmStatus(JSON.stringify({ ...old, source: 'agent', reason: 'a'.repeat(201) })),
  ).toEqual({ ...old, source: 'agent', reason: 'a'.repeat(200) })
})
