import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { BrainExtractionRecord } from '@phosphor/shared/brain'
import { FakeBrainStore, HARBOR_JOB } from './__fixtures__/fake-store'
import { extractionView } from './extraction-view'
import { extractionAnswer } from './extraction-record'
import { transcriptAtLeaf } from './transcript'

it('bounds and scrubs source segments without including later lane changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harbor-source-'))
  try {
    const path = join(directory, 'harbor.jsonl')
    const entries = Array.from({ length: 310 }, (_, index) => ({
      type: 'message',
      id: `entry-${index}`,
      message: { role: 'user', content: `Harbor ${index} token=harbor-secret ${'x'.repeat(5000)}` },
    }))
    await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join('\n'))
    const store = new FakeBrainStore()
    const job = store.enqueue({ ...HARBOR_JOB, sessionPath: path }, 'queued')
    const record: BrainExtractionRecord = {
      jobId: job.id,
      sessionId: job.sessionId,
      sessionPath: path,
      title: job.title,
      leafId: 'entry-305',
      model: job.model,
      thinking: 'low',
      prompt: 'Harbor instruction',
      answer: '',
      trace: null,
      outcomes: [],
      error: null,
      startedAt: 0,
      finishedAt: 1,
    }
    store.saveExtraction(record)
    const source = (await extractionView(store, job.id)).source
    expect(source.segments).toHaveLength(300)
    expect(source.segments[0]?.entryId).toBe('entry-6')
    expect(source.segments.at(-1)?.entryId).toBe('entry-305')
    expect(source.segments.every((segment) => segment.text.endsWith('[segment clipped]'))).toBe(
      true,
    )
    expect(source.segments.every((segment) => segment.text.length < 4050)).toBe(true)
    expect(JSON.stringify(source)).not.toContain('harbor-secret')
    store.saveExtraction({ ...record, leafId: 'missing' })
    expect((await extractionView(store, job.id)).source).toMatchObject({
      exists: true,
      segments: [],
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('follows the clone leaf ancestry, excluding abandoned branches and guarding cycles', () => {
  const entries = [
    { id: 'first', parentId: null },
    { id: 'abandoned', parentId: 'first' },
    { id: 'forked', parentId: 'first' },
    { id: 'leaf', parentId: 'forked' },
    { id: 'later', parentId: 'leaf' },
  ]
  expect(transcriptAtLeaf(entries, 'leaf').map((entry) => entry.id)).toEqual([
    'first',
    'forked',
    'leaf',
  ])
  expect(transcriptAtLeaf([{ id: 'cycle', parentId: 'cycle' }], 'cycle')).toHaveLength(1)
})

it('scrubs before the 256 KB byte cap, marks truncation, and preserves small raw answers', () => {
  expect(extractionAnswer('Harbor raw final text')).toBe('Harbor raw final text')
  const text = 'Harbor '.repeat(38000) + 'token=harbor-secret'
  const answer = extractionAnswer(text)
  expect(Buffer.byteLength(answer)).toBeLessThan(256 * 1024 + 50)
  expect(answer.endsWith('[answer truncated at 256 KB]')).toBe(true)
  expect(answer).not.toContain('harbor-secret')
  const crossing = 'x'.repeat(256 * 1024 - 5) + '\nBearer harbor-secret-token-value'
  expect(extractionAnswer(crossing)).not.toContain('Bearer')
  expect(extractionAnswer(crossing)).not.toContain('harbor-secret')
})
