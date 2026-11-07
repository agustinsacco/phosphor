import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { findings, learningFixture, scope, start } from './__fixtures__/learning'

const fixtures: ReturnType<typeof learningFixture>[] = []
function setup() {
  const f = learningFixture()
  fixtures.push(f)
  return f
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup()
})

it('persists trusted canonical scope, worktree target and acknowledged branch without widening copies', () => {
  const f = setup(),
    input = start()
  input.target.workspacePath = '/worktrees/topic'
  input.branch = 'topic'
  const job = f.store.claimJob(f.store.createLearning(input).job.id)
  expect(job.learning?.branch).toBe('topic')
  const original = f.store.read(job.evidenceIds[0]!, [scope])
  expect(original.branch).toBe('topic')
  f.store.completeLearning(job.id, job.fence, findings())
  const copy = { ...input, jobId: 'owner-2', branch: 'other-topic' }
  expect(f.store.createLearning(copy).created).toBe(false)
  expect(f.store.read(original.id, [scope]).branch).toBe('topic')
  const explicit = f.store.createLearning({ ...copy, retryJobId: job.id })
  expect(explicit.job.learning?.branch).toBe('other-topic')
  expect(explicit.job.learning?.retryOf).toBe(job.id)
  expect(f.store.read(explicit.job.evidenceIds[0]!, [scope]).branch).toBe('other-topic')
})

it('refuses forgotten contribution pairs after receipt deletion/reopen without tombstoning unrelated contributions', () => {
  const f = setup(),
    input = start()
  const second = {
    entryId: 'second',
    parentId: 'input',
    entryHash: 'second-hash',
    rootId: 'second-content',
    projectedHash: 'second-projection',
  }
  input.covered.push(second)
  input.evidence.push({
    ...second,
    evidenceId: 'second-wire',
    rootIds: ['second'],
    role: 'user',
    text: 'Bob blocks Project.',
    sourceType: 'message',
    eligible: true,
  })
  input.dependencyRootIds.push('second')
  const job = f.store.claimJob(f.store.createLearning(input).job.id)
  f.store.completeLearning(job.id, job.fence, findings())
  f.store.forget([job.evidenceIds[0]!])
  f.store.close()
  const reopened = f.open()
  // The frozen coverage pair is identical; provenance IDs alone cannot authorize a copy.
  expect(() =>
    reopened.learningCoverage(
      scope,
      'copied-source',
      'projection',
      [input.covered[0]!],
      ['copy-input'],
    ),
  ).toThrow(/forgotten/)
  expect(
    reopened.learningCoverage(scope, 'copied-source', 'projection', [second], ['second']).covered,
  ).toEqual([])
  const surviving = start('surviving')
  surviving.covered = [second]
  surviving.evidence = [input.evidence[1]!]
  surviving.dependencyRootIds = ['second']
  expect(reopened.createLearning(surviving).created).toBe(true)
})

it('interrupts orphaned queued learning only and requires an explicit successor after reopen', () => {
  const f = setup()
  const first = f.store.createLearning(start()).job
  f.store.close()
  const reopened = f.open()
  const repeated = reopened.createLearning(start('owner-2'))
  expect(repeated.created).toBe(false)
  expect(repeated.job.state).toBe('interrupted')
  expect(repeated.job.fence).toBe(first.fence + 1)
  expect(() => reopened.completeLearning(first.id, first.fence, findings())).toThrow()
  expect(reopened.createLearning({ ...start('owner-3'), retryJobId: first.id }).created).toBe(true)
})

it('does not repurchase completed no-findings through an ordinary copy of its original input', () => {
  const f = setup()
  const original = f.store.capture({
    scope,
    sessionId: 'source',
    entryId: 'input',
    parentId: null,
    rootIds: ['input'],
    branch: null,
    role: 'user',
    label: 'ordinary',
    observedAt: 1000,
    text: 'Alice owns Project.',
  })!
  const job = f.store.claimJob(f.store.createLearning(start()).job.id)
  f.store.completeLearning(job.id, job.fence, {
    outcome: { type: 'no_findings' },
    usage: { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null },
  })
  const model = { provider: 'manual', id: 'manual' }
  f.store.setPrefs({ ...f.store.snapshot().prefs, processor: model })
  expect(f.store.read(original.id, [scope]).text).toBe('Alice owns Project.')
  expect(() => f.store.createJob(scope, model)).toThrow(/eligible/)
})

it('detects tampered evidence metadata even when its replaced blob matches its new checksum', () => {
  const f = setup()
  const { job } = f.store.createLearning(start())
  const text = 'Forged source'
  const hash = createHash('sha256').update(text).digest('hex')
  const db = new DatabaseSync(join(f.directory, 'memory.sqlite'))
  try {
    db.prepare("UPDATE documents SET value=json_set(value,'$.hash',?) WHERE kind='evidence'").run(
      hash,
    )
  } finally {
    db.close()
  }
  const file = readdirSync(join(f.directory, 'evidence'))[0]!
  const id = file.split('.')[0]!
  writeFileSync(join(f.directory, 'evidence', `${id}.${hash}.txt`), text)
  expect(() => f.store.claimJob(job.id)).toThrow(/receipt|integrity/)
})
