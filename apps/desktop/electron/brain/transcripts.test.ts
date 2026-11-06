import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { adapterFixture } from './__fixtures__/adapter-fixture'
import { createBrainTranscripts, readOwnedTranscript } from './transcripts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
it('keeps one immutable transcript, exposes it read-only and retries durable failed purges', async () => {
  const f = await adapterFixture(); cleanup.push(f.cleanup)
  const job = f.engine.claimJob(f.engine.createJob(f.scope, f.model, f.snapshot.policyEpoch).id)
  const session = await f.processorSession(job.id)
  f.engine.updateJob(job.id, job.fence, { sessionPath: session.path })
  expect(() => f.engine.updateJob(job.id, job.fence, { sessionPath: join(f.directory, 'other.jsonl') })).toThrow('immutable')
  const transcripts = createBrainTranscripts(f.options, f.store, join(f.directory, 'sessions'), async () => {})
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
  const f = await adapterFixture(); cleanup.push(f.cleanup)
  const sessionDir = join(f.directory, 'sessions'); await mkdir(sessionDir)
  const outside = join(f.root, 'recipient.jsonl')
  await writeFile(outside, '{"type":"message","message":{"role":"user","content":"private"}}\n')
  const link = join(sessionDir, 'link.jsonl'); await symlink(outside, link)
  await expect(readOwnedTranscript(link, 'job', sessionDir)).rejects.toThrow('Unsafe')
  const ordinary = join(sessionDir, 'ordinary.jsonl')
  await writeFile(ordinary, await readFile(outside))
  await expect(readOwnedTranscript(ordinary, 'job', sessionDir)).rejects.toThrow('ownership')
  expect(await readFile(outside, 'utf8')).toContain('private')
})
it('rejects oversized processor transcript input', async () => {
  const f = await adapterFixture(); cleanup.push(f.cleanup)
  const sessionDir = join(f.directory, 'sessions'); await mkdir(sessionDir)
  const path = join(sessionDir, 'oversize.jsonl'); await writeFile(path, 'x'.repeat(2_000_001))
  await expect(readOwnedTranscript(path, 'job', sessionDir)).rejects.toThrow('Unsafe')
})
