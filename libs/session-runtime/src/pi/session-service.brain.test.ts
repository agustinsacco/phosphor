import { afterEach, expect, it, vi } from 'vitest'
import { sessionFixture } from './__fixtures__/session-runtime'
import { createSessionService, type SessionServiceRuntime } from './session-service'
import { createSessionPathRuntime } from './session-path-lock'
import type { RpcCommand } from '@shared/rpc'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
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
      owns: () => false,
      sessionForPath: () => undefined,
      observe: vi.fn(),
      cancel: vi.fn(async () => {}),
    },
  }
  return { ...h, service: createSessionService(runtime), serviceRuntime: runtime }
}

it.each<RpcCommand>([
  { type: 'prompt', message: '/mcp reconnect secret' },
  { type: 'prompt', message: 'ordinary user input' },
  { type: 'steer', message: 'injection' },
  { type: 'follow_up', message: 'injection' },
  { type: 'bash', command: 'printf bypass' },
  { type: 'set_model', provider: 'other', modelId: 'other' },
  { type: 'compact' },
  { type: 'switch_session', sessionPath: '/other' },
  { type: 'new_session' },
  { type: 'fork', entryId: 'entry' },
  { type: 'clone' },
  { type: 'export_html', outputPath: '/tmp/export.html' },
  { type: 'abort' },
])('refuses manual $type on a Brain-owned lane before any RPC', async (command) => {
  const h = fixture()
  const live = await h.service.create({ workspacePath: '/repo' })
  Object.assign(h.registry.get(live.sessionId)!, { owner: { kind: 'brain', jobId: 'job' } })
  h.clients[0]!.request.mockClear()
  await expect(h.service.command(live.sessionId, command)).rejects.toThrow('Brain')
  expect(h.clients[0]!.request).not.toHaveBeenCalled()
})

it('refuses extension UI and MCP control on a Brain-owned lane', async () => {
  const h = fixture()
  const live = await h.service.create({ workspacePath: '/repo' })
  Object.assign(h.registry.get(live.sessionId)!, { owner: { kind: 'brain', jobId: 'job' } })
  expect(() => h.service.respond(live.sessionId, {
    type: 'extension_ui_response', id: 'dialog', confirmed: true,
  })).toThrow('Brain')
  await expect(h.service.mcpControl(live.sessionId, 'connector', 'inspect')).rejects.toThrow('Brain')
  await expect(h.service.mcpControl(live.sessionId, 'connector', 'reconnect')).rejects.toThrow('Brain')
  expect(h.clients[0]!.respondToExtensionUI).not.toHaveBeenCalled()
})

it('allows observation without running the interactive budget gate', async () => {
  const h = fixture()
  const live = await h.service.create({ workspacePath: '/repo' })
  Object.assign(h.registry.get(live.sessionId)!, { owner: { kind: 'brain', jobId: 'job' } })
  h.serviceRuntime.withBudgetCompaction = vi.fn(h.serviceRuntime.withBudgetCompaction)
  h.clients[0]!.request.mockClear()
  await h.service.command(live.sessionId, { type: 'get_entries' })
  expect(h.clients[0]!.request).toHaveBeenCalledExactlyOnceWith({ type: 'get_entries' })
  expect(h.serviceRuntime.withBudgetCompaction).not.toHaveBeenCalled()
})
