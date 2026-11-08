import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { BrainLearningRequest, BrainLearningResult } from '@phosphor/shared/brain-learning'
import type { BrainLearningHost, PreparedBrainLearning } from './learning-port'
import { adapterFixture, deferred } from './__fixtures__/adapter-fixture'
import { assembleBrainService } from './service'
import { freezeLearningSource } from './learning-source'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function sourceFixture(workspacePath: string, sessionPath: string) {
  const text =
    [
      { type: 'session', version: 3, id: 'source', cwd: workspacePath },
      {
        type: 'message',
        id: 'original-input',
        parentId: null,
        message: { role: 'user', content: 'Atlas depends on Mercury.' },
      },
    ]
      .map((item) => JSON.stringify(item))
      .join('\n') + '\n'
  await writeFile(sessionPath, text)
  return freezeLearningSource(text, { sessionId: 'source', selectedLeafId: 'original-input' })
    .source
}
async function fixture() {
  const f = await adapterFixture()
  cleanups.push(f.cleanup)
  await f.store.setPrefs({ ...(await f.store.snapshot()).prefs, processor: null })
  const target = { workspacePath: f.scope, sessionPath: join(f.root, 'source.jsonl') }
  const source = await sourceFixture(target.workspacePath, target.sessionPath)
  const covered = source.entries.map((entry) => ({
    ...entry,
    projectedHash: createHash('sha256').update('projected').digest('hex'),
  }))
  const evidence = [
    {
      ...covered[0]!,
      evidenceId: 'wire',
      role: 'user' as const,
      sourceType: 'message',
      eligible: true,
      rootIds: ['original-input'],
      text: 'Atlas depends on Mercury.',
    },
  ]
  const binding = {
    provider: 'openai',
    modelId: 'source-model',
    api: 'responses',
    authMode: 'oauth' as const,
    accountId: 'source-slot',
    thinkingLevel: 'high' as const,
    endpoint: 'https://synthetic.invalid',
  }
  const checkpoint = { source, covered, rootIds: ['original-input'], projectionDigest: 'projected' }
  const released = vi.fn(async () => {})
  const output = (request: BrainLearningRequest): BrainLearningResult => ({
    version: 1,
    jobId: request.jobId,
    binding,
    checkpoint,
    evidence,
    outcome: { type: 'no_findings' },
    usage: { input: 12, output: 3, cacheRead: 9, cacheWrite: 0, reasoning: null },
    execution: {
      logicalGenerations: 1,
      networkAttempts: null,
      serializedPrefixIdentical: false,
      cacheReuse: 'best-effort',
      history: 'pi-projected-context',
    },
  })
  const run = vi.fn(async (request: BrainLearningRequest) => output(request))
  const prepared: PreparedBrainLearning = {
    scope: f.scope,
    branch: 'main',
    binding,
    checkpoint,
    evidence,
    authIdentityFence: 'identity-epoch',
    maxOutputTokens: 1000,
    run,
    dispose: released,
  }
  const host: BrainLearningHost = { prepare: vi.fn(async () => prepared) }
  const service = await assembleBrainService({ ...f.options, learningHost: host }, f.store)
  cleanups.push(service.dispose)
  return { ...f, service, target, run, released, output }
}

it('runs source-model learning through real worker persistence with no manual processor selection', async () => {
  const f = await fixture(),
    api = f.service.api
  const preview = await api.learnPreview(f.target)
  expect(f.run).not.toHaveBeenCalled()
  expect(preview).toMatchObject({
    branch: 'main',
    newCount: 1,
    binding: { modelId: 'source-model', authMode: 'oauth' },
  })
  const job = await api.learn(f.target, {
    policyEpoch: preview.policyEpoch,
    fingerprint: preview.fingerprint,
  })
  await vi.waitFor(async () =>
    expect((await api.learningDetail(job.id)).job.state).toBe('completed'),
  )
  expect((await api.learningJobs()).items.map((item) => item.id)).toContain(job.id)
  expect(await api.learningDetail(job.id)).toMatchObject({
    outcome: { type: 'no_findings' },
    proposalId: null,
    job: { learning: { usage: { input: 12, cacheRead: 9 } } },
  })
  const again = await api.learnPreview(f.target)
  expect(again).toMatchObject({ newCount: 0, previousJobId: job.id })
  await api.learn(f.target, { policyEpoch: again.policyEpoch, fingerprint: again.fingerprint })
  expect(f.run).toHaveBeenCalledTimes(1)
})
it('revokes a pending learning generation before disabling consent and rejects late completion', async () => {
  const f = await fixture(),
    api = f.service.api
  const preview = await api.learnPreview(f.target),
    blocked = deferred<BrainLearningResult>()
  f.run.mockImplementation(() => blocked.promise)
  const job = await api.learn(f.target, {
    policyEpoch: preview.policyEpoch,
    fingerprint: preview.fingerprint,
  })
  await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1))
  const prefs = (await f.store.snapshot()).prefs
  await api.setPrefs({ ...prefs, enabled: false })
  blocked.resolve(f.output(f.run.mock.calls[0]![0]))
  expect((await f.store.job(job.id)).state).toBe('cancelled')
  expect((await f.store.snapshot()).counts.claims).toBe(0)
  expect(f.released).toHaveBeenCalledTimes(2)
})
