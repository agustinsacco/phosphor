import { afterEach, describe, expect, it, vi } from 'vitest'
import { sessionFixture } from './__fixtures__/session-runtime'
import { createSessionService, type SessionServiceRuntime } from './session-service'
import { syncContextBudget } from './context-budget'
import { reloadLaneNow } from './lane-reload'
import { LANE_RELOAD_COMMAND } from '@phosphor/pi-extensions/lane-reload'
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

const stateRead = { type: 'get_state' }
const prompt = { type: 'prompt', message: 'go' } as const
const cap = (value = '200000') => ({ type: 'prompt', message: `/phosphor-context-budget ${value}` })

async function promptFixture() {
  const h = fixture()
  const { sessionId } = await h.service.create({ workspacePath: '/repo' })
  const client = h.clients[0]!
  const send = async () => {
    client.request.mockClear()
    await h.service.command(sessionId, prompt)
    return client.request.mock.calls.map(([command]) => command)
  }
  const rpc = h.registry.get(sessionId)!.client
  return { ...h, client, rpc, sessionId, send }
}

it('sends a busy prompt without a budget control when the startup stage is current', async () => {
  const h = await promptFixture()
  const state = { isStreaming: true, model: { provider: 'native' }, autoCompactionEnabled: true }
  h.client.request.mockResolvedValueOnce({ success: true, data: state })
  expect(await h.send()).toEqual([stateRead, prompt])
  expect(await h.send()).toEqual([stateRead, prompt])
})

it.each(['steer', 'follow_up'] as const)('never stages for queue-only %s RPCs', async (type) => {
  const h = await promptFixture()
  vi.mocked(h.runtime.readBudget).mockReturnValue('100k')
  h.client.request.mockClear()
  const input = { type, message: 'go' }
  await h.service.command(h.sessionId, input)
  expect(h.client.request).toHaveBeenCalledExactlyOnceWith(input)
})

it('reuses the startup stage and restages a changed preference or observed model', async () => {
  const h = await promptFixture()
  expect(await h.send()).toEqual([stateRead, prompt])
  vi.mocked(h.runtime.readBudget).mockReturnValue('400k')
  expect(await h.send()).toEqual([stateRead, cap('400000'), prompt])
  const state = { model: { provider: 'native', id: 'other' }, autoCompactionEnabled: true }
  h.client.request.mockResolvedValueOnce({ success: true, data: state })
  expect(await h.send()).toEqual([stateRead, cap('400000'), prompt])
  await h.service.dispose(h.sessionId)
  const next = await h.service.create({ workspacePath: '/repo' })
  const request = h.clients[1]!.request.mockClear()
  await h.service.command(next.sessionId, prompt)
  expect(request.mock.calls.flat()).toEqual([stateRead, prompt])
})

it('restages a cached cap only when beforePrompt can have reloaded extensions', async () => {
  const h = await promptFixture()
  await h.send()
  h.runtime.laneReload = { beforePrompt: vi.fn(async () => 'unchanged' as const) }
  expect(await h.send()).toEqual([stateRead, prompt])
  h.runtime.laneReload.beforePrompt = async () => 'applied'
  expect(await h.send()).toEqual([stateRead, stateRead, cap(), prompt])
})

it.each([
  { type: 'set_model', provider: 'native', modelId: 'other' },
  { type: 'cycle_model' },
  { type: 'new_session' },
  { type: 'switch_session', sessionPath: '/other.jsonl' },
  { type: 'fork', entryId: 'e1' },
  { type: 'clone' },
] as const)(
  'restages after $type even if the selected model has the same identity',
  async (change) => {
    const h = await promptFixture()
    await h.send()
    await h.service.command(h.sessionId, change)
    expect(await h.send()).toEqual([stateRead, cap(), prompt])
  },
)

it('stages immediately after the auto-compaction toggle and remembers the new state', async () => {
  const h = await promptFixture()
  await h.send()
  const change = { type: 'set_auto_compaction', enabled: false } as const
  const state = { model: { provider: 'native' }, autoCompactionEnabled: false }
  h.client.request.mockClear().mockResolvedValue({ success: true, data: state })
  await h.service.command(h.sessionId, change)
  expect(h.client.request.mock.calls.flat()).toEqual([change, stateRead, cap('off')])
  expect(await h.send()).toEqual([stateRead, prompt])
})

it('restages after a slash command, which can change extension state itself', async () => {
  const h = await promptFixture()
  await h.send()
  await h.service.command(h.sessionId, { type: 'prompt', message: '/skill:review' })
  expect(await h.send()).toEqual([stateRead, cap(), prompt])
})

it('leaves nothing remembered when the budget command fails, so the next prompt retries', async () => {
  const h = await promptFixture()
  vi.mocked(h.runtime.readBudget).mockReturnValue('400k')
  h.client.request
    .mockResolvedValueOnce({
      success: true,
      data: { model: { provider: 'native' }, autoCompactionEnabled: true },
    })
    .mockResolvedValueOnce({ success: false, error: 'busy' } as never)
  await expect(h.service.command(h.sessionId, prompt)).rejects.toThrow('busy')
  expect(await h.send()).toEqual([stateRead, cap('400000'), prompt])
  expect(await h.send()).toEqual([stateRead, prompt])
})

it('stages once for concurrent prompts, which the command gate runs in order', async () => {
  const h = await promptFixture()
  vi.mocked(h.runtime.readBudget).mockReturnValue('400k')
  h.client.request.mockClear()
  await Promise.all([
    h.service.command(h.sessionId, prompt),
    h.service.command(h.sessionId, prompt),
  ])
  expect(h.client.request.mock.calls.flat()).toEqual([
    stateRead,
    cap('400000'),
    prompt,
    stateRead,
    prompt,
  ])
})

it('keeps an explicit restage remembered and forgets one that fails', async () => {
  const h = await promptFixture()
  await h.send()
  vi.mocked(h.runtime.readBudget).mockReturnValue('400k')
  await syncContextBudget(h.rpc, '400k')
  expect(await h.send()).toEqual([stateRead, prompt])
  h.client.request
    .mockResolvedValueOnce({
      success: true,
      data: { model: { provider: 'native' }, autoCompactionEnabled: true },
    })
    .mockResolvedValueOnce({ success: false, error: 'busy' } as never)
  await expect(syncContextBudget(h.rpc, '400k')).rejects.toThrow('busy')
  expect(await h.send()).toEqual([stateRead, cap('400000'), prompt])
})

it('restages after an agent-requested reload that reached pi, not one pi cannot run', async () => {
  const h = await promptFixture()
  await h.send()
  h.client.request.mockResolvedValueOnce({ success: true, data: { commands: [] } } as never)
  expect(await reloadLaneNow(h.sessionId, h.rpc, vi.fn())).toBe('unsupported')
  expect(await h.send()).toEqual([stateRead, prompt])
  const commands = { commands: [{ name: LANE_RELOAD_COMMAND }] }
  h.client.request.mockResolvedValueOnce({ success: true, data: commands } as never)
  expect(await reloadLaneNow(h.sessionId, h.rpc, vi.fn())).toBe('failed')
  expect(await h.send()).toEqual([stateRead, cap(), prompt])
})

it.each(['applied', 'failed'] as const)(
  'reads fresh provider and compaction settings after a reload reported as %s',
  async (outcome) => {
    const h = await promptFixture()
    await h.send()
    h.runtime.laneReload = { beforePrompt: async () => outcome }
    h.runtime.packages = vi.fn(async () => [
      { name: '@saccolabs/pi-claude-cli', version: '0.10.0', installed: true },
    ])
    h.client.request
      .mockResolvedValueOnce({
        success: true,
        data: { model: { provider: 'native' }, autoCompactionEnabled: false },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { model: { provider: 'pi-claude-cli' }, autoCompactionEnabled: true },
      })
    expect(await h.send()).toEqual([stateRead, stateRead, cap(), prompt])
    expect(h.runtime.packages).toHaveBeenCalledWith('/repo')
  },
)

it('stages a lowered budget before a prompt can start after a streaming snapshot', async () => {
  const h = await promptFixture()
  await h.send()
  vi.mocked(h.runtime.readBudget).mockReturnValue('100k')
  const state = { isStreaming: true, model: { provider: 'native' }, autoCompactionEnabled: true }
  h.client.request.mockResolvedValueOnce({ success: true, data: state })
  expect(await h.send()).toEqual([stateRead, cap('100000'), prompt])
})

it('restages when an extension restores the uncapped model with the same identity', async () => {
  const h = await promptFixture()
  const uncapped = { provider: 'native', id: 'big', contextWindow: 1_000_000 }
  h.client.request.mockResolvedValue({
    success: true,
    data: { model: uncapped, autoCompactionEnabled: true },
  })
  // Both snapshots see the catalogue window: the first stage capped it in between.
  await h.send()
  expect(await h.send()).toEqual([stateRead, cap(), prompt])
})
