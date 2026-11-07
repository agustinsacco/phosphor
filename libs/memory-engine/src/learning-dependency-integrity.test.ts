import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { learningFixture, scope, start } from './__fixtures__/learning'

const fixtures: ReturnType<typeof learningFixture>[] = []
function setup() {
  const f = learningFixture()
  fixtures.push(f)
  return f
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup()
})
function modify(directory: string, sql: string): void {
  const db = new DatabaseSync(join(directory, 'memory.sqlite'))
  try {
    db.exec(sql)
  } finally {
    db.close()
  }
}

it('refuses missing or changed private dependency anchors before claiming a paid run', () => {
  for (const sql of [
    'DELETE FROM learning_dependencies;',
    "UPDATE learning_dependencies SET root_id='forged-root';",
    "UPDATE learning_dependencies SET scope='/other';",
  ]) {
    const f = setup()
    const { job } = f.store.createLearning(start())
    modify(f.directory, sql)
    expect(() => f.store.claimJob(job.id)).toThrow(/anchor receipt integrity/)
    expect(f.store.job(job.id).state).toBe('queued')
  }
})

it('refuses exhausted private anchor capacity before saving source blobs or jobs', () => {
  const f = setup()
  modify(
    f.directory,
    `WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<100000)
    INSERT INTO learning_dependencies SELECT 'capacity','/other','root-'||n,1000 FROM ids;`,
  )
  expect(() => f.store.createLearning(start())).toThrow(/dependency capacity/)
  expect(f.store.snapshot().counts.evidence).toBe(0)
  expect(f.store.learningJobs(scope).items).toEqual([])
})

it('accepts attested originals omitted from the projection but never treats a generated contribution as a new root', () => {
  const f = setup(),
    input = start()
  input.dependencies.push({
    entryId: 'compacted-image',
    parentId: 'input',
    entryHash: 'original-hash',
    rootId: 'original-content',
  })
  input.dependencyRootIds.push('compacted-image')
  input.checkpoint.sourceEntryCount = 3
  input.covered.push({
    entryId: 'thinking-only',
    parentId: 'compacted-image',
    entryHash: 'generated-hash',
    rootId: 'generated-content',
    projectedHash: 'thinking-projection',
  })
  const job = f.store.claimJob(f.store.createLearning(input).job.id)
  expect(job.evidenceIds).toHaveLength(1)
  const db = new DatabaseSync(join(f.directory, 'memory.sqlite'))
  try {
    expect(
      db
        .prepare('SELECT root_id FROM learning_dependencies ORDER BY root_id')
        .all()
        .map((row) => row.root_id),
    ).toEqual(['compacted-image', 'input'])
  } finally {
    db.close()
  }
  expect(f.store.read(job.evidenceIds[0]!, [scope]).rootIds).toEqual(['input'])
})
