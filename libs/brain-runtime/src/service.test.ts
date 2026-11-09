import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createBrainService } from './service'
import { runFork } from './fork'
import { FakeBrainStore, HARBOR_JOB } from './__fixtures__/fake-store'
import { LANE_ENTRIES, RAW_EXTRACTION } from './__fixtures__/lane'
import { recallOptions } from './__fixtures__/options'
import type { BrainService } from './types'

vi.mock('./fork', () => ({ runFork: vi.fn() }))
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.clearAllMocks()
})

async function setup(enabled = true) {
  const directory = await mkdtemp(join(tmpdir(), 'harbor-service-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const store = new FakeBrainStore()
  store.prefs.enabled = enabled
  const options = {
    ...recallOptions(store),
    directory,
    onChange: vi.fn(),
    log: vi.fn(),
    now: () => 1234,
  }
  const file = join(directory, 'harbor.jsonl')
  const entries = LANE_ENTRIES.map((entry) =>
    entry.type === 'session' ? { ...entry, cwd: directory } : entry,
  )
  await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join('\n'))
  vi.mocked(runFork).mockResolvedValue({
    text: JSON.stringify(RAW_EXTRACTION),
    usage: { tokens: 90, cost: 0.001 },
  })
  const openStore = vi.fn(() => store)
  const service = await createBrainService({ ...options, openStore })
  cleanups.push(() => service.dispose())
  return { directory, store, options, service, file, entries, openStore }
}
async function reviewed(service: BrainService): Promise<void> {
  await vi.waitFor(async () => expect((await service.api.status()).jobs[0]?.state).toBe('review'))
}

it('opens the injected store, composes status and saves preferences before asynchronous model setup', async () => {
  const s = await setup(false)
  expect(s.openStore).toHaveBeenCalledWith(join(s.directory, 'brain.sqlite'))
  expect(await s.service.api.status()).toMatchObject({
    supported: true,
    prefs: { enabled: false },
    counts: { memories: 0, entities: 0 },
  })
  let finish!: () => void
  const setEnabled = vi.spyOn(s.options.embeddings, 'setEnabled').mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const status = await s.service.api.setPrefs({ enabled: true, recall: false, review: false })
  expect(status.prefs).toEqual({ enabled: true, recall: false, review: false })
  expect(setEnabled).toHaveBeenCalledWith(true)
  expect(s.options.onChange).toHaveBeenCalled()
  finish()
  await s.service.dispose()
})

it('extracts, verifies, embeds and proposes with usage and the lane model, then approves a review', async () => {
  const s = await setup()
  await s.service.api.queue({ sessionPath: s.file, title: 'Harbor billing' })
  await reviewed(s.service)
  const job = s.store.snapshot().jobs[0]!
  expect(job).toMatchObject({
    model: 'example/fast',
    startedAt: 1234,
    finishedAt: 1234,
    leafId: 'custom',
    usage: { tokens: 90, cost: 0.001 },
  })
  expect(s.options.embeddings.embed).toHaveBeenCalledWith(
    ['Rina Okafor owns Harbor billing.'],
    'document',
    expect.any(AbortSignal),
  )
  const extraction = s.store.proposals.get(job.id)!
  expect(extraction.memories[0]!.citations).toEqual([
    { evidence: 0, quote: 'Rina Okafor owns Harbor billing.' },
  ])
  expect(extraction.vectors[0]).toBeInstanceOf(Float32Array)
  expect(await s.service.api.proposal(job.id)).toMatchObject({
    summary: RAW_EXTRACTION.summary,
    revision: 0,
  })
  expect(vi.mocked(runFork).mock.calls[0]![0].prompt).toContain('<knowledge_extraction>')
  expect((await s.service.api.review(job.id, [0], 0)).jobs).toEqual([])
})

it('auto-approves when review is off and leaves an empty result in the inbox', async () => {
  const s = await setup()
  s.store.prefs.review = false
  await s.service.api.queue({ sessionPath: s.file, title: 'Harbor billing' })
  await vi.waitFor(() => expect(s.store.jobs[0]!.state).toBe('done'))
  expect(s.store.jobs[0]!.memories).toBe(1)
  vi.mocked(runFork).mockResolvedValue({
    text: JSON.stringify({ ...RAW_EXTRACTION, memories: [] }),
    usage: { tokens: 1, cost: 0 },
  })
  const next = join(s.directory, 'tom.jsonl')
  await writeFile(
    next,
    s.entries
      .map((e) => JSON.stringify(e.type === 'session' ? { ...e, id: 'tom-lane' } : e))
      .join('\n'),
  )
  await s.service.api.queue({ sessionPath: next, title: 'Tom Lee review' })
  await vi.waitFor(() => expect(s.store.jobs[1]!.state).toBe('empty'))
})

it('waits while busy, refreshes the model and leaf at start, and requeues interrupted runs', async () => {
  const s = await setup()
  const busy = vi.spyOn(s.options.lanes, 'busy').mockReturnValue(true)
  await s.service.api.queue({ sessionPath: s.file, title: 'Harbor billing' })
  expect(s.store.jobs[0]!.state).toBe('waiting')
  await writeFile(
    s.file,
    [...s.entries, { type: 'model_change', id: 'fresh-leaf', provider: 'other', modelId: 'quick' }]
      .map((e) => JSON.stringify(e))
      .join('\n'),
  )
  busy.mockReturnValue(false)
  // An enqueue/finish also checks waiting lanes; a mutation kicks the same queue.
  await s.service.api.setPrefs(s.store.prefs)
  await reviewed(s.service)
  expect(s.store.jobs[0]).toMatchObject({ leafId: 'fresh-leaf', model: 'other/quick' })
  const interrupted = s.store.enqueue({ ...HARBOR_JOB, sessionId: 'interrupted' }, 'queued')
  s.store.updateJob(interrupted.id, { state: 'running' })
  await s.service.dispose()
  expect(s.store.closed).toBe(true)
})

it('supports download retry, model removal only while off, read APIs and forget', async () => {
  const s = await setup(false)
  const download = vi.spyOn(s.options.embeddings, 'download')
  const remove = vi.spyOn(s.options.embeddings, 'remove')
  await s.service.api.download()
  expect(download).toHaveBeenCalledWith()
  await s.service.api.removeModel()
  expect(remove).toHaveBeenCalled()
  expect(await s.service.api.knowledge()).toEqual({ memories: [], entities: [], truncated: false })
  await s.service.api.forget('absent')
  expect(s.store.revision).toBe(1)
  await s.service.api.setPrefs({ ...s.store.prefs, enabled: true })
  await expect(s.service.api.removeModel()).rejects.toThrow('Turn off Brain')
})

it('restores interrupted jobs on startup but does not run them while Brain is disabled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harbor-restart-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const store = new FakeBrainStore()
  const job = store.enqueue(HARBOR_JOB, 'queued')
  store.updateJob(job.id, { state: 'running' })
  const service = await createBrainService({ ...recallOptions(store), directory })
  cleanups.push(() => service.dispose())
  expect((await service.api.status()).jobs[0]!.state).toBe('queued')
  expect(runFork).not.toHaveBeenCalled()
})

it('keeps fork usage when later parsing fails, and dismisses the failed job', async () => {
  const s = await setup()
  vi.mocked(runFork).mockResolvedValue({
    text: 'No JSON here.',
    usage: { tokens: 12, cost: 0.002 },
  })
  await s.service.api.queue({ sessionPath: s.file, title: 'Harbor billing' })
  await vi.waitFor(() => expect(s.store.jobs[0]!.state).toBe('failed'))
  expect(s.store.jobs[0]).toMatchObject({
    finishedAt: 1234,
    usage: { tokens: 12, cost: 0.002 },
    error: 'The extraction returned no JSON.',
  })
  expect((await s.service.api.cancel(s.store.jobs[0]!.id)).jobs).toEqual([])
})

it('removes the prototype files it cannot read on startup and keeps the model', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harbor-legacy-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const legacy = ['evidence', 'learning', 'sessions', 'memory.sqlite', 'memory.sqlite-wal']
  for (const name of legacy.slice(0, 3))
    await mkdir(join(directory, name, 'harbor'), { recursive: true })
  for (const name of legacy.slice(3)) await writeFile(join(directory, name), 'prototype')
  await mkdir(join(directory, 'embeddings'))
  const store = new FakeBrainStore()
  const service = await createBrainService({
    ...recallOptions(store),
    directory,
    openStore: () => store,
  })
  cleanups.push(() => service.dispose())
  for (const name of legacy) expect(await stat(join(directory, name)).catch(() => null)).toBeNull()
  expect(await stat(join(directory, 'embeddings'))).toBeTruthy()
})

it('logs one phased failure with lane metadata when parsing fails, without logging the answer', async () => {
  const s = await setup()
  vi.mocked(runFork).mockResolvedValue({
    text: 'private Harbor answer', usage: { tokens: 12, cost: 0.002 },
  })
  await s.service.api.queue({ sessionPath: s.file, title: 'Harbor billing' })
  await vi.waitFor(() => expect(s.store.jobs[0]!.state).toBe('failed'))
  const failures = s.options.log.mock.calls.filter(([message]) => message === 'Brain extraction failed')
  expect(failures).toEqual([['Brain extraction failed', expect.objectContaining({
    jobId: s.store.jobs[0]!.id, model: 'example/fast', thinking: 'low',
    laneBytes: (await stat(s.file)).size, phase: 'parse', error: 'The extraction returned no JSON.',
  })]])
  expect(JSON.stringify(s.options.log.mock.calls)).not.toContain('private Harbor answer')
})
