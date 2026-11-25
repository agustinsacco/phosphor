import { appendFile, unlink, writeFile } from 'node:fs/promises'
import { afterEach, expect, it } from 'vitest'
import { CallTracer } from './call-trace'
import { pipelineSetup, answerFor } from './__fixtures__/pipeline'
import { extractJob } from './extract'
import { extractionView } from './extraction-view'
import { extractionAnswer } from './extraction-record'
import { transcriptAtLeaf } from './transcript'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const f of cleanups.splice(0)) await f()
})
it('rebuilds exact per-call prompts on demand at the frozen leaf; missing inputs or lane are explicit', async () => {
  const s = await pipelineSetup()
  cleanups.push(s.cleanup)
  await extractJob(s.job, new AbortController().signal, s.store, s.options, s.search)
  await appendFile(
    s.file,
    '\n' + JSON.stringify({ id: 'later', message: { role: 'user', content: 'never read' } }),
  )
  const view = await extractionView(s.store, s.job.id)
  expect(view.source.segments.some((s) => s.text.includes('never read'))).toBe(false)
  expect(view.prompts).toEqual(s.runner.mock.calls.map(([call]) => call.prompt))
  s.store.parts.clear()
  expect(
    (await extractionView(s.store, s.job.id)).prompts.every((p) =>
      p.startsWith('Prompt not available'),
    ),
  ).toBe(true)
  await unlink(s.file)
  const missing = await extractionView(s.store, s.job.id)
  expect(missing.source.exists).toBe(false)
  expect(missing.calls).toHaveLength(3)
})
it('follows recorded ancestry, excluding abandoned branches and guarding cycles', () => {
  const entries = [
    { id: 'root', parentId: null },
    { id: 'a', parentId: 'root' },
    { id: 'abandoned', parentId: 'root' },
    { id: 'leaf', parentId: 'a' },
    { id: 'later', parentId: 'leaf' },
  ]
  expect(transcriptAtLeaf(entries, 'leaf').map((e) => e.id)).toEqual(['root', 'a', 'leaf'])
  expect(
    transcriptAtLeaf(
      [
        { id: 'a', parentId: 'b' },
        { id: 'b', parentId: 'a' },
      ],
      'b',
    ),
  ).toHaveLength(2)
  expect(transcriptAtLeaf(entries, 'missing')).toEqual([])
})
it('scrubs before the 64 KB byte cap, marks truncation and preserves small answers', () => {
  expect(extractionAnswer('Harbor')).toBe('Harbor')
  const answer = extractionAnswer('x'.repeat(65000) + ' token=harbor-secret ' + 'é'.repeat(1000))
  expect(answer).not.toContain('harbor-secret')
  expect(answer).toContain('[answer truncated at 64 KB]')
  expect(answer).not.toContain('\uFFFD')
  expect(Buffer.byteLength(answer)).toBeLessThan(65600)
})

it('rebuilds a whole-lane prompt with 600 segments from its input checkpoint', async () => {
  const s = await pipelineSetup()
  cleanups.push(s.cleanup)
  const entries = Array.from({ length: 600 }, (_, i) => ({
    id: `made-up-${i}-${'a'.repeat(80)}`,
    type: 'message',
    message: {
      role: 'assistant',
      content: i === 0 ? 'Rina Okafor owns Harbor billing.' : `Harbor note ${i}.`,
    },
  }))
  await writeFile(
    s.file,
    [...s.entries.slice(0, 3), ...entries].map((e) => JSON.stringify(e)).join('\n'),
  )
  await extractJob(s.job, new AbortController().signal, s.store, s.options, s.search)
  const view = await extractionView(s.store, s.job.id)
  expect(view.prompts).toEqual(s.runner.mock.calls.map(([call]) => call.prompt))
  expect(view.calls.filter((c) => c.stage === 'extract')).toHaveLength(1)
  expect(view.calls[0]!.entryIds).toHaveLength(600)
})

it('rebuilds both repair attempts from the original answer after a provider retry', async () => {
  const s = await pipelineSetup()
  cleanups.push(s.cleanup)
  s.options.retryDelay = async () => {}
  let repairAttempts = 0
  s.runner.mockImplementation(async (input) => {
    if (input.stage === 'extract') return { text: '{}', usage: { tokens: 1, cost: 0 } }
    if (input.stage === 'repair' && ++repairAttempts === 1) {
      const trace = new CallTracer()
      trace.finish('error')
      input.onTrace?.(trace.trace)
      throw new Error('Fake socket error')
    }
    return { text: answerFor(input), usage: { tokens: 1, cost: 0 } }
  })
  await extractJob(s.job, new AbortController().signal, s.store, s.options, s.search)
  expect(s.store.job(s.job.id)?.state).toBe('done')
  const view = await extractionView(s.store, s.job.id)
  expect(view.calls.map((c) => c.stage)).toEqual([
    'extract',
    'repair',
    'repair',
    'links',
    'identity',
  ])
  expect(view.prompts).toEqual(s.runner.mock.calls.map(([call]) => call.prompt))
})
