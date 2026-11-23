import { DEFAULT_BRAIN_PREFS } from '@phosphor/shared/brain'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, vi } from 'vitest'
import { openBrainStore } from '@phosphor/memory-engine/store'
import { openBrainSearch } from '@phosphor/memory-engine/search'
import type { BrainStore, Proposal } from '@phosphor/memory-engine/types'
import type { BrainService, BrainServiceOptions, BrainSearchPort } from '../../types'
import type { ModelCallInput, ModelCallResult } from '../../model-call'
import { createBrainService } from '../../service'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** Promise adapter only: all search and mutation logic uses real SQLite connections. */
function searchPort(path: string): BrainSearchPort {
  const search = openBrainSearch({ path, Database: DatabaseSync })
  return {
    refresh: () => search.refresh(),
    ready: async () => search.ready(),
    entities: async (...args) => search.entities(...args),
    recent: async (...args) => search.recent(...args),
    nearestEntities: async (...args) => search.nearestEntities(...args),
    nearestMemories: async (...args) => search.nearestMemories(...args),
    recall: async (...args) => search.recall(...args),
    find: async (...args) => search.find(...args),
    close: async () => search.close(),
  }
}

export async function realService(overrides: Partial<BrainServiceOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'brain-tidy-integration-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const store = openBrainStore({ path: join(directory, 'brain.sqlite'), Database: DatabaseSync })
  store.setPrefs({
    enabled: true,
    recall: true,
    review: true,
    model: 'example/reader',
    neverRead: DEFAULT_BRAIN_PREFS.neverRead,
  })
  // Nothing here reads a lane: a model call would be a bug.
  const call = vi.fn(async (_input: ModelCallInput): Promise<ModelCallResult> => {
    throw new Error('No model call is expected')
  })
  const options: BrainServiceOptions = {
    directory,
    openStore: () => store,
    openSearch: searchPort,
    runModelCall: call,
    embeddings: {
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
      dispose() {},
      embed: async (texts) => texts.map(() => [1, ...Array<number>(767).fill(0)]),
    },
    lanes: {
      busy: () => false,
      launch: async () => ({ binaryPath: '/not-a-provider', prefixArgs: [], env: {} }),
    },
    guardExtension: '/made-up/guard.mjs',
    recall: { extension: '/made-up/brain.mjs', skill: '/made-up/brain' },
    ...overrides,
  }
  const service = await createBrainService(options)
  cleanups.push(() => service.dispose())
  return { directory, store, service, options, call }
}

const SUMMARIES = [
  'Rina leads Ledger.',
  'Rina leads Ledger.',
  'Rina manages Kestrel.',
  'Ledger bills weekly.',
  'Ledger bills monthly.',
]

/** A finished reader proposal; review and its post-commit sweep are never mocked. */
export async function approveRead(
  store: BrainStore,
  service: BrainService,
  options: BrainServiceOptions,
  summaries = SUMMARIES,
) {
  const job = await proposeRead(store, options, summaries)
  store.review(
    job.id,
    {
      memories: summaries.map((_, i) => i),
      identities: {},
      groups: [],
      descriptions: [],
      confirmations: [],
    },
    store.knowledgeRevision(),
  )
  // Wake the service after seeding through the real store; no manual-review API remains.
  await service.api.setPrefs(store.snapshot().prefs)
  return service.api.status()
}

/** A read waiting in review with one proposed memory per summary. */
export async function proposeRead(
  store: BrainStore,
  options: BrainServiceOptions,
  summaries = SUMMARIES,
) {
  const lane = { sessionPath: join(options.directory, 'harbor.jsonl'), title: 'Harbor planning' }
  // A waiting read's lane exists: Brain checks it, as it is now, before every decision.
  await writeFile(
    lane.sessionPath,
    [
      { type: 'session', id: 'harbor-read', cwd: '/Harbor' },
      { type: 'session_info', name: lane.title },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  )
  const job = store.enqueue(
    {
      sessionId: 'harbor-read',
      ...lane,
      scope: '/Harbor',
      branch: null,
      model: 'example/reader',
      leafId: 'leaf-1',
    },
    'queued',
  )
  const entities: Proposal['entities'] = ['Rina', 'Rina Okafor'].map((label, i) => ({
    ref: `r${i}`,
    label,
    kind: 'person',
    aliases: [],
    description: 'Ledger lead',
    keys: [],
    decision: 'new',
    entityId: null,
    candidates: [],
    reason: '',
    auto: false,
  }))
  const memoryVectors = (await options.embeddings.embed(summaries, 'document')).map(
    (v) => new Float32Array(v),
  )
  const entityVectors = (
    await options.embeddings.embed(
      entities.map((e) => e.label),
      'document',
    )
  ).map((v) => new Float32Array(v))
  store.propose({
    jobId: job.id,
    origin: { sessionId: job.sessionId, title: job.title },
    scope: job.scope,
    branch: null,
    computedRevision: store.knowledgeRevision(),
    entities,
    memoryVectors,
    entityVectors,
    groups: [],
    confirmations: [],
    held: 0,
    memories: summaries.map((summary, i) => ({
      summary,
      kind: 'reported',
      type: 'fact',
      entities: [i === 2 ? 'r1' : 'r0'],
      links: [],
      branch: false,
      validFrom: null,
      validTo: null,
      action: 'add',
      target: null,
      reason: '',
      citations: [{ evidence: i, quote: summary }],
    })),
    evidence: evidence(summaries, job.sessionId),
  })
  return store.job(job.id)!
}

function evidence(summaries: string[], sessionId: string): Proposal['evidence'] {
  return summaries.map((text, i) => ({
    sessionId,
    entryId: `entry-${i}`,
    role: 'user',
    label: 'Harbor planning',
    observedAt: i + 1,
    text,
  }))
}
