import { describe, expect, it, vi } from 'vitest'
import type { BrainJob, BrainSnapshot } from '@phosphor/shared/brain'
import type { BrainLearningRequest } from '@phosphor/shared/brain-learning'
import type { BrainLearningStart } from '@phosphor/shared/brain-learning-jobs'
import type { PreparedBrainLearning } from './learning-port'
import { createBrainLearning } from './learning-coordinator'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function sourceFixture() {
  const target = { workspacePath: '/synthetic/workspace', sessionPath: '/synthetic/session.jsonl' }
  const pair = { rootId: 'root-hash', projectedHash: 'projection-hash' }
  const entry = { ...pair, entryId: 'input', parentId: null, entryHash: 'entry-hash' }
  const binding = {
    provider: 'openai-codex',
    modelId: 'synthetic',
    api: 'responses',
    accountId: 'current-slot',
    authMode: 'oauth' as const,
    thinkingLevel: 'high' as const,
    endpoint: 'https://synthetic.invalid',
  }
  const checkpoint = {
    source: {
      sessionId: 'original',
      selectedLeafId: 'leaf',
      sourceDigest: 'source',
      contentDigest: 'content',
      entries: [entry],
    },
    projectionDigest: 'projected',
    covered: [entry],
    rootIds: ['input'],
  }
  const evidence = [
    {
      ...entry,
      evidenceId: 'text',
      role: 'user' as const,
      text: 'Original fact',
      sourceType: 'message',
      eligible: true,
      rootIds: ['input'],
    },
  ]
  const snapshot = {
    prefs: { enabled: true, workspaces: [target.workspacePath], processor: null },
    policyEpoch: 2,
    graphRevision: 3,
  } as BrainSnapshot
  const job: BrainJob = {
    id: 'job',
    scope: target.workspacePath,
    evidenceIds: [],
    model: { provider: binding.provider, id: binding.modelId },
    state: 'running',
    fence: 1,
    createdAt: 1,
    updatedAt: 1,
    sessionPath: null,
    error: null,
    policyEpoch: 2,
    graphRevision: 3,
  }
  return { target, pair, checkpoint, evidence, snapshot, job, binding }
}
function requestFixture({ checkpoint, evidence }: ReturnType<typeof sourceFixture>) {
  const run = vi.fn(async (request: BrainLearningRequest) => ({
    version: 1 as const,
    jobId: request.jobId,
    binding: request.binding,
    checkpoint,
    evidence: evidence.map((item) => ({
      ...item,
      eligible: !request.alreadyCovered.some(
        (old) => old.rootId === item.rootId && old.projectedHash === item.projectedHash,
      ),
    })),
    outcome: { type: 'no_findings' as const },
    usage: { input: 9, output: 4, cacheRead: null, cacheWrite: null, reasoning: null },
    execution: {
      logicalGenerations: 1 as const,
      networkAttempts: null,
      serializedPrefixIdentical: false as const,
      cacheReuse: 'best-effort' as const,
      history: 'pi-projected-context' as const,
    },
  }))
  return run
}
function storeFixture(
  { snapshot, job }: ReturnType<typeof sourceFixture>,
  done: ReturnType<typeof deferred<void>>,
) {
  return {
    snapshot: vi.fn(async () => structuredClone(snapshot)),
    learningCoverage: vi.fn(async () => ({
      covered: [] as ReturnType<typeof sourceFixture>['pair'][],
      previousJobId: null as string | null,
    })),
    createLearning: vi.fn(async (_input: BrainLearningStart) => ({ job, created: true })),
    claimJob: vi.fn(async () => job),
    completeLearning: vi.fn(async () => {
      done.resolve()
      return { job, outcome: null, proposalId: null }
    }),
    failLearning: vi.fn(async () => {
      done.resolve()
      return job
    }),
    learningDetail: vi.fn(async () => ({ job, outcome: null, proposalId: null })),
    learningJobs: vi.fn(async () => ({ items: [], truncated: false })),
  }
}
function setup() {
  const fixture = sourceFixture()
  const { target, pair, checkpoint, evidence, snapshot, job, binding } = fixture
  const done = deferred<void>(),
    run = requestFixture(fixture)
  const dispose = vi.fn(async () => {})
  const prepared: PreparedBrainLearning = {
    scope: target.workspacePath,
    branch: null,
    binding,
    maxOutputTokens: 1024,
    authIdentityFence: 'account-identity-epoch',
    checkpoint,
    evidence,
    run,
    dispose,
  }
  const host = { prepare: vi.fn(async () => structuredClonePrepared()) }
  function structuredClonePrepared() {
    return {
      ...structuredClone({ ...prepared, run: undefined, dispose: undefined }),
      run,
      dispose,
    } as PreparedBrainLearning
  }
  const store = storeFixture(fixture, done)
  const authority = vi.fn(async () => ({
    scope: target.workspacePath,
    branch: null as string | null,
  }))
  const report = vi.fn()
  const learning = createBrainLearning({
    store,
    host,
    authority,
    canonicalTarget: async (value) => value,
    jobId: () => 'job',
    now: () => 10,
    report,
  })
  const consent = async () => {
    const preview = await learning.preview(target)
    return { policyEpoch: preview.policyEpoch, fingerprint: preview.fingerprint }
  }
  return {
    learning,
    target,
    prepared,
    host,
    store,
    snapshot,
    job,
    run,
    dispose,
    authority,
    report,
    consent,
    done,
    pair,
  }
}

describe('selected lane learning coordinator', () => {
  it('previews source-model consent without inference, then starts one private generation', async () => {
    const f = setup()
    const consent = await f.consent()
    expect(f.run).not.toHaveBeenCalled()
    expect(f.dispose).toHaveBeenCalledTimes(1)
    await expect(f.learning.start(f.target, consent)).resolves.toBe(f.job)
    await f.done.promise
    await f.learning.dispose()
    expect(f.run).toHaveBeenCalledTimes(1)
    expect(f.run.mock.calls[0]?.[0]).toMatchObject({
      jobId: 'job',
      maxOutputTokens: 1024,
      binding: { authMode: 'oauth', accountId: 'current-slot' },
    })
    expect(f.store.completeLearning).toHaveBeenCalledWith('job', 1, {
      outcome: { type: 'no_findings' },
      usage: { input: 9, output: 4, cacheRead: null, cacheWrite: null, reasoning: null },
    })
    expect(f.dispose).toHaveBeenCalledTimes(2)
  })
  it.each(['binding', 'source', 'branch', 'policy', 'authIdentity'] as const)(
    'refuses changed %s before inference',
    async (change) => {
      const f = setup(),
        consent = await f.consent()
      if (change === 'binding') f.prepared.binding.accountId = 'different'
      if (change === 'source') f.prepared.checkpoint.source.sourceDigest = 'changed'
      if (change === 'branch')
        f.authority.mockResolvedValue({ scope: f.target.workspacePath, branch: 'changed' })
      if (change === 'policy') f.snapshot.policyEpoch++
      if (change === 'authIdentity') f.prepared.authIdentityFence = 'replaced-account-same-slot'
      await expect(f.learning.start(f.target, consent)).rejects.toThrow()
      expect(f.run).not.toHaveBeenCalled()
      expect(f.store.createLearning).not.toHaveBeenCalled()
    },
  )
  it('reuses an existing attempt without invoking the model or relabelling review as processing', async () => {
    const f = setup(),
      consent = await f.consent()
    f.store.createLearning.mockResolvedValue({ job: f.job, created: false })
    await expect(f.learning.start(f.target, consent)).resolves.toBe(f.job)
    expect(f.run).not.toHaveBeenCalled()
    expect(f.dispose).toHaveBeenCalledTimes(2)
  })
  it('keeps covered context but only explicit reprocessing makes it eligible again', async () => {
    const f = setup()
    f.store.learningCoverage.mockResolvedValue({ covered: [f.pair], previousJobId: 'previous' })
    const preview = await f.learning.preview(f.target)
    expect(preview).toMatchObject({ newCount: 0, coveredCount: 1, previousJobId: 'previous' })
    await f.learning.start(f.target, {
      policyEpoch: preview.policyEpoch,
      fingerprint: preview.fingerprint,
      retryJobId: 'previous',
    })
    await f.done.promise
    await f.learning.dispose()
    expect(f.run.mock.calls[0]?.[0].alreadyCovered).toEqual([])
    expect(f.store.createLearning.mock.calls[0]?.[0]).toMatchObject({
      retryJobId: 'previous',
      evidence: [{ eligible: true }],
    })
  })
  it('keeps the source account and checkpoint frozen while a generation is pending', async () => {
    const f = setup(),
      consent = await f.consent(),
      blocked = deferred<Awaited<ReturnType<typeof f.run>>>()
    const output = await f.run({
      binding: f.prepared.binding,
      jobId: 'job',
      alreadyCovered: [],
    } as unknown as BrainLearningRequest)
    f.run.mockClear()
    f.run.mockImplementation(() => blocked.promise)
    await f.learning.start(f.target, consent)
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1))
    output.binding = { ...f.prepared.binding, accountId: 'forged' }
    blocked.resolve(output)
    await f.done.promise
    await f.learning.dispose()
    expect(f.store.completeLearning).not.toHaveBeenCalled()
    expect(f.store.failLearning).toHaveBeenCalledWith('job', 1, 'failed', expect.any(String), {
      input: 9,
      output: 4,
      cacheRead: null,
      cacheWrite: null,
      reasoning: null,
    })
  })
  it('cancels a noncooperative request and refuses its late result', async () => {
    const f = setup(),
      consent = await f.consent(),
      blocked = deferred<Awaited<ReturnType<typeof f.run>>>()
    f.run.mockImplementation(() => blocked.promise)
    await f.learning.start(f.target, consent)
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1))
    await f.learning.cancel('job')
    await f.learning.dispose()
    expect(f.dispose).toHaveBeenCalledTimes(2)
    expect(f.store.completeLearning).not.toHaveBeenCalled()
    expect(f.store.failLearning).toHaveBeenCalledWith(
      'job',
      1,
      'cancelled',
      expect.any(String),
      null,
    )
  })
  it.each(['preview', 'revoke', 'dispose'] as const)(
    'retries an owned failed cleanup through %s',
    async (operation) => {
      const f = setup()
      f.dispose.mockRejectedValueOnce(new Error('transient cleanup failure'))
      await expect(f.learning.preview(f.target)).rejects.toThrow('transient cleanup failure')
      expect(f.dispose).toHaveBeenCalledTimes(1)
      if (operation === 'preview') {
        await expect(f.learning.preview(f.target)).resolves.toMatchObject({ newCount: 1 })
        expect(f.dispose).toHaveBeenCalledTimes(3)
      } else {
        await f.learning[operation]()
        expect(f.dispose).toHaveBeenCalledTimes(2)
      }
      expect(f.run).not.toHaveBeenCalled()
    },
  )
  it('does not cache a failed preview and refuses an unenrolled target before private startup', async () => {
    const f = setup()
    f.host.prepare.mockRejectedValueOnce(new Error('first attempt'))
    await expect(f.learning.preview(f.target)).rejects.toThrow('first attempt')
    await expect(f.learning.preview(f.target)).resolves.toMatchObject({ newCount: 1 })
    f.snapshot.prefs.workspaces = []
    await expect(f.learning.preview(f.target)).rejects.toThrow()
    expect(f.host.prepare).toHaveBeenCalledTimes(2)
    expect(f.run).not.toHaveBeenCalled()
  })
  it.each(['preview', 'start'] as const)(
    'shutdown waits for late %s preparation and purges it',
    async (operation) => {
      const f = setup(),
        consent = await f.consent()
      const blocked = deferred<PreparedBrainLearning>()
      f.host.prepare.mockImplementation(() => blocked.promise)
      const pending = (
        operation === 'preview' ? f.learning.preview(f.target) : f.learning.start(f.target, consent)
      ).then(
        () => null,
        (error: unknown) => error,
      )
      await vi.waitFor(() => expect(f.host.prepare).toHaveBeenCalledTimes(2))
      let closed = false
      const closing = f.learning.dispose().then(() => {
        closed = true
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(closed).toBe(false)
      blocked.resolve(f.prepared)
      expect(await pending).toBeInstanceOf(Error)
      await closing
      expect(f.dispose).toHaveBeenCalledTimes(2)
      expect(f.run).not.toHaveBeenCalled()
      expect(f.store.createLearning).not.toHaveBeenCalled()
    },
  )
  it('retains only safe known response usage on failure without completion or retry', async () => {
    const f = setup(),
      consent = await f.consent()
    const usage = { input: 10, output: 2, cacheRead: null, cacheWrite: null, reasoning: null }
    f.run.mockRejectedValue(
      Object.assign(new Error('invalid JSON'), { learningUsage: usage, secret: 'never stored' }),
    )
    await f.learning.start(f.target, consent)
    await f.done.promise
    await f.learning.dispose()
    expect(f.store.failLearning).toHaveBeenCalledWith('job', 1, 'failed', 'invalid JSON', usage)
    expect(f.store.completeLearning).not.toHaveBeenCalled()
    expect(f.run).toHaveBeenCalledTimes(1)
  })
})
