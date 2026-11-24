import { describe, expect, it } from 'vitest'
import { extraction, fixture, lane } from './test-support'

describe('Brain jobs', () => {
  it.each(['waiting', 'queued', 'running'] as const)('refuses an unfinished %s lane', (state) => {
    const { store } = fixture()
    const job = store.enqueue(lane(), 'queued')
    store.updateJob(job.id, { state })
    expect(() => store.enqueue(lane({ leafId: 'new' }), 'waiting')).toThrow(
      'This lane is already queued.',
    )
  })
  it('refuses an unchanged done leaf, retains earlier done markers, and orders the inbox', () => {
    const { store } = fixture()
    const first = store.enqueue(lane(), 'waiting')
    store.updateJob(first.id, { state: 'done' })
    expect(store.snapshot().jobs).toEqual([])
    expect(() => store.enqueue(lane(), 'queued')).toThrow(
      'Nothing new in this lane since its last read.',
    )
    const second = store.enqueue(lane({ leafId: 'leaf-2' }), 'queued')
    store.updateJob(second.id, { state: 'done' })
    expect(store.job(first.id)?.leafId).toBe('leaf-1')
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
      db.prepare('INSERT INTO proposals VALUES (?,?)').run(
        first.id,
        JSON.stringify(extraction(first.id)),
      )
      db.prepare("INSERT INTO proposal_vectors VALUES (?,'memory',0,x'00')").run(first.id)
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
      'Nothing new in this lane since its last read.',
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
it('queues only new messages after a version-6 read under extractor version 7', () => {
  const { store, db } = fixture()
  const job = store.enqueue(lane(), 'queued')
  store.updateJob(job.id, { state: 'done' })
  db.prepare('UPDATE jobs SET extractor=6 WHERE id=?').run(job.id)
  expect(() => store.enqueue(lane(), 'queued')).toThrow('Nothing new')
  const next = store.enqueue(lane({ leafId: 'new' }), 'queued')
  expect(next.fromLeafId).toBe(job.leafId)
  expect(db.prepare('SELECT extractor FROM jobs WHERE id=?').get(next.id)).toEqual({ extractor: 7 })
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

it.each(['done', 'empty', 'rejected'] as const)(
  'uses %s reads as incremental cursors and retains every leaf',
  (state) => {
    const { store } = fixture()
    const old = store.enqueue(lane(), 'queued')
    store.updateJob(old.id, { state })
    expect(() => store.enqueue(lane(), 'queued')).toThrow('Nothing new')
    const next = store.enqueue(lane({ leafId: 'new' }), 'queued')
    expect(next.fromLeafId).toBe('leaf-1')
    store.updateJob(next.id, { state: 'done' })
    expect(store.laneRead('harbor-lane')?.job.leafId).toBe('new')
    expect(store.job(old.id)?.leafId).toBe('leaf-1')
  },
)
it('retains at most twenty finished reads per lane, including their step inputs', () => {
  const { store, db } = fixture()
  let first = ''
  for (let i = 0; i < 22; i++) {
    const job = store.enqueue(lane({ leafId: `leaf-${i}` }), 'queued')
    if (i === 0) first = job.id
    store.savePart(job.id, { part: 'window', inputHash: 'hash', output: 'read' })
    store.updateJob(job.id, { state: 'done' })
  }
  expect(store.laneRead('harbor-lane')?.job.leafId).toBe('leaf-21')
  expect(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='done'").get()).toEqual({ n: 20 })
  expect(store.job(first)).toBeUndefined()
  expect(store.part(first, 'window', 'hash')).toBeUndefined()
})

it('refuses a never-read lane even at the store enqueue boundary', () => {
  const { store } = fixture()
  store.setPrefs({
    ...store.snapshot().prefs,
    neverRead: { titles: ['1-1'], sessionIds: ['harbor-lane'] },
  })
  expect(() => store.enqueue(lane(), 'queued')).toThrow('Brain is set not to read this lane.')
  expect(() =>
    store.enqueue(lane({ sessionId: 'ledger', title: 'Rina 1-1 prep' }), 'queued'),
  ).toThrow('Brain never reads this lane because its title matches a rule in Settings › Brain.')
  expect(store.snapshot().jobs).toEqual([])
})

it('persists the attempt start, clears it on finish and refuses moving the first start', () => {
  const { store } = fixture()
  const job = store.enqueue(lane(), 'queued')
  store.updateJob(job.id, { state: 'running', startedAt: 10, runStartedAt: 30 })
  expect(store.job(job.id)).toMatchObject({ startedAt: 10, runStartedAt: 30 })
  expect(() => store.updateJob(job.id, { startedAt: 40 })).toThrow('first read start cannot change')
  store.updateJob(job.id, { state: 'done' })
  expect(store.job(job.id)).toMatchObject({ startedAt: 10, runStartedAt: null })
})

it.each([false, true])(
  'does not move the cursor backwards when an older read finishes last (same queued time: %s)',
  (tie) => {
    const { store, db } = fixture()
    const base = store.enqueue(lane({ leafId: 'a' }), 'queued')
    store.updateJob(base.id, { state: 'done' })
    const first = store.enqueue(lane({ leafId: 'b' }), 'queued')
    store.updateJob(first.id, { state: 'failed' })
    const second = store.enqueue(lane({ leafId: 'c' }), 'queued')
    if (tie) db.prepare('UPDATE jobs SET queued_at=? WHERE id=?').run(first.queuedAt, second.id)
    expect(first.fromLeafId).toBe('a')
    expect(second.fromLeafId).toBe('a')
    store.updateJob(second.id, { state: 'done', finishedAt: 2000 })
    // An older retry may still finish late after upgrading an app that allowed it.
    store.updateJob(first.id, { state: 'done', finishedAt: 3000 })
    const next = store.enqueue(lane({ leafId: 'd' }), 'queued')
    expect(next.fromLeafId).toBe('c')
  },
)
it.each(['queued', 'waiting', 'failed', 'done', 'empty', 'rejected'] as const)(
  'refuses Retry when a later %s read exists and leaves Dismiss available',
  (state) => {
    const { store } = fixture()
    const first = store.enqueue(lane({ leafId: 'b' }), 'queued')
    store.updateJob(first.id, { state: 'failed' })
    const second = store.enqueue(lane({ leafId: 'c' }), 'queued')
    store.updateJob(second.id, { state })
    expect(() => store.retry(first.id)).toThrow(
      'A later read of this lane already covers these messages.',
    )
    expect(store.job(first.id)?.state).toBe('failed')
    store.removeJob(first.id)
    expect(store.job(first.id)).toBeUndefined()
    expect(store.job(second.id)?.state).toBe(state)
  },
)

it('keeps an empty lane title empty, so a rule naming the placeholder never matches it', () => {
  const { store } = fixture()
  store.setPrefs({
    ...store.snapshot().prefs,
    neverRead: { titles: ['Untitled lane'], sessionIds: [] },
  })
  const job = store.enqueue(lane({ title: '' }), 'queued')
  expect(job.title).toBe('')
  expect(store.snapshot().jobs[0]?.title).toBe('')
})

it('keeps an untitled lane’s stored title empty, for the app to name', () => {
  const { store } = fixture()
  const job = store.enqueue(lane({ title: '' }), 'queued')
  expect(job.title).toBe('')
  expect(store.job(job.id)?.title).toBe('')
  expect(store.snapshot().jobs[0]?.title).toBe('')
  store.updateJob(job.id, { state: 'done' })
  expect(store.laneRead('harbor-lane')?.job.title).toBe('')
})

it('stores a lane’s current title as bookkeeping, without a revision change', () => {
  const { store } = fixture()
  const job = store.enqueue(lane({ title: 'Tom sync' }), 'queued')
  const before = [store.revision(), store.knowledgeRevision()]
  store.updateJob(job.id, { title: 'Tom 1:1' })
  expect(store.job(job.id)?.title).toBe('Tom 1:1')
  expect([store.revision(), store.knowledgeRevision()]).toEqual(before)
})
