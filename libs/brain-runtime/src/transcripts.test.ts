import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { adapterFixture } from './__fixtures__/adapter-fixture'
import { createBrainTranscripts, readOwnedTranscript } from './transcripts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
it('keeps one immutable transcript, exposes it read-only and retries durable failed purges', async () => {
  const f = await adapterFixture()
  cleanup.push(f.cleanup)
  const job = f.engine.claimJob(f.engine.createJob(f.scope, f.model, f.snapshot.policyEpoch).id)
  const session = await f.processorSession(job.id)
  f.engine.updateJob(job.id, job.fence, { sessionPath: session.path })
  expect(() =>
    f.engine.updateJob(job.id, job.fence, { sessionPath: join(f.directory, 'other.jsonl') }),
  ).toThrow('immutable')
  const transcripts = createBrainTranscripts(
    f.options,
    f.store,
    join(f.directory, 'sessions'),
    async () => {},
  )
  const before = await readFile(session.path, 'utf8')
  expect(await transcripts.read(job.id)).toBe(before)
  expect(await readFile(session.path, 'utf8')).toBe(before)
  f.engine.forget([f.evidence.id])
  vi.mocked(f.options.sessions.disposeBrain).mockRejectedValueOnce(new Error('Stop failed'))
  await transcripts.purge()
  expect(f.engine.pendingPurges()).toHaveLength(1)
  expect(await readFile(session.path, 'utf8')).toBe(before)
  await transcripts.purge()
  expect(f.engine.pendingPurges()).toEqual([])
  await expect(readFile(session.path)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('rejects symlink escapes and refuses ordinary recipient transcript deletion', async () => {
  const f = await adapterFixture()
  cleanup.push(f.cleanup)
  const sessionDir = join(f.directory, 'sessions')
  await mkdir(sessionDir)
  const outside = join(f.root, 'recipient.jsonl')
  await writeFile(outside, '{"type":"message","message":{"role":"user","content":"private"}}\n')
  const link = join(sessionDir, 'link.jsonl')
  await symlink(outside, link)
  await expect(readOwnedTranscript(link, 'job', sessionDir)).rejects.toThrow('Unsafe')
  const ordinary = join(sessionDir, 'ordinary.jsonl')
  await writeFile(ordinary, await readFile(outside))
  await expect(readOwnedTranscript(ordinary, 'job', sessionDir)).rejects.toThrow('ownership')
  expect(await readFile(outside, 'utf8')).toContain('private')
})
it('rejects oversized processor transcript input', async () => {
  const f = await adapterFixture()
  cleanup.push(f.cleanup)
  const sessionDir = join(f.directory, 'sessions')
  await mkdir(sessionDir)
  const path = join(sessionDir, 'oversize.jsonl')
  await writeFile(path, 'x'.repeat(2_000_001))
  await expect(readOwnedTranscript(path, 'job', sessionDir)).rejects.toThrow('Unsafe')
})
it('keeps unsafe missing-parent and symlink-parent purge records pending', async () => {
  const f = await adapterFixture()
  cleanup.push(f.cleanup)
  const sessionDir = join(f.directory, 'sessions')
  await mkdir(sessionDir)
  const job = f.engine.claimJob(f.engine.createJob(f.scope, f.model, f.snapshot.policyEpoch).id)
  const path = join(sessionDir, 'missing-parent', 'missing.jsonl')
  f.engine.updateJob(job.id, job.fence, { sessionPath: path })
  f.engine.forget([f.evidence.id])
  const transcripts = createBrainTranscripts(f.options, f.store, sessionDir, async () => {})
  await transcripts.purge()
  expect(f.engine.pendingPurges()).toHaveLength(1)
  await symlink(f.root, join(sessionDir, 'missing-parent'))
  await transcripts.purge()
  expect(f.engine.pendingPurges()).toHaveLength(1)
})
it('accepts only real nested parents for a missing planned leaf and checks ownership once it exists', async () => {
  const f = await adapterFixture()
  cleanup.push(f.cleanup)
  const sessionDir = join(f.directory, 'sessions')
  const parent = join(sessionDir, 'nested')
  await mkdir(parent, { recursive: true })
  const path = join(parent, 'buffered.jsonl')
  await expect(readOwnedTranscript(path, 'job', sessionDir)).rejects.toThrow('not been written yet')
  await writeFile(
    path,
    '{"type":"custom","customType":"phosphor-brain-owner","data":{"kind":"brain","jobId":"foreign"}}\n',
  )
  await expect(readOwnedTranscript(path, 'job', sessionDir)).rejects.toThrow('ownership')
  await symlink(parent, join(sessionDir, 'alias'))
  await expect(
    readOwnedTranscript(join(sessionDir, 'alias', 'missing.jsonl'), 'job', sessionDir),
  ).rejects.toThrow('Unsafe')
})
it.each(['multiple', 'single'])(
  'purges an oversized owned %s-record transcript without using display bounds',
  async (shape) => {
    const f = await adapterFixture()
    cleanup.push(f.cleanup)
    const job = f.engine.claimJob(f.engine.createJob(f.scope, f.model, f.snapshot.policyEpoch).id)
    const session = await f.processorSession(job.id)
    f.engine.updateJob(job.id, job.fence, { sessionPath: session.path })
    const count = shape === 'multiple' ? 13 : 1
    const row = JSON.stringify({
      type: 'message',
      message: { role: 'assistant', content: '漢'.repeat(shape === 'multiple' ? 54000 : 750000) },
    })
    const owner = JSON.stringify({
      data: { jobId: job.id, kind: 'brain' },
      customType: 'phosphor-brain-owner',
      type: 'custom',
    })
    await writeFile(
      session.path,
      owner + '\n' + Array.from({ length: count }, () => row).join('\n') + '\n',
    )
    const transcripts = createBrainTranscripts(
      f.options,
      f.store,
      join(f.directory, 'sessions'),
      async () => {},
    )
    await expect(transcripts.read(job.id)).rejects.toThrow()
    f.engine.forget([f.evidence.id])
    await transcripts.purge()
    expect(f.engine.pendingPurges()).toEqual([])
    await expect(readFile(session.path)).rejects.toMatchObject({ code: 'ENOENT' })
  },
)
it('retains an oversized transcript and durable purge when a later real owner conflicts', async () => {
  const f = await adapterFixture()
  cleanup.push(f.cleanup)
  const job = f.engine.claimJob(f.engine.createJob(f.scope, f.model, f.snapshot.policyEpoch).id)
  const session = await f.processorSession(job.id)
  f.engine.updateJob(job.id, job.fence, { sessionPath: session.path })
  const owner = (jobId: string) =>
    JSON.stringify({
      type: 'custom',
      customType: 'phosphor-brain-owner',
      data: { kind: 'brain', jobId },
    })
  await writeFile(
    session.path,
    owner(job.id) +
      '\n' +
      JSON.stringify({ type: 'message', message: { content: 'x'.repeat(2_100_000) } }) +
      '\n' +
      owner('foreign') +
      '\n',
  )
  f.engine.forget([f.evidence.id])
  const transcripts = createBrainTranscripts(
    f.options,
    f.store,
    join(f.directory, 'sessions'),
    async () => {},
  )
  await transcripts.purge()
  expect(f.engine.pendingPurges()).toHaveLength(1)
  expect((await readFile(session.path)).length).toBeGreaterThan(2_000_000)
})
