import { afterEach, describe, expect, it } from 'vitest'
import { findings, learningFixture, prefs, scope, start, usage } from './__fixtures__/learning'

const fixtures: ReturnType<typeof learningFixture>[] = []
function setup() {
  const result = learningFixture()
  fixtures.push(result)
  return result
}
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup()
})
function complete(store: ReturnType<typeof learningFixture>['store']) {
  const input = start()
  store.createLearning(input)
  const job = store.claimJob(input.jobId)
  return store.completeLearning(job.id, job.fence, findings())
}
function coverage(store: ReturnType<typeof learningFixture>['store'], input = start()) {
  return store.learningCoverage(
    scope,
    input.checkpoint.source.sessionId,
    input.checkpoint.projectionDigest,
    input.covered,
    input.dependencyRootIds,
  )
}

describe('durable selective learning', () => {
  it('replays exact and metadata-only/forked projected input without new paid work', () => {
    const { store } = setup()
    const first = store.createLearning(start())
    expect(first.created).toBe(true)
    expect(store.createLearning(start('owner-2'))).toEqual({ job: first.job, created: false })
    const fork = start('fork-owner')
    fork.checkpoint.source.sessionId = 'fork'
    fork.checkpoint.source.sourceDigest = 'new-metadata'
    fork.checkpoint.source.contentDigest = 'fork-content'
    fork.covered[0]!.entryId = 'fork-input'
    fork.evidence[0]!.entryId = 'fork-input'
    fork.evidence[0]!.rootIds = ['fork-input']
    fork.dependencyRootIds = ['fork-input']
    expect(store.createLearning(fork)).toEqual({ job: first.job, created: false })
  })
  it('requires an explicit matching terminal retry and never reclaims failed learning implicitly', () => {
    const { store } = setup()
    const job = store.claimJob(store.createLearning(start()).job.id)
    store.failLearning(job.id, job.fence, 'failed', 'provider failure', usage)
    expect(store.createLearning(start('owner-2')).created).toBe(false)
    expect(() => store.claimJob(job.id)).toThrow()
    expect(() => store.createLearning({ ...start('owner-2'), retryJobId: 'wrong' })).toThrow()
    expect(store.createLearning({ ...start('owner-2'), retryJobId: job.id }).created).toBe(true)
    expect(store.learningDetail(job.id).job.learning?.usage).toEqual(usage)
    expect(coverage(store).covered).toEqual([])
  })
  it('admits only one active job across ordinary and learning processors', () => {
    const { store } = setup()
    store.setPrefs({ ...prefs, processor: { provider: 'manual', id: 'manual' } })
    const input = { ...start(), expectedPolicyEpoch: store.snapshot().policyEpoch }
    store.createLearning(input)
    expect(() => store.createJob('/other', { provider: 'manual', id: 'manual' })).toThrow(/active/i)
    store.updateJob(input.jobId, 0, { state: 'cancelled' })
    store.capture({
      scope: '/other',
      sessionId: 'ordinary',
      entryId: 'ordinary',
      parentId: null,
      rootIds: ['ordinary'],
      branch: null,
      role: 'user',
      label: 'ordinary',
      observedAt: 1000,
      text: 'ordinary',
    })
    store.createJob('/other', { provider: 'manual', id: 'manual' })
    expect(() =>
      store.createLearning({ ...input, jobId: 'owner-2', retryJobId: input.jobId }),
    ).toThrow(/active/i)
  })
  it('atomically saves a strict semantic proposal and coverage; rejection preserves coverage', () => {
    const { store } = setup()
    const detail = complete(store)
    expect(detail.outcome).toEqual(findings().outcome)
    expect(detail.proposalId).toBeTruthy()
    const proposal = store.snapshot().proposals[0]!
    expect(proposal.input.claims[0]).toMatchObject({ predicate: 'owns', kind: 'reported' })
    expect(proposal.input.entities.map((entity) => entity.label)).toEqual(['Alice', 'Project'])
    expect(coverage(store).covered).toEqual([
      { rootId: 'content-hash', projectedHash: 'projected-hash' },
    ])
    store.review(proposal.id, false, store.snapshot())
    expect(store.createLearning(start('owner-2')).created).toBe(false)
    expect(coverage(store).covered).toHaveLength(1)
    expect(store.learningJobs(scope).items[0]!.learning?.usage).toEqual(usage)
  })
  it('completes no_findings without fake proposals and blocks ordinary repurchase', () => {
    const { store } = setup()
    const job = store.claimJob(store.createLearning(start()).job.id)
    const detail = store.completeLearning(job.id, job.fence, {
      outcome: { type: 'no_findings' },
      usage,
    })
    expect(detail.job.state).toBe('completed')
    expect(detail.proposalId).toBeNull()
    expect(store.snapshot().proposals).toEqual([])
    store.setPrefs({ ...prefs, processor: { provider: 'manual', id: 'manual' } })
    expect(() => store.createJob(scope, { provider: 'manual', id: 'manual' })).toThrow(/eligible/)
  })
  it('rejects invalid citations and semantic fields without saving coverage or proposals', () => {
    const { store } = setup()
    const job = store.claimJob(store.createLearning(start()).job.id)
    for (const invalid of ['missing citation', 'bad predicate', 'observed assistant']) {
      const completion = findings()
      if (completion.outcome.type !== 'findings') throw new Error('fixture')
      const finding = completion.outcome.findings[0]!
      if (invalid === 'missing citation') finding.citations[0]!.quote = 'invented'
      else if (invalid === 'bad predicate') Object.assign(finding, { predicate: 'invented' })
      else {
        finding.subject.kind = 'concept'
        finding.citations[0]!.evidenceId = 'unknown'
      }
      expect(() => store.completeLearning(job.id, job.fence, completion)).toThrow()
      expect(coverage(store).covered).toEqual([])
      expect(store.snapshot().proposals).toEqual([])
    }
  })
  it('preserves failure/cancel fences and interrupts running jobs on reopen', () => {
    const { store, open } = setup()
    const job = store.claimJob(store.createLearning(start()).job.id)
    store.close()
    const reopened = open()
    expect(reopened.job(job.id).state).toBe('interrupted')
    expect(() => reopened.completeLearning(job.id, job.fence, findings())).toThrow()
    expect(() => reopened.claimJob(job.id)).toThrow()
    const retry = reopened.claimJob(
      reopened.createLearning({ ...start('owner-2'), retryJobId: job.id }).job.id,
    )
    reopened.updateJob(retry.id, retry.fence, { state: 'cancelled' })
    expect(() => reopened.failLearning(retry.id, retry.fence, 'failed', 'late', usage)).toThrow()
    expect(() => reopened.completeLearning(retry.id, retry.fence, findings())).toThrow()
    expect(coverage(reopened).covered).toEqual([])
  })
  it('gates source sessions, scope, policy and private receipts without matching the manual processor', () => {
    const { store } = setup()
    expect(() => store.createLearning({ ...start(), expectedPolicyEpoch: 0 })).toThrow()
    expect(() => store.createLearning({ ...start(), scope: '/private' })).toThrow()
    store.recordDelivery({ sessionId: 'source', evidenceIds: [], claimIds: [] })
    expect(() => coverage(store)).toThrow()
    expect(() => store.createLearning(start())).toThrow()
  })
  it('rejects unsupported provenance and tombstoned old/new input roots before inference', () => {
    const { store } = setup()
    const unsupported = start()
    unsupported.evidence[0]!.sourceType = 'branch_summary'
    expect(() => store.createLearning(unsupported)).toThrow()
    const source = store.capture({
      scope,
      sessionId: 'old',
      entryId: 'input',
      parentId: null,
      rootIds: ['input'],
      branch: null,
      role: 'user',
      label: 'source',
      observedAt: 1000,
      text: 'Alice owns Project.',
    })!
    store.forget([source.id])
    expect(() => coverage(store)).toThrow()
    expect(() => store.createLearning(start())).toThrow()
  })
  it('forgets dependent outcomes and applied claims including already-covered model context', () => {
    const { store } = setup()
    const first = complete(store)
    store.review(first.proposalId!, true, store.snapshot())
    const next = start('owner-2')
    next.checkpoint.projectionDigest = 'new-projection'
    const newSource = {
      ...next.evidence[0]!,
      entryId: 'new-input',
      entryHash: 'new-hash',
      rootId: 'new-content',
      projectedHash: 'new-projected',
      evidenceId: 'new-wire',
      rootIds: ['new-input'],
      text: 'Bob owns Project.',
    }
    const { entryId, parentId, entryHash, rootId, projectedHash } = newSource
    next.covered.push({ entryId, parentId, entryHash, rootId, projectedHash })
    next.evidence[0]!.eligible = false
    next.evidence.push(newSource)
    next.dependencyRootIds.push('new-input')
    const job = store.claimJob(store.createLearning(next).job.id)
    const completion = findings()
    if (completion.outcome.type !== 'findings') throw new Error('fixture')
    completion.outcome.findings[0]!.subject.label = 'Bob'
    completion.outcome.findings[0]!.citations = [
      { evidenceId: 'new-wire', quote: 'Bob owns Project.' },
    ]
    const second = store.completeLearning(job.id, job.fence, completion)
    store.review(second.proposalId!, true, store.snapshot())
    const original = first.job.evidenceIds[0]!
    store.forget([original])
    expect(store.snapshot().claims).toEqual([])
    expect(store.snapshot().entities).toEqual([])
    expect(store.learningDetail(job.id).outcome).toBeNull()
    expect(store.job(job.id).state).toBe('cancelled')
    expect(() => store.createLearning(next)).toThrow()
  })
  it('persists inspectable exact text and metadata but never includes original context in snapshots', () => {
    const { store, open } = setup()
    const detail = complete(store)
    const evidence = store.read(detail.job.evidenceIds[0]!, [scope])
    expect(evidence.rootIds).toEqual(['input'])
    expect(evidence.branch).toBeNull()
    expect(evidence.text).toBe('Alice owns Project.')
    expect(JSON.stringify(store.snapshot().jobs)).not.toContain('Alice owns Project.')
    store.close()
    const reopened = open()
    expect(reopened.learningDetail(detail.job.id)).toEqual(detail)
    expect(coverage(reopened).covered).toHaveLength(1)
    reopened.setPrefs({ ...prefs, enabled: false })
    expect(reopened.learningJobs(scope).items).toEqual([])
    expect(() => reopened.learningDetail(detail.job.id)).toThrow()
  })
})
