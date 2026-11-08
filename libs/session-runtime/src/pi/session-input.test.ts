import { afterEach, expect, it, vi } from 'vitest'
import { sessionFixture } from './__fixtures__/session-runtime'
import { createSessionService } from './session-service'
import { createSessionPathRuntime } from './session-path-lock'
import type { SessionMemoryAugmentation } from './session-startup'
import type { SessionInputReceipt } from './session-input'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
function fixture(memory: SessionMemoryAugmentation) {
  const h = sessionFixture()
  cleanups.push(() => h.registry.disposeAll())
  h.runtime.memory = { prepare: async () => memory }
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
  return { ...h, service }
}
it.each(['prompt', 'steer', 'follow_up'] as const)(
  'completes the trusted %s admission after its actual RPC response',
  async (type) => {
    const events: string[] = []
    const complete = vi.fn(async () => {
      events.push('complete')
    })
    const beforeInput = vi.fn(async () => {
      events.push('before')
      return { complete }
    })
    const h = fixture({ onCreated() {}, beforeInput, dispose() {} })
    const info = await h.service.create({ workspacePath: '/repo' })
    const original = h.clients[0]!.request.getMockImplementation()!
    h.clients[0]!.request.mockImplementation(async (command) => {
      if (command.type === type && 'message' in command && command.message === 'user input')
        events.push('send')
      return original(command)
    })
    const result = await h.service.command(info.sessionId, { type, message: 'user input' })
    expect(beforeInput).toHaveBeenCalledWith({ type, message: 'user input' })
    expect(complete).toHaveBeenCalledWith(result)
    expect(events).toEqual(['before', 'send', 'complete'])
  },
)
it.each(['before', 'complete'] as const)(
  'keeps an ordinary command usable when the optional %s hook fails',
  async (stage) => {
    const dispose = vi.fn(async () => {})
    const h = fixture({
      onCreated() {},
      beforeInput: async () => {
        if (stage === 'before') throw new Error('Optional admission failed')
        return {
          complete() {
            throw new Error('Optional completion failed')
          },
        }
      },
      dispose,
    })
    const info = await h.service.create({ workspacePath: '/repo' })
    await expect(
      h.service.command(info.sessionId, { type: 'prompt', message: 'ordinary input' }),
    ).resolves.toMatchObject({ success: true })
    expect(dispose).toHaveBeenCalled()
    expect(h.registry.get(info.sessionId)?.memoryInput).toBeUndefined()
    expect(h.runtime.log).toHaveBeenCalledWith(
      'brain',
      'Optional memory disabled',
      expect.any(Object),
    )
  },
)
it('invalidates pending receipts before switch-away/back and does not complete a stale admission', async () => {
  let release!: (receipt: SessionInputReceipt) => void
  const waiting = new Promise<SessionInputReceipt>((resolve) => {
    release = resolve
  })
  const beforeInput = vi.fn(() => waiting),
    invalidateInput = vi.fn(),
    complete = vi.fn()
  const h = fixture({ onCreated() {}, beforeInput, invalidateInput, dispose() {} })
  const info = await h.service.create({ workspacePath: '/repo' })
  const input = h.service.command(info.sessionId, {
    type: 'prompt',
    message: 'same historical text',
  })
  await vi.waitFor(() => expect(beforeInput).toHaveBeenCalled())
  const away = h.service.command(info.sessionId, {
    type: 'switch_session',
    sessionPath: '/synthetic-history.jsonl',
  })
  const back = h.service.command(info.sessionId, {
    type: 'switch_session',
    sessionPath: '/synthetic-original.jsonl',
  })
  await vi.waitFor(() => expect(invalidateInput).toHaveBeenCalled())
  release({ complete })
  await Promise.all([input, away, back])
  expect(invalidateInput).toHaveBeenCalledOnce()
  expect(complete).not.toHaveBeenCalled()
})
it('invalidates the optional hook even while initial onCreated/baseline is still pending', async () => {
  let release!: () => void
  const baseline = new Promise<void>((resolve) => {
    release = resolve
  })
  const invalidateInput = vi.fn()
  const h = fixture({
    onCreated: () => baseline,
    beforeInput: async () => undefined,
    invalidateInput,
    dispose() {},
  })
  const startup = h.service.create({ workspacePath: '/repo' })
  await vi.waitFor(() => expect(h.registry.list()).toHaveLength(1))
  const live = h.registry.list()[0]!
  await h.service.command(live.sessionId, { type: 'new_session' })
  release()
  await startup
  expect(invalidateInput).toHaveBeenCalled()
  expect(h.registry.get(live.sessionId)?.memoryInput).toBeUndefined()
})
it('notifies a receipt of RPC rejection without replacing the command failure', async () => {
  const complete = vi.fn()
  const h = fixture({ onCreated() {}, beforeInput: async () => ({ complete }), dispose() {} })
  const info = await h.service.create({ workspacePath: '/repo' })
  const original = h.clients[0]!.request.getMockImplementation()!
  h.clients[0]!.request.mockImplementation(async (command) => {
    if (command.type === 'steer') throw new Error('RPC rejected')
    return original(command)
  })
  await expect(
    h.service.command(info.sessionId, { type: 'steer', message: 'input' }),
  ).rejects.toThrow('RPC rejected')
  expect(complete).toHaveBeenCalledWith(undefined)
})
