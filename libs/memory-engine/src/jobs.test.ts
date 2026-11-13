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
  it.each(['failed'] as const)(
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
      startedAt: 50,
      error: null,
      finishedAt: null,
    })
    expect(store.job(waiting.id)?.state).toBe('waiting')
  })
  it('persists the lane metadata read at startup and compares the stored finished leaf', () => {
    const { store } = fixture()
    const job = store.enqueue(lane(), 'queued')
    const patch = { leafId: 'leaf-at-start', model: 'made-up/new-model', branch: 'settlement' }
    store.savePart(job.id, {
      part: 'prepare',
      inputHash: 'frozen-v4',
      output: JSON.stringify(patch),
      prepare: patch,
    })
    expect(store.job(job.id)).toMatchObject(patch)
    store.updateJob(job.id, { state: 'done' })
    expect(() => store.enqueue(lane({ leafId: 'leaf-at-start' }), 'queued')).toThrow(
      'Nothing new in this lane since its last extraction.',
    )
    const next = store.enqueue(lane(), 'queued')
    store.savePart(next.id, {
      part: 'prepare',
      inputHash: 'frozen-v4',
      output: '{}',
      prepare: { leafId: null, branch: null, model: lane().model },
    })
    expect(store.job(next.id)).toMatchObject({ leafId: null, branch: null, model: lane().model })
  })
  it('reports missing jobs explicitly', () => {
    const { store } = fixture()
    expect(() => store.updateJob('absent', { state: 'running' })).toThrow('Brain job not found.')
  })
})

it('retries the same failed job with frozen leaf and hash-keyed checkpoints', () => {
  const { store, db } = fixture()
  const job = store.enqueue(lane(), 'queued')
  store.updateJob(job.id, { state: 'running', startedAt: 10 })
  store.savePart(job.id, {
    part: 'prepare',
    inputHash: 'frozen-v4',
    output: '{}',
    prepare: { leafId: 'frozen', model: job.model, branch: job.branch },
  })
  store.savePart(job.id, { part: 'window-1', inputHash: 'a', output: 'answer' })
  store.updateJob(job.id, { state: 'failed', error: 'stopped' })
  expect(store.retry(job.id)).toMatchObject({ id: job.id, state: 'queued', leafId: 'frozen' })
  expect(store.part(job.id, 'window-1', 'a')?.output).toBe('answer')
  expect(store.part(job.id, 'window-1', 'b')).toBeUndefined()
  expect(() => store.updateJob(job.id, { leafId: 'moved' })).toThrow('frozen')
  store.removeJob(job.id)
  expect(db.prepare('SELECT * FROM job_parts').all()).toEqual([])
})
it('allows unchanged finished leaves only when their extractor version changed', () => {
  const { store, db } = fixture()
  const job = store.enqueue(lane(), 'queued')
  store.updateJob(job.id, { state: 'done' })
  db.prepare('UPDATE jobs SET extractor=3 WHERE id=?').run(job.id)
  expect(store.enqueue(lane(), 'queued').id).not.toBe(job.id)
})

it('saves prepare metadata atomically, freezes null leaves too, and refuses replacement', () => {
  const { store, db } = fixture()
  const job = store.enqueue(lane(), 'queued')
  const checkpoint = {
    part: 'prepare',
    inputHash: 'frozen-v4',
    output: '{}',
    prepare: { leafId: null, model: 'example/new', branch: null },
  }
  db.exec(
    "CREATE TRIGGER fail_prepare BEFORE INSERT ON job_parts BEGIN SELECT RAISE(ABORT, 'failed save'); END",
  )
  expect(() => store.savePart(job.id, checkpoint)).toThrow('failed save')
  expect(store.job(job.id)).toEqual(job)
  expect(store.part(job.id, 'prepare', 'frozen-v4')).toBeUndefined()
  db.exec('DROP TRIGGER fail_prepare')
  store.savePart(job.id, checkpoint)
  expect(store.job(job.id)).toMatchObject(checkpoint.prepare)
  expect(() => store.updateJob(job.id, { leafId: 'later' })).toThrow('frozen')
  expect(() =>
    store.savePart(job.id, { ...checkpoint, prepare: { ...checkpoint.prepare, leafId: 'later' } }),
  ).toThrow('frozen')
})
