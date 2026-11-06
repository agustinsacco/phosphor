import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_BRAIN_PREFS } from '@phosphor/shared/brain'
import { adapterFixture, deferred } from './__fixtures__/adapter-fixture'
vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }))
const { assembleBrainService } = await import('./service')

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture() {
  const f = await adapterFixture()
  cleanup.push(f.cleanup)
  const service = await assembleBrainService(f.options, f.store)
  cleanup.push(() => service.dispose())
  return { ...f, service }
}
it('rejects a failed initial database read and closes resources instead of caching a dead service', async () => {
  const f = await adapterFixture()
  cleanup.push(f.cleanup)
  vi.spyOn(f.store, 'snapshot').mockRejectedValueOnce(new Error('database offline'))
  const close = vi.spyOn(f.store, 'close')
  const result = assembleBrainService(f.options, f.store).then((service) => {
    cleanup.push(() => service.dispose())
    return service
  })
  await expect(result).rejects.toThrow('database offline')
  expect(close).toHaveBeenCalledOnce()
  expect(f.embeds.dispose).toHaveBeenCalledOnce()
})
it('defaults off, never downloads on enable, and exposes only typed UI operations', async () => {
  const f = await adapterFixture()
  cleanup.push(f.cleanup)
  f.engine.setPrefs(DEFAULT_BRAIN_PREFS)
  const service = await assembleBrainService(f.options, f.store)
  cleanup.push(() => service.dispose())
  expect((await service.ui['brain:status']()).snapshot.prefs.enabled).toBe(false)
  await service.ui['brain:setPrefs']({
    ...DEFAULT_BRAIN_PREFS,
    enabled: true,
    workspaces: [f.scope],
  })
  expect(f.embeds.download).not.toHaveBeenCalled()
  expect(Object.keys(service.ui)).not.toContain('dispose')
  expect(Object.keys(service.ui)).not.toContain('putVectors')
})
it('serializes a policy change against manual admission so stale consent cannot start a processor', async () => {
  const f = await fixture()
  const policy = f.service.ui['brain:setPrefs']({ ...f.snapshot.prefs, recall: false })
  const processing = expect(
    f.service.ui['brain:process'](f.scope, { model: f.model, policyEpoch: f.snapshot.policyEpoch }),
  ).rejects.toThrow('consent')
  await policy
  await processing
  expect(f.options.sessions.create).not.toHaveBeenCalled()
})
it('rejects hidden Host/remote authority keys instead of persisting them in local preferences', async () => {
  const f = await fixture()
  await expect(
    f.service.ui['brain:setPrefs']({
      ...f.snapshot.prefs,
      hostId: 'remote-host',
    } as typeof f.snapshot.prefs),
  ).rejects.toThrow('field')
  await expect(
    f.service.ui['brain:search']({ query: 'Atlas', hostId: 'remote-host' } as { query: string }),
  ).rejects.toThrow('field')
})
it('disposes idempotently while startup is pending and rejects later UI work', async () => {
  const f = await fixture()
  const pending = deferred<Awaited<ReturnType<typeof f.options.processor.resolve>>>()
  vi.mocked(f.options.processor.resolve).mockReturnValue(pending.promise)
  await f.service.ui['brain:process'](f.scope, {
    model: f.model,
    policyEpoch: f.snapshot.policyEpoch,
  })
  const first = f.service.dispose(),
    second = f.service.dispose()
  expect(first).toBe(second)
  await first
  expect(f.embeds.dispose).toHaveBeenCalledTimes(1)
  await expect(f.service.ui['brain:status']()).rejects.toThrow('disposed')
})
