import { afterEach, expect, it, vi } from 'vitest'
import { sessionFixture } from './__fixtures__/session-runtime'
import type { LiveSession } from './session-registry'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
function fixture() {
  const h = sessionFixture()
  cleanups.push(() => h.registry.disposeAll())
  const augmentation = {
    env: { PHOSPHOR_MEMORY_TOKEN: 'issued-local-capability' },
    extensions: ['/audited/brain-working-lane.ts'],
    onCreated: vi.fn((_session: LiveSession) => {}),
    dispose: vi.fn(async () => {}),
  }
  const prepare = vi.fn(async () => augmentation)
  Object.assign(h.runtime, { memory: { prepare } })
  return { ...h, augmentation, prepare }
}

it('augments only an ordinary interactive launch and binds its actual created session before readiness', async () => {
  const h = fixture()
  const create = vi.spyOn(h.registry, 'create')
  h.augmentation.onCreated.mockImplementation((session) => {
    expect(h.registry.get(session.sessionId)).toBe(session)
    expect(h.clients[0]!.spawn).toHaveBeenCalledOnce()
    expect(h.clients[0]!.request).not.toHaveBeenCalled()
  })
  const live = await h.spawn({ workspacePath: '/repo' }, h.sink)
  expect(h.prepare).toHaveBeenCalledExactlyOnceWith({ workspacePath: '/repo' })
  expect(create.mock.calls[0]?.[1]).toMatchObject({
    env: { PHOSPHOR_MEMORY_TOKEN: 'issued-local-capability' },
    extensions: ['/audited/brain-working-lane.ts'],
  })
  expect(h.augmentation.onCreated).toHaveBeenCalledWith(h.registry.get(live.sessionId))
  expect(h.augmentation.dispose).not.toHaveBeenCalled()
})

it.each(['spawn', 'bind', 'readiness', 'bookkeeping', 'cancel'] as const)(
  'revokes a prepared capability after %s failure',
  async (failure) => {
    const h = fixture()
    const controller = new AbortController()
    if (failure === 'spawn')
      vi.spyOn(h.registry, 'create').mockImplementation(() => {
        throw new Error('spawn')
      })
    if (failure === 'bind')
      h.augmentation.onCreated.mockImplementation(() => {
        throw new Error('bind')
      })
    if (failure === 'readiness')
      h.registry.on('created', () =>
        h.clients[0]!.request.mockRejectedValue(new Error('readiness')),
      )
    if (failure === 'bookkeeping')
      vi.mocked(h.runtime.recordWorkspace).mockImplementation(() => {
        throw new Error('bookkeeping')
      })
    if (failure === 'cancel')
      h.prepare.mockImplementation(async () => {
        controller.abort()
        return h.augmentation
      })
    await expect(
      h.spawn({ workspacePath: '/repo' }, h.sink, { signal: controller.signal }),
    ).rejects.toThrow()
    expect(h.augmentation.dispose).toHaveBeenCalledOnce()
    expect(h.registry.list()).toEqual([])
  },
)

it.each(['stub', 'unattended'] as const)(
  'does not issue working-memory capabilities for %s sessions',
  async (mode) => {
    const h = fixture()
    if (mode === 'stub')
      vi.mocked(h.runtime.launch).mockResolvedValue({ stub: true, env: {}, extensions: [] })
    await h.spawn({ workspacePath: '/repo' }, h.sink, { unattended: mode === 'unattended' })
    expect(h.prepare).not.toHaveBeenCalled()
  },
)
