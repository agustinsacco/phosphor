import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { readdirSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { findings, learningFixture, prefs, scope, start, usage } from './__fixtures__/learning'

const fixtures: ReturnType<typeof learningFixture>[] = []
function setup() {
  const value = learningFixture()
  fixtures.push(value)
  return value
}
afterEach(() => {
  for (const value of fixtures.splice(0)) value.cleanup()
})
function modify(directory: string, sql: string) {
  const db = new DatabaseSync(join(directory, 'memory.sqlite'))
  try {
    db.exec(sql)
  } finally {
    db.close()
  }
}
function coverage(store: ReturnType<typeof learningFixture>['store']) {
  const input = start()
  return store.learningCoverage(
    scope,
    'source',
    'projection-digest',
    input.covered,
    input.dependencyRootIds,
  )
}
function run(fixture: ReturnType<typeof learningFixture>, input = start()) {
  const job = fixture.store.claimJob(fixture.store.createLearning(input).job.id)
  return { job, finish: () => fixture.store.completeLearning(job.id, job.fence, findings()) }
}

describe('learning receipts, provenance and bounded payloads', () => {
  it('maps quotes across byte/character chunk boundaries losslessly, including surrogate pairs', () => {
    const f = setup(),
      input = start()
    const text = 'α'.repeat(15999) + '😀' + '界'.repeat(18000)
    input.evidence[0]!.text = text
    const { job } = run(f, input)
    expect(job.evidenceIds.length).toBeGreaterThan(1)
    for (const index of [14000, 15998, 15999, 27999, 29999]) {
      const quote = text.slice(index, index + 2000)
      expect(job.evidenceIds.some((id) => f.store.read(id, [scope]).text.includes(quote))).toBe(
        true,
      )
    }
    const completion = findings()
    if (completion.outcome.type !== 'findings') throw new Error('fixture')
    const quote = text.slice(15000, 17000)
    completion.outcome.findings[0]!.citations[0]!.quote = quote
    const detail = f.store.completeLearning(job.id, job.fence, completion)
    const citation = f.store.snapshot().proposals[0]!.input.claims[0]!.citations[0]!
    expect(f.store.read(citation.evidenceId, [scope]).text).toContain(quote)
    expect(detail.outcome).toEqual(completion.outcome)
    for (const id of job.evidenceIds) {
      const stored = f.store.read(id, [scope])
      expect(stored.text.length).toBeLessThanOrEqual(16000)
      expect(stored.rootIds).toEqual(['input'])
      expect(stored.text).not.toContain('�')
    }
  })
  it('refuses over-budget input, root counts, eligible blocks and capacities before admission', () => {
    const { store, directory } = setup()
    const input = start()
    input.evidence[0]!.text = 'x'.repeat(4_000_001)
    expect(() => store.createLearning(input)).toThrow(/bounds/)
    expect(readdirSync(join(directory, 'evidence'))).toEqual([])
    const roots = start()
    roots.dependencyRootIds = Array.from({ length: 1001 }, (_, i) => `root-${i}`)
    expect(() => store.createLearning(roots)).toThrow(/bounds/)
    const blocks = start()
    blocks.evidence = Array.from({ length: 201 }, (_, i) => ({
      ...blocks.evidence[0]!,
      evidenceId: `block-${i}`,
    }))
    expect(() => store.createLearning(blocks)).toThrow(/eligible context/)
    modify(
      directory,
      `WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<10000) INSERT INTO documents SELECT 'evidence','capacity-'||n,'/other','{}' FROM ids;`,
    )
    expect(() => store.createLearning(start())).toThrow(/capacity/)
    expect(store.learningJobs(scope).items).toEqual([])
  })
  it('retains up to 1000 original summary dependencies without treating them as observations', () => {
    const f = setup(),
      input = start()
    input.evidence[0]!.sourceType = 'compaction'
    input.evidence[0]!.rootIds = Array.from({ length: 1000 }, (_, i) => `original-${i}`)
    input.dependencyRootIds = input.evidence[0]!.rootIds
    input.dependencies = input.dependencyRootIds.map((entryId) => ({
      entryId,
      parentId: null,
      entryHash: `hash-${entryId}`,
      rootId: `content-${entryId}`,
    }))
    input.checkpoint.sourceEntryCount = 1001
    const { job } = run(f, input)
    expect(f.store.read(job.evidenceIds[0]!, [scope]).rootIds).toHaveLength(1000)
    const completion = findings()
    if (completion.outcome.type !== 'findings') throw new Error('fixture')
    completion.outcome.findings[0]!.kind = 'observed'
    expect(() => f.store.completeLearning(job.id, job.fence, completion)).toThrow(
      /independent observation/,
    )
    completion.outcome.findings[0]!.kind = 'inferred'
    expect(f.store.completeLearning(job.id, job.fence, completion).proposalId).toBeTruthy()
    expect(() =>
      f.store.capture({
        scope,
        sessionId: 'ordinary',
        entryId: 'ordinary',
        parentId: null,
        rootIds: input.dependencyRootIds,
        branch: null,
        role: 'user',
        label: 'ordinary',
        observedAt: 1000,
        text: 'ordinary',
      }),
    ).toThrow(/bounds/)
  })
  it('rejects corrupt receipts and changed source/account/model bindings before claiming', () => {
    for (const field of ['receipt', 'account', 'source', 'model', 'scope']) {
      const f = setup()
      const { job } = f.store.createLearning(start())
      if (field === 'receipt')
        modify(
          f.directory,
          `UPDATE documents SET value=json_set(value,'$.value.binding.accountId','tampered') WHERE kind='learningInputs';`,
        )
      else {
        const path = {
          account: '$.learning.binding.accountId',
          source: '$.learning.source.sessionId',
          model: '$.model.id',
          scope: '$.scope',
        }[field]!
        modify(
          f.directory,
          `UPDATE documents SET value=json_set(value,'${path}','tampered') WHERE kind='jobs';`,
        )
      }
      expect(() => f.store.claimJob(job.id)).toThrow()
      expect(f.store.job(job.id).state).toBe('queued')
    }
  })
  it('rejects source blob corruption and rollback never leaves accepted claims or coverage', () => {
    const f = setup()
    const { job } = f.store.createLearning(start())
    writeFileSync(
      join(f.directory, 'evidence', readdirSync(join(f.directory, 'evidence'))[0]!),
      'corrupt',
    )
    expect(() => f.store.claimJob(job.id)).toThrow(/integrity/)
    expect(coverage(f.store).covered).toEqual([])
  })
  it('rolls back proposals, outcome and coverage together after a late SQL failure', () => {
    const f = setup(),
      { job, finish } = run(f)
    modify(
      f.directory,
      `CREATE TRIGGER reject_learning BEFORE INSERT ON learning_coverage BEGIN SELECT RAISE(ABORT,'injected coverage failure'); END;`,
    )
    expect(finish).toThrow(/injected/)
    expect(f.store.job(job.id).state).toBe('running')
    expect(f.store.snapshot().proposals).toEqual([])
    expect(f.store.learningDetail(job.id).outcome).toBeNull()
    expect(coverage(f.store).covered).toEqual([])
    modify(f.directory, 'DROP TRIGGER reject_learning;')
    expect(finish().proposalId).toBeTruthy()
  })
  it('cleans blobs, receipts and jobs if source persistence fails partway through admission', () => {
    const f = setup()
    modify(
      f.directory,
      `CREATE TRIGGER reject_job BEFORE INSERT ON documents WHEN new.kind='jobs' BEGIN SELECT RAISE(ABORT,'injected job failure'); END;`,
    )
    expect(() => f.store.createLearning(start())).toThrow(/injected/)
    expect(readdirSync(join(f.directory, 'evidence'))).toEqual([])
    expect(f.store.learningJobs(scope).items).toEqual([])
    expect(coverage(f.store)).toEqual({ covered: [], previousJobId: null })
  })
  it('rejects graph and policy stale completion, retaining response-only nullable failure usage', () => {
    const f = setup(),
      { job, finish } = run(f)
    modify(
      f.directory,
      `UPDATE meta SET value=json_set(value,'$.graphRevision',1) WHERE key='revision';`,
    )
    expect(finish).toThrow(/Stale/)
    const unavailable = {
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      reasoning: null,
    }
    expect(
      f.store.failLearning(job.id, job.fence, 'failed', 'stale', unavailable).learning?.usage,
    ).toEqual(unavailable)
    expect(coverage(f.store).covered).toEqual([])
    const other = setup(),
      running = run(other)
    other.store.setPrefs({ ...prefs, recall: true })
    expect(running.finish).toThrow()
    expect(other.store.job(running.job.id).state).toBe('cancelled')
    expect(coverage(other.store).covered).toEqual([])
  })
  it('keeps completed coverage when explicitly reprocessing and deduplicates a repeated retry acknowledgment', () => {
    const f = setup(),
      first = run(f).finish()
    f.store.review(first.proposalId!, false, f.store.snapshot())
    const retryInput = { ...start('owner-2'), retryJobId: first.job.id }
    const retry = f.store.createLearning(retryInput)
    expect(retry.created).toBe(true)
    expect(retry.job.learning?.newCount).toBe(1)
    expect(f.store.createLearning({ ...retryInput, jobId: 'owner-3' })).toEqual({
      job: retry.job,
      created: false,
    })
    const claimed = f.store.claimJob(retry.job.id)
    f.store.failLearning(claimed.id, claimed.fence, 'failed', 'failed paid reprocess', usage)
    expect(coverage(f.store).covered).toHaveLength(1)
    expect(f.store.createLearning({ ...retryInput, jobId: 'owner-4' }).created).toBe(false)
    expect(f.store.createLearning({ ...start('owner-5'), retryJobId: retry.job.id }).created).toBe(
      true,
    )
  })
  it('checks recipient and processor exclusions on coverage and create, including empty recall', () => {
    const f = setup()
    f.store.createLearning(start())
    const running = f.store.claimJob('owner-1')
    f.store.updateJob(running.id, running.fence, { sessionPath: '/sessions/processor.jsonl' })
    const source = start('owner-2')
    source.checkpoint.source.sessionId = 'processor'
    expect(() =>
      f.store.learningCoverage(
        scope,
        'processor',
        'projection-digest',
        source.covered,
        source.dependencyRootIds,
      ),
    ).toThrow(/processor/)
    expect(() => f.store.createLearning(source)).toThrow(/processor/)
    f.store.recordDelivery({ sessionId: 'empty-recipient', evidenceIds: [], claimIds: [] })
    source.checkpoint.source.sessionId = 'empty-recipient'
    expect(() => f.store.createLearning(source)).toThrow(/recipient/)
  })
  it('expires outcomes, proposals and coverage on retention and cannot resurrect forgotten sources', () => {
    const f = setup(),
      completed = run(f).finish()
    f.store.review(completed.proposalId!, true, f.store.snapshot())
    f.advance(31 * 86400000)
    expect(f.store.snapshot().claims).toEqual([])
    expect(f.store.snapshot().proposals).toEqual([])
    expect(f.store.learningDetail(completed.job.id).outcome).toBeNull()
    expect(f.store.pendingPurges()).toEqual([])
    expect(readdirSync(join(f.directory, 'evidence'))).toEqual([])
    expect(() => coverage(f.store)).toThrow(/forgotten/)
    f.store.close()
    expect(() => f.open().createLearning(start('owner-2'))).toThrow(/forgotten/)
  })
  it('returns only requested coverage pairs and bounds active/newest-first learning inventory', () => {
    const f = setup(),
      { job } = run(f)
    f.store.completeLearning(job.id, job.fence, { outcome: { type: 'no_findings' }, usage })
    expect(
      f.store.learningCoverage(
        scope,
        'source',
        'projection',
        [{ rootId: 'absent', projectedHash: 'absent' }],
        ['input'],
      ),
    ).toEqual({ covered: [], previousJobId: null })
    modify(
      f.directory,
      `WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<205) INSERT INTO documents SELECT 'jobs','inventory-'||n,'${scope}',json_set((SELECT value FROM documents WHERE kind='jobs' AND id='owner-1'),'$.id','inventory-'||n,'$.createdAt',n,'$.updatedAt',n) FROM ids;`,
    )
    const list = f.store.learningJobs(scope)
    expect(list.items).toHaveLength(200)
    expect(list.truncated).toBe(true)
    expect(list.items[0]!.id).toBe('owner-1')
    expect(list.items[1]!.id).toBe('inventory-205')
    expect(Buffer.byteLength(JSON.stringify(list))).toBeLessThan(500000)
    expect(f.store.learningJobs('/private')).toEqual({ items: [], truncated: false })
  })
})
