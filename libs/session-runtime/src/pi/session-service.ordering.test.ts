import { afterEach, expect, it, vi } from 'vitest'
import type { RpcCommand } from '@phosphor/shared/rpc'
import { sessionFixture } from './__fixtures__/session-runtime'
import { createSessionService } from './session-service'
import { createSessionPathRuntime } from './session-path-lock'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
async function fixture() {
  const h = sessionFixture()
  cleanups.push(() => h.registry.disposeAll())
  const service = createSessionService({
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
      observe() {},
      cancel: async () => {},
    },
  })
  const info = await service.create({ workspacePath: '/repo' })
  const request = h.clients[0]!.request
  request.mockClear()
  request.mockImplementation(async (command: RpcCommand) =>
    command.type === 'get_commands'
      ? ({
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
        } as never)
      : ({ success: true, data: { isStreaming: false, isCompacting: false } } as never),
  )
  return { ...h, service, info, request }
}
it('reserves a Brain-off mutation before a same-stack MCP reconnect can jump ahead', async () => {
  const h = await fixture()
  const mutation = h.service.command(h.info.sessionId, { type: 'set_thinking_level', level: 'off' })
  const outcome = mutation.catch((error: unknown) => error)
  await expect(h.service.mcpControl(h.info.sessionId, 'api', 'reconnect')).rejects.toThrow('busy')
  await expect(outcome).resolves.toMatchObject({ success: true })
  expect(h.request.mock.calls.some(([command]) => command.type === 'get_commands')).toBe(false)
  await h.service.mcpControl(h.info.sessionId, 'api', 'reconnect')
  expect(
    h.request.mock.calls.some(
      ([command]) => command.type === 'prompt' && command.message.startsWith('/mcp reconnect '),
    ),
  ).toBe(true)
})
it('reserves and then releases mutation admission even when optional invalidation fails', async () => {
  const h = await fixture()
  let release!: () => void
  const failure = new Promise<void>((_resolve, reject) => {
    release = () => reject(new Error('Optional invalidation failed'))
  })
  h.registry.get(h.info.sessionId)!.memoryInput = {
    beforeInput: async () => undefined,
    invalidate() {
      throw new Error('Invalidation')
    },
    failed: () => failure,
  }
  const mutation = h.service.command(h.info.sessionId, { type: 'new_session' })
  const outcome = mutation.catch((error: unknown) => error)
  const reconnect = h.service.mcpControl(h.info.sessionId, 'api', 'reconnect')
  release()
  await expect(reconnect).rejects.toThrow('busy')
  await expect(outcome).resolves.toMatchObject({ message: 'Optional invalidation failed' })
  await expect(h.service.mcpControl(h.info.sessionId, 'api', 'reconnect')).resolves.toMatchObject({
    ok: false,
  })
})
it('keeps the lane busy until every admitted mutation has settled', async () => {
  const h = await fixture()
  const release: (() => void)[] = []
  const normal = h.request.getMockImplementation()!
  h.request.mockImplementation(async (command) =>
    command.type === 'set_thinking_level'
      ? await new Promise((resolve) => {
          release.push(() => resolve({ success: true } as never))
        })
      : normal(command),
  )
  const first = h.service.command(h.info.sessionId, { type: 'set_thinking_level', level: 'off' })
  const second = h.service.command(h.info.sessionId, { type: 'set_thinking_level', level: 'low' })
  await vi.waitFor(() => expect(release).toHaveLength(1))
  release[0]!()
  await first
  await expect(h.service.mcpControl(h.info.sessionId, 'api', 'reconnect')).rejects.toThrow('busy')
  await vi.waitFor(() => expect(release).toHaveLength(2))
  release[1]!()
  await second
  await expect(h.service.mcpControl(h.info.sessionId, 'api', 'reconnect')).resolves.toMatchObject({
    ok: false,
  })
})
