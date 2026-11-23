import { unlink } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BRAIN_ERASE_LIMIT_REFUSAL } from '@phosphor/shared/brain-agent'
import { BRAIN_REVIEW_CHANGED } from '@phosphor/shared/brain-review'
import { curatorFixture, nameLane, seedReview } from '../__fixtures__/curator'
import { DELETED_LANE_REFRESH_REFUSAL } from '../lane-read-rules'
import { BRAIN_OFF } from './curator-context'
import { READ_CHANGED } from './curator-writes'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
const signal = new AbortController().signal
const reason = 'Both records name the same Slack user.'
/** Brain Agent's approval: the read's one memory by default, its identity answered. */
const approval = { approve: true, identities: [{ ref: 'e1', answer: 'rina' }] }
/** The decision Brain builds from it against the stored read. */
const approved = {
  memories: [0],
  identities: { e1: 'rina' },
  groups: [],
  descriptions: [],
  confirmations: [],
}
async function setup() {
  const s = await curatorFixture()
  cleanups.push(s.cleanup)
  return s
}

describe('decideRead', () => {
  it('rejects without a refresh, whatever the revision, journaled with the run and reason', async () => {
    const s = await setup()
    const job = seedReview(s.store, 'ledger', s.lane)
    s.store.rev += 3
    s.inRun('run-4')
    const result = await s.curator.decideRead(
      { jobId: job.id, revision: 0, approve: false, reason },
      signal,
    )
    expect(result).toEqual({
      status: 'done',
      message: 'Rejected. Undo puts the read back to waiting.',
      operationId: 'op-1',
    })
    expect(s.store.calls).toEqual([
      { method: 'decideRead', args: [job.id, null, 0], note: { runId: 'run-4', reason } },
    ])
    expect(s.queue.abortRefresh).toHaveBeenCalledWith(job.id)
    expect(s.queue.refreshInline).not.toHaveBeenCalled()
    expect(s.search.refreshes).toBe(1)
    expect(s.changed).toHaveBeenCalled()
    expect(s.queue.kick).toHaveBeenCalled()
  })

  it('approves the current revision, outside a run with no run id', async () => {
    const s = await setup()
    const job = seedReview(s.store, 'ledger', s.lane)
    const result = await s.curator.decideRead(
      { jobId: job.id, revision: s.store.knowledgeRevision(), ...approval, reason },
      signal,
    )
    expect(result).toMatchObject({ status: 'done', operationId: 'op-1' })
    expect(s.store.calls[0]).toMatchObject({
      args: [job.id, approved, 0],
      note: { runId: null, reason },
    })
  })

  it('says changed for an older revision, and for a review the engine finds changed', async () => {
    const s = await setup()
    const job = seedReview(s.store, 'ledger', s.lane)
    expect(
      await s.curator.decideRead({ jobId: job.id, revision: 7, ...approval, reason }, signal),
    ).toEqual({ status: 'changed', message: READ_CHANGED, operationId: null })
    s.store.refusal = new Error(BRAIN_REVIEW_CHANGED)
    expect(
      await s.curator.decideRead({ jobId: job.id, revision: 0, ...approval, reason }, signal),
    ).toMatchObject({ status: 'changed' })
    expect(s.store.calls).toEqual([])
  })

  it('refuses to approve a never-read lane, fresh or stale, with the existing sentences', async () => {
    const s = await setup()
    const job = seedReview(s.store, 'ledger', s.lane)
    s.store.prefs.neverRead = { ...s.store.prefs.neverRead, sessionIds: ['ledger'] }
    expect(
      await s.curator.decideRead({ jobId: job.id, revision: 0, ...approval, reason }, signal),
    ).toEqual({
      status: 'refused',
      message: 'Brain is set not to read this lane.',
      operationId: null,
    })
    s.store.rev++
    expect(
      await s.curator.decideRead({ jobId: job.id, revision: 0, ...approval, reason }, signal),
    ).toMatchObject({
      status: 'refused',
      message: expect.stringContaining('set to never be read'),
    })
    // Rejecting it is how it leaves.
    expect(
      (await s.curator.decideRead({ jobId: job.id, revision: 0, approve: false, reason }, signal))
        .status,
    ).toBe('done')
  })

  it('checks the lane as it is now before approving a fresh read: renamed, then deleted', async () => {
    const s = await setup()
    const job = seedReview(s.store, 'ledger', s.lane)
    const decide = () =>
      s.curator.decideRead({ jobId: job.id, revision: 0, ...approval, reason }, signal)
    // Renaming a lane changes no knowledge, so the read stays fresh.
    await nameLane(s.lane, 'Harbor 1:1')
    expect(await decide()).toEqual({
      status: 'refused',
      message: 'Brain never reads this lane because its title matches a rule in Settings › Brain.',
      operationId: null,
    })
    await unlink(s.lane)
    expect(await decide()).toEqual({
      status: 'refused',
      message: DELETED_LANE_REFRESH_REFUSAL,
      operationId: null,
    })
    expect(s.store.calls).toEqual([])
    expect(s.queue.refreshInline).not.toHaveBeenCalled()
  })

  it('refuses a read that is not waiting', async () => {
    const s = await setup()
    for (const choice of [{ approve: false }, approval])
      expect(
        await s.curator.decideRead({ jobId: 'gone', revision: 0, ...choice, reason }, signal),
      ).toEqual({
        status: 'refused',
        message: 'This read is not waiting for a decision.',
        operationId: null,
      })
  })
})

describe('other writes', () => {
  it('resolve, edit and undo journal their reason and return what undoes them', async () => {
    const s = await setup()
    expect(
      await s.curator.resolve(
        { suggestionId: 'sugg-rina', action: { kind: 'merge', survivorId: 'rina' }, reason },
        signal,
      ),
    ).toEqual({ status: 'done', message: 'Merged.', operationId: 'op-1' })
    expect(
      await s.curator.edit(
        {
          edit: { kind: 'describe', entityId: 'rina', description: 'Harbor billing lead' },
          reason,
        },
        signal,
      ),
    ).toEqual({ status: 'done', message: 'Saved the description.', operationId: 'op-2' })
    expect(await s.curator.undo({ operationId: 'op-1', reason }, signal)).toEqual({
      status: 'done',
      message: 'Undone.',
      operationId: null,
    })
    expect(s.store.calls.map((call) => call.method)).toEqual(['resolve', 'agentEdit', 'agentUndo'])
    expect(s.search.refreshes).toBe(3)
  })

  it('correct embeds the scrubbed summary, and saves with no vector when the model is unavailable', async () => {
    const s = await setup()
    const summary = 'Tom Lee owns Harbor billing; ask tom@harbor.example.'
    const result = await s.curator.correct(
      { memoryId: 'ownership', summary, source: 'Linear KES-12', quote: 'Tom takes over.', reason },
      signal,
    )
    expect(result.status).toBe('done')
    const [input, vector] = s.store.calls[0]!.args as [{ summary: string }, Float32Array | null]
    expect(input.summary).toBe('Tom Lee owns Harbor billing; ask [redacted].')
    expect(s.options.embeddings.embed).toHaveBeenCalledWith([input.summary], 'document', signal)
    expect(vector).toBeInstanceOf(Float32Array)
    s.options.embeddings.embed = async () => {
      throw new Error('Model not ready')
    }
    await s.curator.correct(
      {
        memoryId: 'ownership',
        summary: 'Tom Lee owns it.',
        source: 'Slack #ledger',
        quote: 'Tom owns it.',
        reason,
      },
      signal,
    )
    expect(s.store.calls[1]!.args[1]).toBeNull()
  })

  it('correct passes its call’s signal to the model, and writes nothing once cancelled', async () => {
    const s = await setup()
    const request = {
      memoryId: 'ownership',
      summary: 'Tom Lee owns it.',
      source: 'Slack #ledger',
      quote: 'Tom owns it.',
      reason,
    }
    // The model finishes after the call hung up.
    const hangUp = new AbortController()
    const late = vi.fn(async () => {
      hangUp.abort()
      return [[0.1, 0.2]]
    })
    s.options.embeddings.embed = late
    await expect(s.curator.correct(request, hangUp.signal)).rejects.toThrow()
    expect(late).toHaveBeenCalledWith(['Tom Lee owns it.'], 'document', hangUp.signal)
    // The model stops because the call hung up: that is not the no-vector fallback.
    const again = new AbortController()
    s.options.embeddings.embed = async (_texts, _kind, embedding) => {
      again.abort()
      embedding?.throwIfAborted()
      return []
    }
    await expect(s.curator.correct(request, again.signal)).rejects.toThrow()
    expect(s.store.calls).toEqual([])
    expect(s.search.refreshes).toBe(0)
  })

  it('erasure is final: it never returns an operation, and the hourly cap reads as limit', async () => {
    const s = await setup()
    expect(await s.curator.erase({ memoryId: 'ownership', reason }, signal)).toEqual({
      status: 'done',
      message: 'Erased. This is final: only your reason is kept.',
      operationId: null,
    })
    s.store.refusal = new Error(BRAIN_ERASE_LIMIT_REFUSAL)
    expect(await s.curator.erase({ memoryId: 'other', reason }, signal)).toEqual({
      status: 'limit',
      message: BRAIN_ERASE_LIMIT_REFUSAL,
      operationId: null,
    })
  })

  it('engine refusals come back as one plain line, with no path or stack', async () => {
    const s = await setup()
    s.store.refusal = new Error(
      'Give a reason without quoting the memory; nothing changed.\n    at erase (/app/libs/memory-engine/src/agent/store.ts:9:1)',
    )
    expect(await s.curator.erase({ memoryId: 'ownership', reason }, signal)).toEqual({
      status: 'refused',
      message: 'Give a reason without quoting the memory; nothing changed.',
      operationId: null,
    })
    s.store.refusal = new Error('SQLITE_ERROR at /Users/rina/Library/brain.sqlite')
    const result = await s.curator.resolve(
      { suggestionId: 's', action: { kind: 'keep' }, reason },
      signal,
    )
    expect(result).toMatchObject({ status: 'refused', message: 'SQLITE_ERROR at a file' })
    expect(s.search.refreshes).toBe(0)
  })

  it('scrubs reasons before they are journaled, and refuses every write when Brain is off', async () => {
    const s = await setup()
    await s.curator.erase(
      { memoryId: 'm', reason: 'Superseded; token=abc123 leaked here.' },
      signal,
    )
    expect(s.store.calls[0]!.note.reason).toBe('Superseded; [redacted] leaked here.')
    s.store.prefs.enabled = false
    const off = { status: 'refused', message: BRAIN_OFF, operationId: null }
    expect(await s.curator.erase({ memoryId: 'm', reason }, signal)).toEqual(off)
    expect(
      await s.curator.decideRead({ jobId: 'j', revision: 0, approve: false, reason }, signal),
    ).toEqual(off)
    expect(await s.curator.undo({ operationId: 'op', reason }, signal)).toEqual(off)
    expect(s.store.calls).toHaveLength(1)
  })
})
