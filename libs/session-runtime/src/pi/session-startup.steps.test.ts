import { afterEach, describe, expect, it, vi } from 'vitest'
import { sessionFixture } from './__fixtures__/session-runtime'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
function fixture() {
  const h = sessionFixture()
  cleanups.push(() => h.registry.disposeAll())
  vi.mocked(h.runtime.policy.defaultProvider).mockResolvedValue('pi-claude-cli')
  vi.mocked(h.runtime.policy.packages).mockResolvedValue([
    { name: '@saccolabs/pi-claude-cli', version: '0.10.0', installed: true },
  ])
  vi.mocked(h.runtime.policy.account).mockResolvedValue({ id: 'account', env: {} })
  return h
}

describe('session startup steps', () => {
  it.each(['sink', 'watch', 'remember', 'track', 'record'] as const)(
    'disposes before forgetting and removes the listener after %s failure',
    async (failure) => {
      const h = fixture()
      const controller = new AbortController()
      const order: string[] = []
      const remove = vi.spyOn(controller.signal, 'removeEventListener')
      const fail = () => {
        throw new Error(failure)
      }
      h.runtime.accounts.forget = vi.fn(() => order.push('forget'))
      h.registry.on('created', () => {
        const client = h.clients[0]!
        const dispose = client.dispose.getMockImplementation()!
        client.dispose.mockImplementation(async () => {
          order.push('dispose')
          await dispose()
        })
      })
      h.runtime.laneReload = { capture: vi.fn(async () => 'snapshot'), track: vi.fn() }
      if (failure === 'watch') h.runtime.budget.watch = fail
      if (failure === 'remember') h.runtime.accounts.remember = fail
      if (failure === 'track') h.runtime.laneReload.track = fail
      if (failure === 'record') h.runtime.recordWorkspace = fail
      await expect(
        h.spawn({ workspacePath: '/repo' }, failure === 'sink' ? fail : h.sink, {
          signal: controller.signal,
        }),
      ).rejects.toThrow(failure)
      expect(order).toEqual(['dispose', 'forget'])
      expect(h.registry.list()).toEqual([])
      expect(h.clients[0]!.dispose).toHaveBeenCalledOnce()
      expect(h.runtime.accounts.forget).toHaveBeenCalledWith(expect.any(String))
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
      expect(vi.mocked(h.runtime.accounts.forget).mock.invocationCallOrder[0]).toBeLessThan(
        remove.mock.invocationCallOrder[0]!,
      )
    },
  )

  it('retains a writer after failed disposal but still removes the abort listener', async () => {
    const h = fixture()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    h.registry.on('created', () => {
      h.clients[0]!.dispose.mockRejectedValueOnce(new Error('dispose failed'))
    })
    await expect(
      h.spawn(
        { workspacePath: '/repo' },
        () => {
          throw new Error('binding failed')
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow('dispose failed')
    expect(h.registry.list()).toHaveLength(1)
    expect(h.runtime.accounts.forget).not.toHaveBeenCalled()
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    await h.registry.disposeAll()
    expect(h.registry.list()).toEqual([])
  })

  it('refuses completion when readiness leaves the client stopped', async () => {
    const h = fixture()
    h.registry.on('created', () => {
      h.clients[0]!.alive = false
    })
    await expect(h.spawn({ workspacePath: '/repo' }, h.sink)).rejects.toThrow(
      'Session stopped during startup.',
    )
    expect(h.runtime.accounts.remember).not.toHaveBeenCalled()
    expect(h.runtime.recordWorkspace).not.toHaveBeenCalled()
    expect(h.clients[0]!.dispose).toHaveBeenCalledOnce()
    expect(h.runtime.accounts.forget).toHaveBeenCalledOnce()
  })

  it('uses current completion dependencies after readiness and removes a successful abort listener', async () => {
    const h = fixture()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const remember = vi.fn()
    const track = vi.fn()
    const record = vi.fn()
    h.runtime.laneReload = { capture: vi.fn(async () => 'captured'), track: vi.fn() }
    h.registry.on('created', () => {
      h.clients[0]!.request.mockImplementation(async () => {
        h.runtime.accounts.remember = remember
        h.runtime.laneReload = { capture: vi.fn(async () => 'later'), track }
        h.runtime.recordWorkspace = record
        return {
          success: true,
          data: { autoCompactionEnabled: true, model: { provider: 'native' } },
        }
      })
    })
    const live = await h.spawn({ workspacePath: '/repo' }, h.sink, { signal: controller.signal })
    expect(remember).toHaveBeenCalledWith(live.sessionId, 'account')
    expect(track).toHaveBeenCalledWith(live.sessionId, 'captured', h.clients[0])
    expect(record).toHaveBeenCalledWith('/repo', 'repo')
    expect(remember.mock.invocationCallOrder[0]).toBeLessThan(track.mock.invocationCallOrder[0]!)
    expect(track.mock.invocationCallOrder[0]).toBeLessThan(record.mock.invocationCallOrder[0]!)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    controller.abort()
    expect(h.clients[0]!.dispose).not.toHaveBeenCalled()
  })
})
