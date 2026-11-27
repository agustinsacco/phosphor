import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { answerFor } from '@phosphor/brain-runtime/__fixtures__/pipeline'
import { LANE_ENTRIES } from '@phosphor/brain-runtime/__fixtures__/lane'
import type { BrainEmbeddings } from '@phosphor/brain-runtime/embedding/embedding-port'
import type { ModelCallInput } from '@phosphor/brain-runtime/model-call'
import { inProcessSearch } from '@phosphor/brain-runtime/search/in-process'
import { openBrainSearch } from '@phosphor/memory-engine/search'
import { createHostLaneRecall } from './lane-recall'
import { createHostBrain, type HostBrainOptions } from './runtime'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A ready model that never loads: every text gets the same unit vector. */
function readyEmbeddings(): BrainEmbeddings {
  return {
    status: () => ({
      phase: 'ready',
      receivedBytes: 0,
      totalBytes: 0,
      modelId: 'fake',
      dimensions: 768,
    }),
    setEnabled: async () => {},
    download: async () => {},
    remove: async () => {},
    embed: async (texts) => texts.map(() => [1, ...Array<number>(767).fill(0)]),
    dispose() {},
  }
}

async function host(overrides: Partial<HostBrainOptions> = {}) {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'harbor-host-brain-'))
  cleanups.push(() => rm(stateDirectory, { recursive: true, force: true }))
  // The stub reader: tests never launch a provider.
  const reader = vi.fn(async (input: ModelCallInput) => ({
    text: answerFor(input),
    usage: { tokens: 10, cost: 0 },
  }))
  const launch = vi.fn(async () => ({ binaryPath: '/not-a-provider', prefixArgs: [], env: {} }))
  const options = (): HostBrainOptions => ({
    stateDirectory,
    resourceRoot: '/res',
    lanes: { busy: () => false, launch },
    embeddings: () => readyEmbeddings(),
    openSearch: inProcessSearch((path) => openBrainSearch({ path, Database: DatabaseSync })),
    runModelCall: reader,
    log: vi.fn(),
    ...overrides,
  })
  const start = () => {
    const brain = createHostBrain(options())
    cleanups.push(() => brain.dispose())
    return brain
  }
  return { stateDirectory, reader, start }
}

async function laneFile(folder: string) {
  const file = join(folder, 'harbor.jsonl')
  const entries = LANE_ENTRIES.map((e) => (e.type === 'session' ? { ...e, cwd: folder } : e))
  await writeFile(file, entries.map((e) => JSON.stringify(e)).join('\n'))
  return file
}

it('leaves a fresh Host off: no store, no workers, no recall until the owner enables it', async () => {
  const embeddings = vi.fn(readyEmbeddings)
  const openSearch = vi.fn()
  const h = await host({ embeddings, openSearch })
  const brain = h.start()
  expect(brain.directory).toBe(join(h.stateDirectory, 'brain'))
  expect(brain.state()).toBe('off')
  expect(brain.active()).toBe(false)
  expect(await brain.service()).toBeUndefined()
  const recall = createHostLaneRecall(brain, vi.fn())
  expect(await recall.resources('/repo')).toBeUndefined()
  expect(existsSync(brain.directory)).toBe(false)
  expect(embeddings).not.toHaveBeenCalled()
  expect(openSearch).not.toHaveBeenCalled()
})

it('refuses to open or create the store while the move guard owns it, and resumes once released', async () => {
  let owned = false
  const h = await host({ migrationGuard: { owned: () => owned } })
  const brain = h.start()
  await expect(brain.enable()).rejects.toThrow('Brain is moving to this Host.')
  expect(existsSync(brain.directory)).toBe(false)
  owned = true
  const service = await brain.enable()
  expect((await service.api.status()).prefs.enabled).toBe(true)
  owned = false
  expect(brain.state()).toBe('refused')
  expect(brain.active()).toBe(false)
  expect(await brain.service()).toBeUndefined()
  // A handler holding the service from before is refused too, and recall launches nothing.
  await expect(service.api.status()).rejects.toThrow('Brain is moving to this Host.')
  expect(await service.recallLaunch()).toBeUndefined()
})

it('refuses a second Brain on the same Host folder while the first is open', async () => {
  const h = await host()
  const first = h.start()
  await first.enable()
  const second = h.start()
  expect(second.state()).toBe('refused')
  await expect(second.enable()).rejects.toThrow('Brain is open elsewhere on this Host.')
  await first.dispose()
  expect(first.state()).toBe('closed')
  await expect(first.enable()).rejects.toThrow('Brain is shutting down.')
  expect(second.state()).toBe('idle')
})

it('reads a Host lane, recalls it in an ordinary lane, survives a restart and undoes the read', async () => {
  const h = await host()
  const brain = h.start()
  const service = await brain.enable()
  expect(brain.state()).toBe('ready')
  const file = await laneFile(h.stateDirectory)
  const queued = await service.api.queue({ sessionPath: file, title: 'Harbor billing' })
  const jobId = queued.jobs[0]!.id
  // The status snapshot lists open jobs; a finished read is the lane's latest read.
  await vi.waitFor(async () =>
    expect((await service.api.laneRead('harbor-lane'))?.job).toMatchObject({
      id: jobId,
      state: 'done',
    }),
  )
  expect(h.reader).toHaveBeenCalled()
  const recall = createHostLaneRecall(brain, vi.fn())
  expect(recall.active()).toBe(true)
  expect(await recall.resources('/repo')).toEqual({
    extensions: ['/res/brain-ext/brain.mjs'],
    skills: ['/res/skills/brain'],
  })
  // The Brain lane never gets recall.
  expect(await recall.resources(brain.laneFolder)).toBeUndefined()
  recall.attachLane('lane-handle', h.stateDirectory, () => 'tom-lee-pi')
  const port = await recall.forLane('lane-handle', 'Northwind')
  expect(await port!.search({ query: 'Harbor billing' })).toMatchObject({
    data: { status: 'ok', memories: expect.any(Number) },
  })
  const saved = (await service.api.status()).counts.memories
  expect(saved).toBeGreaterThan(0)

  await brain.dispose()
  await expect(port!.search({ query: 'Harbor' })).rejects.toThrow('Brain is shutting down.')
  const restarted = h.start()
  expect(restarted.state()).toBe('idle')
  expect(restarted.active()).toBe(true)
  const reopened = (await restarted.service())!
  const status = await reopened.api.status()
  expect(status.prefs.enabled).toBe(true)
  expect(status.counts.memories).toBe(saved)
  const read = (await reopened.api.tidyChanges(50)).items.find(
    (item) => item.kind === 'read' && item.jobId === jobId,
  )
  expect(read).toMatchObject({ undoable: true })
  const undone = await reopened.api.tidyUndo(read!.id, status.revision)
  expect(undone.counts.memories).toBe(0)
  const readsAfter = h.reader.mock.calls.length
  await restarted.dispose()
  // The restart resent no reader call for the saved read.
  expect(h.reader.mock.calls.length).toBe(readsAfter)
}, 60_000)
