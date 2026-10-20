import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionFixture } from './__fixtures__/session-runtime'
import { createSessionService, type SessionServiceRuntime } from './session-service'
import { createSessionPathRuntime, sessionPathKey } from './session-path-lock'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean()
})
function fixture() {
  const h = sessionFixture()
  cleanups.push(() => h.registry.disposeAll())
  const runtime: SessionServiceRuntime<undefined> = {
    registry: h.registry,
    paths: createSessionPathRuntime(),
    spawn: (options, _delivery, execution) => h.spawn(options, h.sink, execution),
    isStub: () => false,
    packages: h.runtime.policy.packages,
    readBudget: h.runtime.budget.read,
    withBudgetCompaction: h.budget.withBudgetCompaction,
    forgetAccount: h.runtime.accounts.forget,
    routines: {
      owns: vi.fn(() => false),
      sessionForPath: vi.fn(() => undefined),
      observe: vi.fn(),
      cancel: vi.fn(async () => {}),
    },
  }
  return { ...h, serviceRuntime: runtime, service: createSessionService(runtime) }
}
async function transcript() {
  const dir = await mkdtemp(join(tmpdir(), 'phosphor-service-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'session.jsonl')
  await writeFile(
    path,
    JSON.stringify({ type: 'session', version: 3, id: 'fixture-session', cwd: dir }) + '\n',
  )
  return { dir, path }
}

describe('portable session admission', () => {
  it('serializes symlink aliases and concurrent resumes into one writer', async () => {
    const { dir, path } = await transcript()
    await symlink(dir, join(dir, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    const h = fixture()
    const sessions = await Promise.all(
      [path, join(dir, 'alias', 'session.jsonl'), path].map((sessionPath) =>
        h.service.create({ workspacePath: dir, sessionPath }),
      ),
    )
    expect(new Set(sessions.map((s) => s.sessionId)).size).toBe(1)
    expect(h.clients).toHaveLength(1)
    expect(h.clients[0]!.sessionFile).toBe(sessionPathKey(path))
  })

  it('disposes retained crashed handles before a genuine resume; rejects missing files', async () => {
    const { dir, path } = await transcript()
    const h = fixture()
    const old = await h.service.create({ workspacePath: dir, sessionPath: path })
    h.clients[0]!.alive = false
    const resumed = await h.service.create({ workspacePath: dir, sessionPath: path })
    expect(resumed.sessionId).not.toBe(old.sessionId)
    expect(h.registry.get(old.sessionId)).toBeUndefined()
    await expect(
      h.service.create({ workspacePath: dir, sessionPath: join(dir, 'gone') }),
    ).rejects.toThrow('ENOENT')
    expect(h.clients).toHaveLength(2)
  })

  it('adopts routine processes and restricts manual mutations while allowing observation', async () => {
    const h = fixture()
    const live = await h.service.create({ workspacePath: '/repo' })
    vi.mocked(h.serviceRuntime.routines.owns).mockReturnValue(true)
    vi.mocked(h.serviceRuntime.routines.sessionForPath).mockReturnValue(live.sessionId)
    expect(
      await h.service.create({ workspacePath: '/repo', sessionPath: '/not-yet-written' }),
    ).toEqual(live)
    h.clients[0]!.request.mockClear()
    await h.service.command(live.sessionId, { type: 'get_messages' })
    expect(h.serviceRuntime.routines.observe).toHaveBeenCalledWith(live.sessionId)
    await expect(
      h.service.command(live.sessionId, { type: 'prompt', message: 'unsafe' }),
    ).rejects.toThrow('owned by a running routine')
    expect(h.clients[0]!.request).toHaveBeenCalledExactlyOnceWith({ type: 'get_messages' })
    await h.service.dispose(live.sessionId)
    expect(h.serviceRuntime.routines.cancel).toHaveBeenCalledWith(live.sessionId)
    expect(h.registry.list()).toEqual([])
  })

  it('checks resolved provider and current budget before dispatch, not just at startup', async () => {
    const h = fixture()
    const live = await h.service.create({ workspacePath: '/repo' })
    const client = h.clients[0]!
    client.request.mockClear()
    client.request.mockResolvedValueOnce({
      success: true,
      data: { autoCompactionEnabled: true, model: { provider: 'pi-claude-cli' } },
    })
    await expect(
      h.service.command(live.sessionId, { type: 'prompt', message: 'blocked' }),
    ).rejects.toThrow('not installed')
    expect(client.request).toHaveBeenCalledExactlyOnceWith({ type: 'get_state' })
    client.request.mockClear()
    vi.mocked(h.runtime.budget.read).mockReturnValue('400k')
    await h.service.command(live.sessionId, { type: 'prompt', message: 'allowed' })
    expect(client.request.mock.calls.map(([c]) => c)).toEqual([
      { type: 'get_state' },
      { type: 'get_state' },
      { type: 'prompt', message: '/phosphor-context-budget 400000' },
      { type: 'prompt', message: 'allowed' },
    ])
  })

  it('reloads changed lane config before a turn starts, ahead of the budget sync', async () => {
    const h = fixture()
    const beforePrompt = vi.fn(async (_id: string, client: { request: (c: never) => unknown }) => {
      await client.request({ type: 'prompt', message: '/phosphor-reload t' } as never)
      return 'applied' as const
    })
    h.serviceRuntime.laneReload = { beforePrompt }
    const live = await h.service.create({ workspacePath: '/repo' })
    const client = h.clients[0]!
    client.request.mockClear()
    vi.mocked(h.runtime.budget.read).mockReturnValue('400k')
    await h.service.command(live.sessionId, { type: 'prompt', message: 'go' })
    expect(beforePrompt).toHaveBeenCalledWith(live.sessionId, client, live.workspacePath)
    expect(client.request.mock.calls.map(([c]) => c)).toEqual([
      { type: 'get_state' },
      { type: 'prompt', message: '/phosphor-reload t' },
      { type: 'get_state' },
      { type: 'prompt', message: '/phosphor-context-budget 400000' },
      { type: 'prompt', message: 'go' },
    ])
  })

  it('leaves the lane alone mid-run and for host controls', async () => {
    const h = fixture()
    const beforePrompt = vi.fn(async () => 'applied' as const)
    h.serviceRuntime.laneReload = { beforePrompt }
    const live = await h.service.create({ workspacePath: '/repo' })
    const client = h.clients[0]!
    client.request.mockResolvedValueOnce({
      success: true,
      data: { autoCompactionEnabled: true, model: { provider: 'x' }, isStreaming: true },
    } as never)
    await h.service.command(live.sessionId, { type: 'prompt', message: 'steer this' })
    await h.service.command(live.sessionId, {
      type: 'prompt',
      message: '/phosphor-context-files claude=off',
    })
    expect(beforePrompt).not.toHaveBeenCalled()
  })

  it('rechecks routine ownership after waiting in the command gate', async () => {
    const h = fixture()
    const live = await h.service.create({ workspacePath: '/repo' })
    h.serviceRuntime.withBudgetCompaction = async (_id, _command, action) => {
      vi.mocked(h.serviceRuntime.routines.owns).mockReturnValue(true)
      return action()
    }
    h.clients[0]!.request.mockClear()
    await expect(h.service.command(live.sessionId, { type: 'compact' })).rejects.toThrow(
      'owned by a running routine',
    )
    expect(h.clients[0]!.request).not.toHaveBeenCalled()
  })

  it('rejects unknown commands and extension responses without allocating anything', async () => {
    const h = fixture()
    await expect(h.service.command('missing', { type: 'get_state' })).rejects.toThrow(
      'Unknown session',
    )
    expect(() =>
      h.service.respond('missing', {
        type: 'extension_ui_response',
        id: 'dialog',
        cancelled: true,
      }),
    ).toThrow('Unknown session')
    expect(h.clients).toHaveLength(0)
  })
})

it('holds reconnect admission through native completion while allowing read-only commands', async () => {
  const h = fixture()
  const live = await h.service.create({ workspacePath: '/repo' })
  const client = h.clients[0]!
  let finish!: () => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  client.request.mockImplementation(async (command) => {
    if (command.type === 'get_commands')
      return {
        success: true,
        data: {
          commands: [
            {
              name: 'mcp',
              source: 'extension',
              description: 'MCP [inspection-v1]',
              sourceInfo: { path: 'builtin:mcp', source: 'builtin' },
            },
          ],
        },
      } as never
    if (command.type === 'prompt' && command.message.startsWith('/mcp reconnect ')) {
      entered()
      return new Promise((resolve) => {
        finish = () => resolve({ success: true } as never)
      })
    }
    return { success: true, data: { isStreaming: false, isCompacting: false } } as never
  })
  const reconnect = h.service.mcpControl(live.sessionId, 'api', 'reconnect')
  await started
  await expect(
    h.service.command(live.sessionId, { type: 'prompt', message: 'new work' }),
  ).rejects.toThrow('reconnecting')
  await expect(h.service.mcpControl(live.sessionId, 'api', 'reconnect')).rejects.toThrow(
    'already reconnecting',
  )
  await expect(h.service.command(live.sessionId, { type: 'get_state' })).resolves.toMatchObject({
    success: true,
  })
  finish()
  await reconnect
  await expect(h.service.command(live.sessionId, { type: 'get_state' })).resolves.toMatchObject({
    success: true,
  })
  expect(
    client.request.mock.calls.some(
      ([command]) => command.type === 'prompt' && command.message === 'new work',
    ),
  ).toBe(false)
})

it('queues reconnect behind automatic compaction, including its deferred stats read', async () => {
  const h = fixture()
  const live = await h.service.create({ workspacePath: '/repo' })
  const client = h.clients[0]!
  let enterStats!: () => void
  let releaseStats!: () => void
  let enterCompact!: () => void
  let releaseCompact!: () => void
  const statsStarted = new Promise<void>((resolve) => {
    enterStats = resolve
  })
  const compactStarted = new Promise<void>((resolve) => {
    enterCompact = resolve
  })
  client.request.mockClear()
  client.request.mockImplementation(async (command) => {
    if (command.type === 'get_session_stats') {
      enterStats()
      return new Promise((resolve) => {
        releaseStats = () =>
          resolve({ success: true, data: { contextUsage: { tokens: 500000 } } } as never)
      })
    }
    if (command.type === 'compact') {
      enterCompact()
      return new Promise((resolve) => {
        releaseCompact = () => resolve({ success: true } as never)
      })
    }
    if (command.type === 'get_commands')
      return {
        success: true,
        data: {
          commands: [
            {
              name: 'mcp',
              source: 'extension',
              description: 'MCP [inspection-v1]',
              sourceInfo: { path: 'builtin:mcp', source: 'builtin' },
            },
          ],
        },
      } as never
    return {
      success: true,
      data: {
        autoCompactionEnabled: true,
        isStreaming: false,
        isCompacting: false,
        model: { contextWindow: 1000000 },
      },
    } as never
  })
  client.emit('event', { type: 'agent_settled' })
  await statsStarted
  const reconnect = h.service.mcpControl(live.sessionId, 'api', 'reconnect')
  await Promise.resolve()
  expect(client.request.mock.calls.some(([c]) => c.type === 'get_commands')).toBe(false)
  releaseStats()
  await compactStarted
  expect(client.request.mock.calls.some(([c]) => c.type === 'get_commands')).toBe(false)
  releaseCompact()
  await reconnect
  const types = client.request.mock.calls.map(([c]) => c.type)
  expect(types.indexOf('compact')).toBeLessThan(types.indexOf('get_commands'))
})

it('refuses MCP reconnect while an earlier mutating command is still admitted', async () => {
  const h = fixture()
  const live = await h.service.create({ workspacePath: '/repo' })
  const client = h.clients[0]!
  let release!: () => void
  client.request.mockImplementation(
    async () =>
      new Promise((resolve) => {
        release = () => resolve({ success: true } as never)
      }),
  )
  const mutation = h.service.command(live.sessionId, { type: 'set_thinking_level', level: 'off' })
  await Promise.resolve()
  await expect(h.service.mcpControl(live.sessionId, 'api', 'reconnect')).rejects.toThrow('busy')
  release()
  await mutation
  vi.mocked(h.serviceRuntime.routines.owns).mockReturnValue(true)
  await expect(h.service.mcpControl(live.sessionId, 'api', 'inspect')).rejects.toThrow(
    'running routine',
  )
})
