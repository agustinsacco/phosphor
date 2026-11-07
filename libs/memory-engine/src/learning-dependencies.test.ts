import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { BrainLearningEntry } from '@phosphor/shared/brain-learning'
import { findings, learningFixture, scope, start, usage } from './__fixtures__/learning'

const fixtures: ReturnType<typeof learningFixture>[] = []
function setup() {
  const f = learningFixture()
  fixtures.push(f)
  return f
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup()
})
function database<T>(directory: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(directory, 'memory.sqlite'))
  try {
    return fn(db)
  } finally {
    db.close()
  }
}
const image: BrainLearningEntry = {
  entryId: 'image',
  parentId: 'input',
  entryHash: 'image-entry-hash',
  rootId: 'image-content-hash',
}
function withNontext() {
  const input = start()
  const { projectedHash: _hash, ...original } = input.covered[0]!
  input.dependencies = [original, image]
  input.dependencyRootIds.push(image.entryId)
  input.covered.push({ ...image, projectedHash: 'image-projection' })
  input.covered.push({
    entryId: 'thinking',
    parentId: 'image',
    entryHash: 'thinking-hash',
    rootId: 'thinking-content',
    projectedHash: 'thinking-projection',
  })
  input.checkpoint.sourceEntryCount = 3
  return input
}

it('anchors nontext model dependencies privately without readable evidence or extra witnesses', () => {
  const f = setup(),
    input = withNontext()
  const job = f.store.claimJob(f.store.createLearning(input).job.id)
  expect(job.evidenceIds).toHaveLength(1)
  expect(f.store.read(job.evidenceIds[0]!, [scope]).rootIds).toEqual(['input'])
  expect(f.store.snapshot().counts.evidence).toBe(1)
  const anchors = database(f.directory, (db) =>
    db.prepare('SELECT root_id FROM learning_dependencies ORDER BY root_id').all(),
  )
  expect(anchors.map((row) => row.root_id)).toEqual(['image', 'input'])
  const detail = f.store.completeLearning(job.id, job.fence, {
    outcome: { type: 'no_findings' },
    usage,
  })
  expect(detail.job.state).toBe('completed')
  expect(
    f.store.learningCoverage(
      scope,
      'source',
      'projection-digest',
      input.covered,
      input.dependencyRootIds,
    ).covered,
  ).toHaveLength(3)
  expect(JSON.stringify(detail.job)).not.toContain('image-entry-hash')
  f.store.close()
  expect(f.open().learningDetail(job.id)).toEqual(detail)
})

it('forgets claims and outcomes when an uncited nontext original input is forgotten', () => {
  const f = setup(),
    input = withNontext()
  const original = f.store.capture({
    scope,
    sessionId: 'source',
    entryId: image.entryId,
    parentId: 'input',
    rootIds: [image.entryId],
    branch: null,
    role: 'user',
    label: 'earlier original',
    observedAt: 1,
    text: 'Earlier captured original input',
  })!
  const job = f.store.claimJob(f.store.createLearning(input).job.id)
  const detail = f.store.completeLearning(job.id, job.fence, findings())
  f.store.review(detail.proposalId!, true, f.store.snapshot())
  f.store.forget([original.id])
  expect(f.store.snapshot().claims).toEqual([])
  expect(f.store.snapshot().entities).toEqual([])
  expect(f.store.learningDetail(job.id).outcome).toBeNull()
  expect(
    database(
      f.directory,
      (db) => db.prepare('SELECT count(*) AS n FROM learning_dependencies').get()?.n,
    ),
  ).toBe(0)
  expect(() => f.store.createLearning({ ...input, jobId: 'late' })).toThrow(/forgotten/)
})

it('expires private nontext anchors without inventing evidence or forgetting unrelated original roots', () => {
  const f = setup(),
    input = withNontext()
  const job = f.store.claimJob(f.store.createLearning(input).job.id)
  const detail = f.store.completeLearning(job.id, job.fence, findings())
  f.store.review(detail.proposalId!, true, f.store.snapshot())
  database(f.directory, (db) => {
    db.exec(
      "UPDATE retained SET retained_at=999999999999; UPDATE learning_dependencies SET retained_at=999999999999 WHERE root_id='input';",
    )
  })
  f.advance(31 * 86400000)
  expect(f.store.snapshot().counts.evidence).toBe(0)
  expect(f.store.snapshot().claims).toEqual([])
  expect(f.store.learningDetail(job.id).outcome).toBeNull()
  expect(() =>
    f.store.learningCoverage(scope, 'source', 'projection', [input.covered[1]!], ['copy']),
  ).toThrow(/forgotten/)
  expect(f.store.createLearning(start('surviving-original')).created).toBe(true)
})

it('refuses missing, duplicated, unbound or changed original dependency descriptors before admission', () => {
  for (const change of ['missing', 'duplicate', 'changed', 'text-unbound']) {
    const f = setup(),
      input = withNontext()
    const extended = input
    if (change === 'missing') extended.dependencies.pop()
    if (change === 'duplicate') extended.dependencies.push(extended.dependencies[0]!)
    if (change === 'changed') extended.dependencies[0]!.entryHash = 'changed'
    if (change === 'text-unbound') {
      extended.dependencies = [image]
      input.dependencyRootIds = ['image']
    }
    expect(() => f.store.createLearning(input)).toThrow()
    expect(f.store.learningJobs(scope).items).toEqual([])
    expect(f.store.snapshot().counts.evidence).toBe(0)
  }
})

it('atomically rolls back private anchors and evidence if any dependency anchor fails to persist', () => {
  const f = setup()
  database(f.directory, (db) =>
    db.exec(
      "CREATE TRIGGER reject_dependency BEFORE INSERT ON learning_dependencies WHEN new.root_id='image' BEGIN SELECT RAISE(ABORT,'injected anchor failure'); END;",
    ),
  )
  expect(() => f.store.createLearning(withNontext())).toThrow(/injected anchor failure/)
  expect(f.store.snapshot().counts.evidence).toBe(0)
  expect(f.store.learningJobs(scope).items).toEqual([])
  expect(
    database(
      f.directory,
      (db) => db.prepare('SELECT count(*) AS n FROM learning_dependencies').get()?.n,
    ),
  ).toBe(0)
})

it('keeps partial completed coverage incremental and links an exact failed attempt without automatic reprocessing', () => {
  const f = setup(),
    first = start()
  const firstJob = f.store.claimJob(f.store.createLearning(first).job.id)
  f.store.completeLearning(firstJob.id, firstJob.fence, { outcome: { type: 'no_findings' }, usage })
  const next = withNontext()
  next.jobId = 'incremental'
  const second = {
    entryId: 'second',
    parentId: 'thinking',
    entryHash: 'second-hash',
    rootId: 'second-content',
    projectedHash: 'second-projected',
  }
  next.covered.push(second)
  next.checkpoint.sourceEntryCount = 4
  next.evidence[0]!.eligible = false
  next.evidence.push({
    ...second,
    evidenceId: 'new-wire',
    rootIds: ['second'],
    role: 'user',
    sourceType: 'message',
    text: 'Bob blocks Project.',
    eligible: true,
  })
  next.dependencyRootIds.push('second')
  const { projectedHash: _hash, ...original } = second
  next.dependencies.push(original)
  const before = f.store.learningCoverage(
    scope,
    'source',
    'new-projection',
    next.covered,
    next.dependencyRootIds,
  )
  expect(before.covered).toEqual([
    { rootId: first.covered[0]!.rootId, projectedHash: first.covered[0]!.projectedHash },
  ])
  expect(before.previousJobId).toBeNull()
  const job = f.store.claimJob(f.store.createLearning(next).job.id)
  expect(job.learning).toMatchObject({ coveredCount: 1, newCount: 3 })
  f.store.failLearning(job.id, job.fence, 'failed', 'failed new work', usage)
  expect(
    f.store.learningCoverage(
      scope,
      'source',
      'new-projection',
      next.covered,
      next.dependencyRootIds,
    ).previousJobId,
  ).toBe(job.id)
  next.jobId = 'explicit-retry'
  next.retryJobId = job.id
  next.evidence[0]!.eligible = true
  const retried = f.store.createLearning(next)
  expect(retried.created).toBe(true)
  expect(f.store.createLearning({ ...next, jobId: 'repeated-retry' })).toEqual({
    job: retried.job,
    created: false,
  })
})
