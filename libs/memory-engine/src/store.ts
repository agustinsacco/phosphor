import { randomUUID } from 'node:crypto'
import type { BrainSnapshot } from '@phosphor/shared/brain'
import { one, type Context } from './database'
import * as jobs from './jobs'
import * as knowledge from './knowledge'
import { prefs, revision, setPrefs } from './prefs'
import { proposal, propose } from './proposals'
import { review } from './review'
import { initialize } from './schema'
import { related, search } from './search'
import type { BrainStore, OpenStoreOptions } from './types'

function snapshot(ctx: Context): BrainSnapshot {
  return {
    prefs: prefs(ctx),
    revision: revision(ctx),
    jobs: jobs.jobs(ctx),
    counts: {
      memories: one<{ count: number }>(
        ctx,
        "SELECT COUNT(*) AS count FROM memories WHERE state='active'",
      )!.count,
      entities: one<{ count: number }>(
        ctx,
        `SELECT COUNT(*) AS count FROM entities e WHERE EXISTS
      (SELECT 1 FROM memories m WHERE m.state='active' AND (m.subject_id=e.id OR m.object_id=e.id))`,
      )!.count,
    },
  }
}
export function openBrainStore(options: OpenStoreOptions): BrainStore {
  const ctx: Context = {
    db: new options.Database(options.path),
    now: options.now ?? Date.now,
    id: options.id ?? randomUUID,
  }
  try {
    initialize(ctx)
  } catch (error) {
    ctx.db.close()
    throw error
  }
  return {
    snapshot: () => snapshot(ctx),
    setPrefs: (value) => setPrefs(ctx, value),
    enqueue: (value, state) => jobs.enqueue(ctx, value, state),
    job: (id) => jobs.job(ctx, id),
    updateJob: (id, patch) => jobs.updateJob(ctx, id, patch),
    removeJob: (id) => jobs.removeJob(ctx, id),
    requeueInterrupted: () => jobs.requeueInterrupted(ctx),
    propose: (extraction) => propose(ctx, extraction),
    proposal: (id) => proposal(ctx, id),
    review: (id, keep, expectedRevision) => review(ctx, id, keep, expectedRevision),
    knowledge: (limit) => knowledge.knowledge(ctx, limit),
    memory: (id) => knowledge.memory(ctx, id),
    forget: (id) => knowledge.forget(ctx, id),
    known: (session, scope, limit) => knowledge.known(ctx, session, scope, limit),
    search: (input) => search(ctx, input),
    related: (entity, limit, scope) => related(ctx, entity, limit, scope),
    recordDelivery: (session, ids) => knowledge.recordDelivery(ctx, session, ids),
    close: () => ctx.db.close(),
  }
}
