import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import type { BrainLearningDetail, BrainLearningStart } from '@phosphor/shared/brain-learning-jobs'
import { findings, learningFixture, prefs, scope, start, usage } from './__fixtures__/learning'
import { identifier } from './data'

const fixtures: ReturnType<typeof learningFixture>[] = []
function setup() {
  const fixture = learningFixture()
  fixtures.push(fixture)
  return fixture
}
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup()
})
function noFindings(f: ReturnType<typeof learningFixture>, input: BrainLearningStart) {
  const job = f.store.claimJob(f.store.createLearning(input).job.id)
  return f.store.completeLearning(job.id, job.fence, { outcome: { type: 'no_findings' }, usage })
}

it.each([false, true])(
  'retains readable outcome citations after review approve=%s and reopen at a Unicode chunk boundary',
  (approve) => {
    const f = setup(),
      input = start()
    const hash = (text: string) => createHash('sha256').update(text).digest('hex')
    input.covered[0]!.rootId = hash('synthetic source content')
    input.covered[0]!.projectedHash = hash('synthetic projected content')
    input.dependencies[0]!.rootId = input.covered[0]!.rootId
    const source = input.evidence[0]!
    Object.assign(source, input.covered[0])
    source.evidenceId = `${source.rootId}:${source.projectedHash}:0:0`
    source.text = 'α'.repeat(15999) + '😀' + '界'.repeat(18000)
    const completion = findings()
    if (completion.outcome.type !== 'findings') throw new Error('fixture')
    const quote = source.text.slice(15000, 17000)
    completion.outcome.findings[0]!.citations = [{ evidenceId: source.evidenceId, quote }]
    const job = f.store.claimJob(f.store.createLearning(input).job.id)
    const detail = f.store.completeLearning(job.id, job.fence, completion)
    const expectedId = identifier(
      'evidence',
      scope,
      input.checkpoint.source.sessionId,
      identifier('learning-input', job.id, source.evidenceId, 1),
    )
    const expectedOutcome = {
      ...completion.outcome,
      findings: completion.outcome.findings.map((finding) => ({
        ...finding,
        citations: [{ evidenceId: expectedId, quote }],
      })),
    }
    expect(detail.outcome).toEqual(expectedOutcome)
    const assertReadable = (value: BrainLearningDetail, store: typeof f.store) => {
      expect(value.outcome).toEqual(expectedOutcome)
      const stored = store.read(expectedId, [scope])
      expect(stored.id).toMatch(/^[a-f0-9]{64}$/)
      expect(stored.text).toContain(quote)
      expect(stored.rootIds).toEqual(['input'])
      expect(stored.role).toBe('user')
      expect(stored.branch).toBeNull()
      expect(() => store.read(source.evidenceId, [scope])).toThrow(/Unknown evidence/)
    }
    expect(f.store.snapshot().proposals[0]!.input.claims[0]!.citations).toEqual([
      { evidenceId: expectedId, quote },
    ])
    f.store.review(detail.proposalId!, approve, f.store.snapshot())
    assertReadable(f.store.learningDetail(job.id), f.store)
    f.store.close()
    const reopened = f.open()
    // No proposal/snapshot lookup: this is the inspector's durable-outcome fallback.
    assertReadable(reopened.learningDetail(job.id), reopened)
  },
)

it('replays an older explicit retry acknowledgment to its original successor even after newer retries exist', () => {
  const f = setup()
  const a = noFindings(f, start('A'))
  const bInput = { ...start('B'), retryJobId: a.job.id }
  const b = noFindings(f, bInput)
  const cInput = { ...start('C'), retryJobId: b.job.id }
  const c = f.store.createLearning(cInput)
  expect(c.created).toBe(true)
  expect(f.store.createLearning({ ...bInput, jobId: 'replayed-A' })).toEqual({
    job: b.job,
    created: false,
  })
  expect(
    f.store
      .learningJobs(scope)
      .items.map((job) => job.id)
      .sort(),
  ).toEqual(['A', 'B', 'C'])
  expect(f.store.job(c.job.id).state).toBe('queued')
  const cJob = f.store.claimJob(c.job.id)
  f.store.completeLearning(cJob.id, cJob.fence, { outcome: { type: 'no_findings' }, usage })
  f.store.close()
  const reopened = f.open()
  expect(reopened.createLearning({ ...bInput, jobId: 'replayed-A-after-reopen' })).toEqual({
    job: b.job,
    created: false,
  })
  expect(reopened.createLearning({ ...cInput, jobId: 'replayed-B' }).job.id).toBe(c.job.id)
})

it('keeps frozen authority and current exclusion/consent fences on older retry acknowledgments', () => {
  const f = setup()
  const a = noFindings(f, start('A'))
  const bInput = { ...start('B'), retryJobId: a.job.id }
  noFindings(f, bInput)
  noFindings(f, { ...start('C'), retryJobId: 'B' })
  for (const change of ['account', 'branch', 'source', 'target', 'projection', 'policy', 'scope']) {
    const replay = { ...start(`replay-${change}`), retryJobId: a.job.id }
    if (change === 'account') replay.binding.accountId = 'other-account'
    if (change === 'branch') replay.branch = 'other-branch'
    if (change === 'source') replay.checkpoint.source.sourceDigest = 'other-source'
    if (change === 'target') replay.target.sessionPath = '/sessions/other.jsonl'
    if (change === 'projection') replay.checkpoint.projectionDigest = 'other-projection'
    if (change === 'policy') replay.expectedPolicyEpoch = 0
    if (change === 'scope') replay.scope = '/other'
    expect(() => f.store.createLearning(replay)).toThrow()
  }
  f.store.setPrefs({ ...prefs, recall: true })
  expect(() =>
    f.store.createLearning({
      ...start('refreshed-policy'),
      retryJobId: a.job.id,
      expectedPolicyEpoch: f.store.snapshot().policyEpoch,
    }),
  ).toThrow()
  f.store.recordDelivery({ sessionId: 'source', evidenceIds: [], claimIds: [] })
  expect(() => f.store.createLearning({ ...bInput, jobId: 'recipient-replay' })).toThrow(
    /recipient/,
  )
  f.store.setPrefs({ ...prefs, enabled: false })
  expect(() => f.store.createLearning({ ...bInput, jobId: 'disabled-replay' })).toThrow(/consent/i)
})
