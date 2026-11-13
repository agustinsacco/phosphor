import { randomUUID } from 'node:crypto'
import type { BrainSnapshot } from '@phosphor/shared/brain'
import { all, type Context } from './database'
import { extraction, saveExtraction, pruneExtractions } from './extractions'
import * as jobs from './jobs'
import * as candidates from './candidates'
import * as explorer from './explorer'
import * as graph from './graph'
import { memory } from './knowledge'
import { merge, forget } from './merge'
import { prefs, revision, setPrefs } from './prefs'
import { proposal, propose, storedProposal } from './proposals'
import { review } from './review'
import { initialize, reset } from './schema'
import type { BrainStore, OpenStoreOptions } from './types'

export { BRAIN_EXTRACTOR_VERSION } from './jobs'

function snapshot(ctx: Context): BrainSnapshot {
  const meta = Object.fromEntries(
    all<{ key: string; value: string }>(ctx, 'SELECT key,value FROM meta').map((row) => [
      row.key,
      row.value,
    ]),
  )
  return {
    prefs: prefs(ctx),
    revision: Number(meta.revision),
    generation: meta.generation!,
    jobs: jobs.jobs(ctx),
    counts: { memories: Number(meta.memories), entities: Number(meta.entities) },
  }
}
export function openBrainStore(options: OpenStoreOptions): BrainStore {
  const ctx: Context = {
    db: new options.Database(options.path, { timeout: 2000 }),
    now: options.now ?? Date.now,
    id: options.id ?? randomUUID,
  }
  try {
    initialize(ctx)
    pruneExtractions(ctx)
  } catch (error) {
    ctx.db.close()
    throw error
  }
  return {
    snapshot: () => snapshot(ctx),
    setPrefs: (value) => setPrefs(ctx, value),
    revision: () => revision(ctx),
    enqueue: (value, state) => jobs.enqueue(ctx, value, state),
    job: (id) => jobs.job(ctx, id),
    updateJob: (id, patch) => jobs.updateJob(ctx, id, patch),
    retry: (id) => jobs.retry(ctx, id),
    removeJob: (id) => jobs.removeJob(ctx, id),
    requeueInterrupted: () => jobs.requeueInterrupted(ctx),
    part: (id, name, hash) => jobs.part(ctx, id, name, hash),
    savePart: (id, part) => jobs.savePart(ctx, id, part),
    extraction: (id) => extraction(ctx, id),
    saveExtraction: (record) => saveExtraction(ctx, record),
    entityMatches: (probes, limit) => candidates.entityMatches(ctx, probes, limit),
    entityCards: (ids) => candidates.entityCards(ctx, ids),
    neighbours: (ids, kinds, limit) => candidates.neighbours(ctx, ids, kinds, limit),
    memoryMatches: (probes, limit) => candidates.memoryMatches(ctx, probes, limit),
    memoryCards: (ids) => candidates.memoryCards(ctx, ids),
    propose: (value) => propose(ctx, value),
    proposal: (id) => proposal(ctx, id),
    storedProposal: (id) => storedProposal(ctx, id),
    review: (id, decision, expected) => review(ctx, id, decision, expected),
    overview: (limit) => graph.overview(ctx, limit),
    neighbourhood: (id, hops, limit) => graph.neighbourhood(ctx, id, hops, limit),
    path: (from, to) => graph.path(ctx, from, to),
    entity: (id) => explorer.entity(ctx, id),
    connections: (id, predicate, direction, cursor) =>
      explorer.connections(ctx, id, predicate, direction, cursor),
    entityMemories: (id, filter, cursor) => explorer.entityMemories(ctx, id, filter, cursor),
    memory: (id) => memory(ctx, id),
    merge: (source, target) => merge(ctx, source, target),
    forget: (id) => forget(ctx, id),
    reset: () => reset(ctx),
    close: () => ctx.db.close(),
  }
}
