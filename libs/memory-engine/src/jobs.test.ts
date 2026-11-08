import { describe, expect, it } from 'vitest'
import { extraction, fixture, lane } from './test-support'

describe('Brain jobs', () => {
  it.each(['waiting', 'queued', 'running', 'review'] as const)(
    'refuses an unfinished %s lane',
    (state) => {
      const { store } = fixture()
      const job = store.enqueue(lane(), 'queued')
      store.updateJob(job.id, { state })
      expect(() => store.enqueue(lane({ leafId: 'new' }), 'waiting')).toThrow(
        'This lane is already queued.',
      )
    },
  )
  it('refuses an unchanged done leaf, retains only the newest done marker, and orders the inbox', () => {
    const { store } = fixture()
    const first = store.enqueue(lane(), 'waiting')
    store.updateJob(first.id, { state: 'done' })
    expect(store.snapshot().jobs).toEqual([])
    expect(() => store.enqueue(lane(), 'queued')).toThrow(
      'Nothing new in this lane since its last extraction.',
    )
    const second = store.enqueue(lane({ leafId: 'leaf-2' }), 'queued')
    store.updateJob(second.id, { state: 'done' })
    expect(store.job(first.id)).toBeUndefined()
    expect(() => store.enqueue(lane({ leafId: 'leaf-2' }), 'queued')).toThrow('Nothing new')
    const third = store.enqueue(lane(), 'waiting')
    const fourth = store.enqueue(lane({ sessionId: 'other' }), 'queued')
    expect(store.snapshot().jobs.map((job) => job.id)).toEqual([third.id, fourth.id])
  })
  it.each(['empty', 'failed'] as const)(
    'permits retries of a %s job and dismissal deletes its proposal',
    (state) => {
      const { store, db } = fixture()
      const first = store.enqueue(lane(), 'queued')
      store.propose(extraction(first.id))
      store.updateJob(first.id, { state })
      const retry = store.enqueue(lane(), 'queued')
      expect(retry.id).not.toBe(first.id)
      store.removeJob(first.id)
      expect(store.job(first.id)).toBeUndefined()
      expect(db.prepare('SELECT COUNT(*) AS n FROM proposals').get()).toEqual({ n: 0 })
      expect(db.prepare('SELECT COUNT(*) AS n FROM proposal_vectors').get()).toEqual({ n: 0 })
    },
  )
  it('requeues only interrupted running jobs, clearing stale run fields', () => {
    const { store } = fixture()
    const running = store.enqueue(lane(), 'queued')
    store.updateJob(running.id, {
      state: 'running',
      startedAt: 50,
      error: 'interrupted',
      finishedAt: 60,
    })
    const waiting = store.enqueue(lane({ sessionId: 'waiting' }), 'waiting')
    store.requeueInterrupted()
    expect(store.job(running.id)).toMatchObject({
      state: 'queued',
      startedAt: null,
      error: null,
      finishedAt: null,
    })
    expect(store.job(waiting.id)?.state).toBe('waiting')
  })
  it('reports missing jobs explicitly', () => {
    const { store } = fixture()
    expect(() => store.updateJob('absent', { state: 'running' })).toThrow('Brain job not found.')
  })
})
