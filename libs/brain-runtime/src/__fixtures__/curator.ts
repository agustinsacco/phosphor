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

/** A read waiting in review, with one memory and one uncertain identity. */
export function seedReview(store: FakeAgentStore, sessionId: string, sessionPath: string, at = 1) {
  const job = store.enqueue({ ...HARBOR_JOB, sessionId, sessionPath, title: sessionId }, 'queued')
  store.updateJob(job.id, { state: 'review', finishedAt: at })
  store.proposals.set(job.id, {
    jobId: job.id,
    computedRevision: store.knowledgeRevision(),
    entities: [
      { ref: 'e1', label: 'Rina', decision: 'uncertain', candidates: [] },
      { ref: 'e2', label: 'Ledger', decision: 'new', candidates: [] },
    ],
    memories: [{ summary: 'Rina approves Ledger invoices.', target: null }],
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
  const queue = { recompute: vi.fn(), refreshInline: vi.fn(), abortRefresh: vi.fn(), kick: vi.fn() }
  let running: { runId: string; signal: AbortSignal } | null = null
  const changed = vi.fn()
  const options = { ...recallOptions(store), directory }
  const curator = createCurator({
    store,
    search,
    options,
    queue,
    files: new LaneFiles(),
    defrag: { current: () => running },
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
