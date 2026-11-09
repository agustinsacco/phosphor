import type { BrainJob } from '@phosphor/shared/brain'
import type { BrainStore } from '@phosphor/memory-engine/types'
import type { BrainServiceOptions } from './types'
import { readLane } from './lane'
import { readEntries, transcriptSegments } from './transcript'
import { runFork } from './fork'
import { extractionPrompt } from './prompt'
import { parseExtraction } from './extraction'
import { verifyQuotes } from './quotes'
import { scrubExcerpt } from './secrets'

export async function extractJob(
  job: BrainJob,
  signal: AbortSignal,
  store: BrainStore,
  options: BrainServiceOptions,
): Promise<void> {
  const now = options.now ?? Date.now
  const started = now()
  const lane = await readLane(job.sessionPath)
  signal.throwIfAborted()
  store.updateJob(job.id, { leafId: lane.leafId, model: lane.model, branch: lane.branch })
  options.onChange?.()
  const known = store.known(lane.sessionId, job.scope, 120)
  const launch = await options.lanes.launch(job.sessionPath)
  const fork = await runFork({
    directory: options.directory,
    job,
    lane,
    launch,
    guardExtension: options.guardExtension,
    prompt: extractionPrompt(known),
    signal,
  })
  const forkFinished = now()
  signal.throwIfAborted()
  store.updateJob(job.id, { usage: fork.usage })
  const raw = parseExtraction(fork.text, { existingEntities: known.entities })
  const segments = transcriptSegments(await readEntries(job.sessionPath))
  const verified = verifyQuotes(raw, segments)
  signal.throwIfAborted()
  const vectors = await options.embeddings.embed(
    verified.memories.map((m) => m.summary),
    'document',
    signal,
  )
  signal.throwIfAborted()
  // Cancel removes the job; a late provider reply must never recreate it.
  if (!store.job(job.id)) return
  const result = store.propose({
    jobId: job.id,
    summary: scrubExcerpt(raw.summary),
    origin: { sessionId: lane.sessionId, title: job.title },
    scope: job.scope,
    branch: lane.branch,
    entities: raw.entities,
    memories: verified.memories,
    evidence: verified.evidence,
    vectors: vectors.map((v) => new Float32Array(v)),
  })
  store.updateJob(job.id, { finishedAt: now() })
  if (result.kept && !store.snapshot().prefs.review)
    store.review(
      job.id,
      Array.from({ length: result.kept }, (_, i) => i),
      store.snapshot().revision,
    )
  options.log?.('Brain extraction finished', {
    jobId: job.id,
    forkMs: forkFinished - started,
    totalMs: now() - started,
    kept: result.kept,
    duplicates: result.duplicates,
    dropped: verified.dropped.length,
  })
}
