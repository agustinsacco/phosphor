import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { Proposal } from '@phosphor/memory-engine/types'
import { LaneFiles } from '../lane-files'
import { createCurator } from '../agent/curator'
import { recallOptions } from './options'
import { FakeAgentStore } from './fake-agent-store'
import { FakeBrainSearch, HARBOR_JOB } from './fake-store'

/** Gives the lane file a name now, as renaming a lane in Phosphor does. */
export async function nameLane(path: string, name: string, cwd = '/projects/ledger') {
  await writeFile(
    path,
    [
      { type: 'session', id: 'ledger', cwd },
      { type: 'session_info', name },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  )
}

/** A read waiting in review, with one memory and one uncertain identity. */
export function seedReview(store: FakeAgentStore, sessionId: string, sessionPath: string, at = 1) {
  const job = store.enqueue({ ...HARBOR_JOB, sessionId, sessionPath, title: sessionId }, 'queued')
  store.updateJob(job.id, { state: 'review', finishedAt: at })
  store.proposals.set(job.id, {
    jobId: job.id,
    computedRevision: store.knowledgeRevision(),
    entities: [
      {
        ref: 'e1',
        label: 'Rina',
        kind: 'person',
        decision: 'uncertain',
        candidates: [],
        reason: '',
      },
      { ref: 'e2', label: 'Ledger', kind: 'project', decision: 'new', candidates: [], reason: '' },
    ],
    memories: [
      {
        summary: 'Rina approves Ledger invoices.',
        type: 'procedure',
        action: 'add',
        entities: ['e1', 'e2'],
        target: null,
      },
    ],
    groups: [],
    confirmations: [],
    evidence: [],
    held: 0,
  } as unknown as Proposal)
  return store.job(job.id)!
}

export async function curatorFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'brain-curator-'))
  const lane = join(directory, 'ledger.jsonl')
  await writeFile(lane, JSON.stringify({ type: 'session', id: 'ledger', cwd: directory }))
  const store = new FakeAgentStore()
  store.prefs.enabled = true
  const search = new FakeBrainSearch()
  let running: { runId: string; signal: AbortSignal } | null = null
  const queue = {
    recompute: vi.fn(),
    refreshInline: vi.fn(),
    abortRefresh: vi.fn(),
    kick: vi.fn(),
    /** A run's turn only runs while Defrag holds the worker. */
    get defragActive() {
      return running !== null
    },
  }
  const changed = vi.fn()
  const options = { ...recallOptions(store), directory }
  const curator = createCurator({
    store,
    search,
    options,
    queue,
    files: new LaneFiles(),
    defrag: { turnRun: () => running },
    changed,
    enabled: () => store.prefs.enabled,
  })
  return {
    store,
    search,
    queue,
    curator,
    changed,
    options,
    lane,
    inRun: (runId: string) => {
      running = { runId, signal: new AbortController().signal }
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  }
}
