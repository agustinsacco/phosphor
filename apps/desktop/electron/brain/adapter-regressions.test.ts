import { afterEach, expect, it, vi } from 'vitest'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { adapterFixture } from './__fixtures__/adapter-fixture'
import { createBrainTranscripts } from './transcripts'
import { laneAuthority } from './authority'
import { execFileSync } from 'node:child_process'
import { createBrainProcessor } from './processor'
import { createBrainBridge } from './bridge'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close() })
it('canonicalizes a nested main-checkout lane to the enrolled repository root', async () => {
  const f = await adapterFixture(); cleanup.push(f.cleanup)
  const child = join(f.scope, 'nested')
  await mkdir(child)
  expect((await laneAuthority(child)).scope).toBe(f.scope)
  const worktree = join(f.root, 'worktree')
  execFileSync('git', ['-C', f.scope, 'worktree', 'add', '-b', 'feature', worktree], { stdio: 'ignore' })
  expect(await laneAuthority(worktree)).toEqual({ scope: f.scope, branch: 'feature' })
})
it('does not acknowledge a missing purge path outside the owned transcript directory', async () => {
  const f = await adapterFixture(); cleanup.push(f.cleanup)
  const job = f.engine.claimJob(f.engine.createJob(f.scope, f.model, f.snapshot.policyEpoch).id)
  f.engine.updateJob(job.id, job.fence, { sessionPath: join(f.root, 'outside-missing.jsonl') })
  f.engine.forget([f.evidence.id])
  const sessionDir = join(f.directory, 'sessions'); await mkdir(sessionDir)
  const transcripts = createBrainTranscripts(f.options, f.store, sessionDir, async () => {})
  await transcripts.purge()
  expect(f.engine.pendingPurges()).toHaveLength(1)
})
it('requires persisted processor ownership before sending any inference prompt', async () => {
  const f = await adapterFixture(); cleanup.push(f.cleanup)
  const bridge = await createBrainBridge({ allowed: async () => false, invoke: async () => undefined })
  cleanup.push(() => bridge.close())
  let requests: ReturnType<typeof vi.fn> | undefined
  vi.mocked(f.options.sessions.create).mockImplementation(async (_options, _delivery, execution) => {
    const session = await f.processorSession(execution!.brain!.owner.jobId)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(session.path, '{"type":"message","message":{"role":"user","content":"foreign"}}\n')
    requests = session.client.request
    return { sessionId: session.live.sessionId, workspacePath: '/isolated' }
  })
  const processor = createBrainProcessor(f.options, f.store, bridge, join(f.directory, 'sessions'))
  cleanup.push(() => processor.dispose())
  const job = await processor.process(f.scope, { model: f.model, policyEpoch: f.snapshot.policyEpoch })
  await vi.waitFor(() => expect(f.engine.job(job.id).state).toBe('failed'))
  expect(requests?.mock.calls.some(([command]) => command.type === 'prompt')).toBe(false)
})
