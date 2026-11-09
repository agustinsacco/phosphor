import { stat } from 'node:fs/promises'
import type { BrainJob } from '@phosphor/shared/brain'
import type { BrainStore, RawExtraction } from '@phosphor/memory-engine/types'
import type { BrainServiceOptions } from './types'
import { readLane, type LaneMeta } from './lane'
import { readEntries, transcriptSegments } from './transcript'
import { runFork } from './fork'
import { forkThinking } from './fork-trace'
import { ExtractionLog } from './extraction-log'
import { extractionPrompt } from './prompt'
import { parseExtraction } from './extraction'
import { verifyQuotes, type VerifiedQuotes } from './quotes'
import { scrubExcerpt } from './secrets'

interface ExtractionContext {
  job: BrainJob
  signal: AbortSignal
  store: BrainStore
  options: BrainServiceOptions
  log: ExtractionLog
}

export async function extractJob(
  job: BrainJob,
  signal: AbortSignal,
  store: BrainStore,
  options: BrainServiceOptions,
): Promise<void> {
  const log = new ExtractionLog(job, options)
  try {
    signal.throwIfAborted()
    await runExtraction({ job, signal, store, options, log })
  } catch (error) {
    throw log.failed(error, signal)
  }
}

async function runExtraction(context: ExtractionContext): Promise<void> {
  const { job, signal, store, options, log } = context
  log.laneBytes = (await stat(job.sessionPath)).size
  const lane = await readLane(job.sessionPath)
  log.model = lane.model
  log.thinking = forkThinking(lane.thinking)
  log.step('Brain extraction started')
  signal.throwIfAborted()
  store.updateJob(job.id, { leafId: lane.leafId, model: lane.model, branch: lane.branch })
  options.onChange?.()
  const known = store.known(lane.sessionId, job.scope, 120)
  log.phase = 'launch'
  const launch = await options.lanes.launch(job.sessionPath)
  log.phase = 'fork'
  const fork = await runFork({
    directory: options.directory,
    job,
    lane,
    launch,
    guardExtension: options.guardExtension,
    prompt: extractionPrompt(known),
    signal,
    onTrace: (trace, diagnostic) => {
      log.trace = trace
      log.diagnostic = diagnostic
      log.step('Brain extraction fork finished')
    },
  })
  signal.throwIfAborted()
  store.updateJob(job.id, { usage: fork.usage })
  log.phase = 'parse'
  const raw = parseExtraction(fork.text, { existingEntities: known.entities })
  log.step('Brain extraction parsed', {
    entities: raw.entities.length,
    memories: raw.memories.length,
  })
  log.phase = 'quote'
  const segments = transcriptSegments(await readEntries(job.sessionPath))
  const verified = verifyQuotes(raw, segments)
  log.step('Brain extraction quotes verified', {
    verified: verified.memories.length,
    dropped: verified.dropped.length,
  })
  signal.throwIfAborted()
  log.phase = 'embed'
  const vectors = await options.embeddings.embed(
    verified.memories.map((m) => m.summary),
    'document',
    signal,
  )
  log.step('Brain extraction embedded', { vectors: vectors.length })
  signal.throwIfAborted()
  // Cancel removes the job; a late provider reply must never recreate it.
  if (!store.job(job.id)) throw new Error('Knowledge extraction job removed.')
  propose(context, lane, raw, verified, vectors)
}

function propose(
  { job, store, options, log }: ExtractionContext,
  lane: LaneMeta,
  raw: RawExtraction,
  verified: VerifiedQuotes,
  vectors: number[][],
): void {
  log.phase = 'propose'
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
  log.step('Brain extraction proposed', result)
  store.updateJob(job.id, { finishedAt: (options.now ?? Date.now)() })
  log.phase = 'review'
  if (result.kept && !store.snapshot().prefs.review)
    store.review(
      job.id,
      Array.from({ length: result.kept }, (_, i) => i),
      store.snapshot().revision,
    )
  log.step('Brain extraction finished', {
    forkMs: log.trace?.totalMs ?? null,
    kept: result.kept,
    duplicates: result.duplicates,
    dropped: verified.dropped.length,
  })
}
