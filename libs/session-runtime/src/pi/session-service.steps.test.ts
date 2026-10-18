import { afterEach, describe, expect, it, vi } from 'vitest'
import { sessionFixture } from './__fixtures__/session-runtime'
import { createSessionService, type SessionServiceRuntime } from './session-service'
import { createSessionPathRuntime } from './session-path-lock'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function fixture() {
  const h = sessionFixture()
  cleanups.push(() => h.registry.disposeAll())
  const runtime: SessionServiceRuntime<string> = {
    registry: h.registry,
    paths: createSessionPathRuntime(),
    spawn: vi.fn((options, _delivery, execution) => h.spawn(options, h.sink, execution)),
    isStub: () => false,
    packages: h.runtime.policy.packages,
    readBudget: h.runtime.budget.read,
    withBudgetCompaction: h.budget.withBudgetCompaction,
    forgetAccount: h.runtime.accounts.forget,
    routines: {
      owns: vi.fn(() => false),
      sessionForPath: vi.fn((): string | undefined => undefined),
      observe: vi.fn(),
      cancel: vi.fn(async () => {}),
    },
  }
  return { ...h, runtime, service: createSessionService(runtime) }
}

describe('session service steps', () => {
  it('keeps admission dependencies bound but reads spawn and delivery at invocation', async () => {
    const h = fixture()
    const registry = h.runtime.registry
    const routines = h.runtime.routines
    const paths = h.runtime.paths
    const alternate = sessionFixture()
    cleanups.push(() => alternate.registry.disposeAll())
    h.runtime.registry = alternate.registry
    h.runtime.paths = createSessionPathRuntime()
    h.runtime.routines = { ...routines, owns: () => true }
    const spawn = vi.fn(h.runtime.spawn)
    h.runtime.spawn = spawn
    const execution = { unattended: true }
    const live = await h.service.create({ workspacePath: '/repo' }, 'delivery', execution)
    expect(spawn).toHaveBeenCalledWith({ workspacePath: '/repo' }, 'delivery', execution)
    expect(h.service.list()).toEqual(registry.list())
    expect(alternate.registry.list()).toEqual([])
    const open = vi.spyOn(paths, 'openSessionPath')
    vi.mocked(routines.sessionForPath).mockReturnValue(live.sessionId)
    expect(await h.service.create({ workspacePath: '/repo', sessionPath: '/unwritten' })).toEqual(
      live,
    )
    expect(open).not.toHaveBeenCalled()
    await h.service.command(live.sessionId, { type: 'get_state' })
    const response = { type: 'extension_ui_response', id: 'dialog', cancelled: true } as const
    h.service.respond(live.sessionId, response)
    expect(h.clients[0]!.respondToExtensionUI).toHaveBeenCalledWith(response)
  })

  it('reads provider packages and budget after waiting in the command gate', async () => {
    const h = fixture()
    const live = await h.service.create({ workspacePath: '/repo' })
    const client = h.clients[0]!
    client.request.mockClear()
    let dispatch!: () => Promise<unknown>
    h.runtime.withBudgetCompaction = (_id, _type, action) =>
      new Promise((resolve, reject) => {
        dispatch = () => action().then(resolve, reject)
      })
    const pending = h.service.command(live.sessionId, {
      type: 'set_model',
      provider: 'pi-claude-cli',
      modelId: 'claude',
    })
    expect(client.request).not.toHaveBeenCalled()
    h.runtime.packages = vi.fn(async () => [
      { name: '@saccolabs/pi-claude-cli', version: '0.10.0', installed: true },
    ])
    await dispatch()
    await pending
    expect(h.runtime.packages).toHaveBeenCalledWith('/repo')
    expect(client.request).toHaveBeenCalledExactlyOnceWith({
      type: 'set_model',
      provider: 'pi-claude-cli',
      modelId: 'claude',
    })
    h.runtime.withBudgetCompaction = async (_id, _type, action) => {
      h.runtime.readBudget = () => '400k'
      return action()
    }
    client.request.mockClear()
    await h.service.command(live.sessionId, { type: 'prompt', message: 'go' })
    expect(client.request.mock.calls.map(([command]) => command)).toEqual([
      { type: 'get_state' },
      { type: 'get_state' },
      { type: 'prompt', message: '/phosphor-context-budget 400000' },
      { type: 'prompt', message: 'go' },
    ])
  })

  it('refuses unverifiable models before reload or dispatch', async () => {
    const h = fixture()
    const live = await h.service.create({ workspacePath: '/repo' })
    const beforePrompt = vi.fn(async () => 'unchanged' as const)
    h.runtime.laneReload = { beforePrompt }
    const client = h.clients[0]!
    client.request.mockClear()
    client.request.mockResolvedValueOnce({ success: false } as never)
    await expect(
      h.service.command(live.sessionId, { type: 'prompt', message: 'go' }),
    ).rejects.toThrow('Cannot verify the active pi model.')
    expect(beforePrompt).not.toHaveBeenCalled()
    expect(client.request).toHaveBeenCalledExactlyOnceWith({ type: 'get_state' })
  })

  it('skips preflight for a live stub flag and only syncs successful compaction changes', async () => {
    const h = fixture()
    const live = await h.service.create({ workspacePath: '/repo' })
    const client = h.clients[0]!
    client.request.mockClear()
    h.runtime.isStub = () => true
    await h.service.command(live.sessionId, { type: 'prompt', message: 'stub' })
    expect(client.request).toHaveBeenCalledExactlyOnceWith({ type: 'prompt', message: 'stub' })
    h.runtime.isStub = () => false
    client.request.mockClear()
    client.request.mockResolvedValueOnce({ success: false } as never)
    await h.service.command(live.sessionId, { type: 'set_auto_compaction', enabled: false })
    expect(client.request).toHaveBeenCalledExactlyOnceWith({
      type: 'set_auto_compaction',
      enabled: false,
    })
    client.request.mockClear()
    await h.service.command(live.sessionId, { type: 'set_auto_compaction', enabled: true })
    expect(client.request.mock.calls.map(([command]) => command.type)).toEqual([
      'set_auto_compaction',
      'get_state',
      'prompt',
    ])
  })

  it('waits for routine cancellation before forgetting and disposing the bound registry', async () => {
    const h = fixture()
    const live = await h.service.create({ workspacePath: '/repo' })
    vi.mocked(h.runtime.routines.owns).mockReturnValue(true)
    h.runtime.routines.cancel = vi.fn(async () => {
      expect(h.runtime.forgetAccount).not.toHaveBeenCalled()
      expect(h.registry.get(live.sessionId)).toBeDefined()
      throw new Error('cancel failed')
    })
    await expect(h.service.dispose(live.sessionId)).rejects.toThrow('cancel failed')
    expect(h.runtime.forgetAccount).not.toHaveBeenCalled()
    h.runtime.routines.cancel = vi.fn(async () => {})
    const forget = vi.fn(() => expect(h.registry.get(live.sessionId)).toBeDefined())
    h.runtime.forgetAccount = forget
    await h.service.dispose(live.sessionId)
    expect(forget).toHaveBeenCalledWith(live.sessionId)
    expect(h.registry.list()).toEqual([])
  })
})
