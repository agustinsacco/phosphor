import { afterEach, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_BRAIN_PREFS } from '@phosphor/shared/brain'
import { adapterFixture, deferred } from './__fixtures__/adapter-fixture'
import { assembleBrainService, createBrainService } from './service'

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
  expect((await service.api.status()).snapshot.prefs.enabled).toBe(false)
  await service.api.setPrefs({
    ...DEFAULT_BRAIN_PREFS,
    enabled: true,
    workspaces: [f.scope],
  })
  expect(f.embeds.download).not.toHaveBeenCalled()
  expect(Object.keys(service.api)).not.toContain('dispose')
  expect(Object.keys(service.api)).not.toContain('putVectors')
})
it('routes source pages through the worker with exact enrolled scope and current consent', async () => {
  const f = await fixture()
  const page = await f.service.api.evidence(f.scope)
  expect(page.items.map((item) => item.id)).toEqual([f.evidence.id])
  expect(page.items[0]).not.toHaveProperty('text')
  expect(page.nextCursor).toBeNull()
  await expect(f.service.api.evidence(f.scope + '-other')).rejects.toThrow('consent')
  await expect(f.service.api.evidence(f.scope, 'bad')).rejects.toThrow('cursor')
  await f.service.api.setPrefs({ ...f.snapshot.prefs, enabled: false })
  await expect(f.service.api.evidence(f.scope)).rejects.toThrow('consent')
})

it('serializes a policy change against manual admission so stale consent cannot start a processor', async () => {
  const f = await fixture()
  const policy = f.service.api.setPrefs({ ...f.snapshot.prefs, recall: false })
  const processing = expect(
    f.service.api.process(f.scope, { model: f.model, policyEpoch: f.snapshot.policyEpoch }),
  ).rejects.toThrow('consent')
  await policy
  await processing
  expect(f.options.sessions.create).not.toHaveBeenCalled()
})
it('rejects hidden Host/remote authority keys instead of persisting them in local preferences', async () => {
  const f = await fixture()
  await expect(
    f.service.api.setPrefs({
      ...f.snapshot.prefs,
      hostId: 'remote-host',
    } as typeof f.snapshot.prefs),
  ).rejects.toThrow('field')
  await expect(
    f.service.api.search({ query: 'Atlas', hostId: 'remote-host' } as { query: string }),
  ).rejects.toThrow('field')
})
it('disposes idempotently while startup is pending and rejects later UI work', async () => {
  const f = await fixture()
  const pending = deferred<Awaited<ReturnType<typeof f.options.processor.resolve>>>()
  vi.mocked(f.options.processor.resolve).mockReturnValue(pending.promise)
  await f.service.api.process(f.scope, {
    model: f.model,
    policyEpoch: f.snapshot.policyEpoch,
  })
  const first = f.service.dispose(),
    second = f.service.dispose()
  expect(first).toBe(second)
  await first
  expect(f.embeds.dispose).toHaveBeenCalledTimes(1)
  await expect(f.service.api.status()).rejects.toThrow('disposed')
})

it('opens the injected store at the owned directory and exposes transport-neutral methods', async () => {
  const f = await adapterFixture()
  cleanup.push(f.cleanup)
  const service = await createBrainService(f.options)
  cleanup.push(() => service.dispose())
  expect(f.options.openStore).toHaveBeenCalledExactlyOnceWith(f.directory)
  expect(Object.keys(service.api).sort()).toEqual([
    'cancel',
    'correct',
    'download',
    'evidence',
    'forget',
    'graph',
    'learn',
    'learnPreview',
    'learningDetail',
    'learningJobs',
    'process',
    'read',
    'removeModel',
    'review',
    'search',
    'setPrefs',
    'status',
    'transcript',
  ])
  expect(service).not.toHaveProperty('ui')
  expect(f.options.sessions.create).not.toHaveBeenCalled()
  expect(f.embeds.download).not.toHaveBeenCalled()
})

it.each(['directory', 'workingExtension', 'processorExtension'] as const)(
  'rejects relative %s before opening the injected store',
  async (field) => {
    const f = await adapterFixture()
    cleanup.push(f.cleanup)
    const options = {
      ...f.options,
      resources: { ...f.options.resources },
    }
    if (field === 'directory') options.directory = 'relative'
    else options.resources[field] = 'relative'
    await expect(createBrainService(options)).rejects.toThrow(
      'Brain requires absolute owned resource paths',
    )
    expect(f.options.openStore).not.toHaveBeenCalled()
  },
)

it('closes the injected store if assembly fails before lifecycle initialization', async () => {
  const f = await adapterFixture()
  cleanup.push(f.cleanup)
  await writeFile(join(f.directory, 'sessions'), 'not a directory')
  const close = vi.spyOn(f.store, 'close')
  await expect(createBrainService(f.options)).rejects.toThrow('EEXIST')
  expect(f.options.openStore).toHaveBeenCalledExactlyOnceWith(f.directory)
  expect(close).toHaveBeenCalledOnce()
})

it('preserves initialization errors while diagnosing an injected store cleanup failure', async () => {
  const f = await adapterFixture()
  cleanup.push(f.cleanup)
  await writeFile(join(f.directory, 'sessions'), 'not a directory')
  const failure = new Error('Synthetic cleanup failure')
  vi.spyOn(f.store, 'close').mockRejectedValueOnce(failure)
  await expect(createBrainService(f.options)).rejects.toThrow('EEXIST')
  expect(f.options.onError).toHaveBeenCalledExactlyOnceWith(failure)
})

it('does not queue exclusion authority behind blocked learning source admission', async () => {
  const f = await adapterFixture()
  cleanup.push(f.cleanup)
  const source = join(f.scope, 'synthetic-source.jsonl')
  await writeFile(source, 'Synthetic source')
  const entered = deferred<void>()
  const release = deferred<void>()
  const service = await assembleBrainService(
    {
      ...f.options,
      learningHost: {
        prepare: async () => {
          entered.resolve()
          await release.promise
          throw new Error('Synthetic source admission released')
        },
      },
    },
    f.store,
  )
  cleanup.push(() => service.dispose())
  const preview = service.api.learnPreview({ workspacePath: f.scope, sessionPath: source })
  const previewSettled = preview.catch(() => {})
  await entered.promise
  const read = vi.spyOn(f.store, 'excludedSource')
  const exclusion = service.excludedSource('clean-source')
  try {
    // Drain microtasks, not a timing-based polling loop. The worker read must
    // be reachable before the path-taking preview is allowed to finish.
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(read).toHaveBeenCalledExactlyOnceWith('clean-source')
    await expect(exclusion).resolves.toBe(false)
  } finally {
    release.resolve()
    await Promise.allSettled([previewSettled, exclusion])
  }
})

it('refuses an exclusion result when disposal begins during the worker read', async () => {
  const f = await fixture()
  const result = deferred<boolean>()
  vi.spyOn(f.store, 'excludedSource').mockReturnValue(result.promise)
  const reading = f.service.excludedSource('clean-source')
  const refused = expect(reading).rejects.toThrow('disposed')
  const disposing = f.service.dispose()
  result.resolve(false)
  await refused
  await disposing
})

it('keeps the historical exclusion query internal to the service and rejects it after disposal', async () => {
  const f = await fixture()
  expect(Object.keys(f.service).sort()).toEqual(['api', 'dispose', 'excludedSource', 'memory'])
  expect(f.service.api).not.toHaveProperty('excludedSource')
  f.engine.recordDelivery({ sessionId: 'historical-recipient', evidenceIds: [], claimIds: [] })
  await f.service.api.setPrefs({ ...f.snapshot.prefs, enabled: false, recall: false })
  await expect(f.service.excludedSource('historical-recipient')).resolves.toBe(true)
  await expect(f.service.excludedSource('clean-source')).resolves.toBe(false)
  await f.service.dispose()
  await expect(f.service.excludedSource('historical-recipient')).rejects.toThrow('disposed')
})
