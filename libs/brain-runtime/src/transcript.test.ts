import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readEntries, transcriptSegments } from './transcript'
import { verifyQuotes } from './quotes'
import { RAW_EXTRACTION } from './__fixtures__/lane'
import { LANE_ENTRIES } from './__fixtures__/lane'

it('segments a pi JSONL lane into readable, labelled, independently citable pieces', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harbor-transcript-'))
  try {
    const path = join(directory, 'lane.jsonl')
    await writeFile(
      path,
      LANE_ENTRIES.map((e) => JSON.stringify(e)).join('\r\n') + '\n{"incomplete":',
    )
    const entries = await readEntries(path)
    expect(entries).toEqual(LANE_ENTRIES)
    const segments = transcriptSegments(entries)
    expect(segments.map((s) => [s.entryId, s.role, s.text])).toEqual([
      ['user', 'user', 'Rina Okafor owns Harbor billing. Tom Lee reviews schema changes.'],
      ['agent', 'assistant', 'Checking the billing policy.\u2028Keep this together.'],
      ['agent', 'assistant', '{"command":"cat harbor-policy.md"}'],
      ['tool', 'toolResult', 'Harbor retains invoices for seven years.'],
      ['summary', 'context', 'Harbor keeps invoice changes backwards compatible.'],
      ['branch', 'context', 'Tom Lee approved the invoice schema.'],
      ['custom', 'context', 'Harbor release policy is under review.'],
    ])
    expect(segments[0]!.label).toMatch(/^You · Nov 6,/)
    expect(segments[2]!.label).toMatch(/^Agent · bash call · Nov 6,/)
    expect(segments[3]!.label).toMatch(/^Tool output · bash · Nov 6,/)
    expect(segments[4]!.label).toMatch(/^Summary ·/)
    expect(segments[0]!.observedAt).toBe(Date.parse('2026-11-06T12:47:00Z'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it.each(['brain_search', 'brain_related'])(
  'never verifies recalled %s output as fresh evidence',
  (toolName) => {
    const text = RAW_EXTRACTION.memories[0]!.quotes[0]!
    const recalled = {
      type: 'message',
      id: 'recall',
      message: { role: 'toolResult', toolName, content: text },
    }
    const segments = transcriptSegments([recalled])
    expect(segments).toEqual([])
    expect(verifyQuotes(RAW_EXTRACTION, segments)).toEqual({
      memories: [],
      evidence: [],
      dropped: [`No verified quote: ${RAW_EXTRACTION.memories[0]!.summary}`],
    })
    const fresh = transcriptSegments([
      recalled,
      { type: 'message', id: 'fresh', message: { role: 'user', content: text } },
    ])
    expect(verifyQuotes(RAW_EXTRACTION, fresh).evidence.map((item) => item.entryId)).toEqual([
      'fresh',
    ])
  },
)
