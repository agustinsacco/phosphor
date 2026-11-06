import { EventEmitter } from 'node:events'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { LiveSession } from '@phosphor/session-runtime/pi/session-registry'
import type { PiRpcClient } from '@phosphor/session-runtime/pi/rpc-client'
import { adapterFixture, deferred } from './__fixtures__/adapter-fixture'
import { createBrainBridge, type BrainCapability } from './bridge'
import { createBrainProcessor } from './processor'
import { createBrainTranscripts } from './transcripts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const marker = (jobId: unknown) => ({
  type: 'custom',
  customType: 'phosphor-brain-owner',
  data: { kind: 'brain', jobId },
})

async function fixture() {
  const f = await adapterFixture()
  cleanup.push(f.cleanup)
  const sessionDir = join(f.directory, 'sessions')
  await mkdir(sessionDir)
  const bridge = await createBrainBridge({
    allowed: async () => false,
    invoke: async () => undefined,
  })
  cleanup.push(() => bridge.close())
  const processor = createBrainProcessor(f.options, f.store, bridge, sessionDir)
  cleanup.push(() => processor.dispose())
  let path = join(sessionDir, 'buffered.jsonl')
  let entries: unknown[] | undefined
  const gate = deferred<void>()
  let gated = false
  const client = Object.assign(new EventEmitter(), {
    alive: true,
    request: vi.fn(async (command: { type: string }) => {
      if (command.type === 'get_entries') {
        if (gated) await gate.promise
        return { success: true, data: { entries } }
      }
      if (command.type === 'get_state')
        return {
          success: true,
          data: { model: f.model, sessionFile: path, sessionId: 'native-buffered' },
        }
      return { success: true }
    }),
  })
  let live: LiveSession | undefined
  vi.mocked(f.options.sessions.create).mockImplementation(
    async (_options, _delivery, execution) => {
      const jobId = execution!.brain!.owner.jobId
      entries ??= [marker(jobId)]
      entries = entries.map((entry) =>
        (entry as { data?: { jobId?: unknown } } | null)?.data?.jobId === 'matching'
          ? { ...(entry as object), data: { kind: 'brain', jobId } }
          : entry,
      )
      live = {
        sessionId: 'buffered',
        workspacePath: '/isolated',
        owner: { kind: 'brain', jobId },
        client: client as unknown as PiRpcClient,
      }
      f.lives.set(live.sessionId, live)
      return { sessionId: live.sessionId, workspacePath: live.workspacePath }
    },
  )
  return {
    ...f,
    processor,
    sessionDir,
    client,
    gate,
    get live() {
      return live!
    },
    get path() {
      return path
    },
    setPath(value: string) {
      path = value
    },
    setEntries(value: unknown[]) {
      entries = value
    },
    blockEntries() {
      gated = true
    },
    start: () =>
      processor.process(f.scope, { model: f.model, policyEpoch: f.snapshot.policyEpoch }),
  }
}
it('admits a live owned marker before pi writes its planned transcript, without creating a file', async () => {
  const f = await fixture()
  const job = await f.start()
  await vi.waitFor(() =>
    expect(f.client.request.mock.calls.some(([command]) => command.type === 'prompt')).toBe(true),
  )
  expect(f.options.processor.verifyTools).toHaveBeenCalledWith(f.live)
  expect(f.engine.job(job.id).sessionPath).toBe(f.path)
  await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
  const capability: BrainCapability = {
    kind: 'processor',
    scope: f.scope,
    policyEpoch: job.policyEpoch,
    jobId: job.id,
    fence: job.fence,
    sessionId: f.live.sessionId,
  }
  await expect(f.processor.invoke(capability, 'job', {})).resolves.toMatchObject({
    evidence: [{ id: f.evidence.id }],
  })
  await f.processor.cancel(job.id)
  const transcripts = createBrainTranscripts(f.options, f.store, f.sessionDir, f.processor.cancel)
  await expect(transcripts.read(job.id)).rejects.toThrow('not been written yet')
  f.engine.forget([f.evidence.id])
  await transcripts.purge()
  expect(f.engine.pendingPurges()).toEqual([])
  await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
})
it.each([
  { entries: [] },
  { entries: [marker('foreign')] },
  { entries: [marker(null)] },
  { entries: [marker('matching'), marker('foreign')] },
  { entries: [{ ...marker('matching'), type: 'message' }] },
])('refuses absent, foreign or malformed live ownership: $entries', async ({ entries }) => {
  const f = await fixture()
  f.setEntries(entries)
  const job = await f.start()
  await vi.waitFor(() => expect(f.engine.job(job.id).state).toBe('failed'))
  expect(f.engine.job(job.id).error).toContain('ownership')
  expect(f.engine.job(job.id).sessionPath).toBeNull()
  expect(f.client.request.mock.calls.some(([command]) => command.type === 'prompt')).toBe(false)
})
it('does not bind or prompt when cancellation wins while live ownership is pending', async () => {
  const f = await fixture()
  f.blockEntries()
  const job = await f.start()
  await vi.waitFor(() =>
    expect(f.client.request.mock.calls.some(([command]) => command.type === 'get_entries')).toBe(
      true,
    ),
  )
  await f.processor.cancel(job.id)
  f.gate.resolve()
  await f.processor.dispose()
  expect(f.engine.job(job.id).state).toBe('cancelled')
  expect(f.engine.job(job.id).sessionPath).toBeNull()
  expect(f.client.request.mock.calls.some(([command]) => command.type === 'prompt')).toBe(false)
})
it.each([
  'outside',
  'symlink-parent',
  'symlink-file',
  'ordinary-directory',
  'foreign-existing',
] as const)('denies unsafe or foreign planned transcript: %s', async (kind) => {
  const f = await fixture()
  const outside = join(f.root, 'outside')
  await mkdir(outside)
  if (kind === 'outside') f.setPath(join(outside, 'missing.jsonl'))
  if (kind === 'symlink-parent') {
    const link = join(f.sessionDir, 'link')
    await symlink(outside, link)
    f.setPath(join(link, 'missing.jsonl'))
  }
  if (kind === 'symlink-file') await symlink(join(outside, 'missing.jsonl'), f.path)
  if (kind === 'ordinary-directory') await mkdir(f.path)
  if (kind === 'foreign-existing') await writeFile(f.path, JSON.stringify(marker('foreign')) + '\n')
  const job = await f.start()
  await vi.waitFor(() => expect(f.engine.job(job.id).state).toBe('failed'))
  expect(f.engine.job(job.id).sessionPath).toBeNull()
  expect(f.client.request.mock.calls.some(([command]) => command.type === 'prompt')).toBe(false)
})
