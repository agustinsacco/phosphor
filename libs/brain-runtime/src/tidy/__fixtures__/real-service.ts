import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, vi } from 'vitest'
import { openBrainStore } from '@phosphor/memory-engine/store'
import { openBrainSearch } from '@phosphor/memory-engine/search'
import type { BrainStore, Proposal } from '@phosphor/memory-engine/types'
import type { BrainService, BrainServiceOptions, BrainSearchPort } from '../../types'
import type { ModelCallInput } from '../../model-call'
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

export async function realService() {
  const directory = await mkdtemp(join(tmpdir(), 'brain-tidy-integration-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const store = openBrainStore({ path: join(directory, 'brain.sqlite'), Database: DatabaseSync })
  store.setPrefs({ enabled: true, recall: true, review: true, model: 'example/reader' })
  const call = vi.fn(async (input: ModelCallInput) => {
    if (input.stage !== 'tidy') throw new Error('Only fake Tidy calls are expected')
    const pairs = JSON.parse(input.prompt.split('authority="none">\n')[1]!.split('\n</')[0]!) as {
      ref: string
      a: { type: string; sentence?: string }
      b: { sentence?: string }
    }[]
    return {
      text: JSON.stringify({
        decisions: pairs.map(({ ref, a, b }) => ({
          ref,
          verdict:
            a.type === 'entity'
              ? 'same'
              : [a.sentence, b.sentence].every((s) => s?.startsWith('Ledger bills'))
                ? 'conflict'
                : 'different',
          reason:
            a.type === 'entity'
              ? 'Both describe the Ledger lead.'
              : 'The supplied assertions differ.',
        })),
      }),
      usage: { tokens: 0, cost: 0 },
    }
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
  const job = store.enqueue(
    {
      sessionId: 'harbor-read',
      sessionPath: join(options.directory, 'harbor.jsonl'),
      title: 'Harbor planning',
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
    computedRevision: store.revision(),
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
  return service.api.review(
    job.id,
    { memories: summaries.map((_, i) => i), identities: {}, groups: [] },
    store.revision(),
  )
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
