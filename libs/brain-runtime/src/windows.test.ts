import { expect, it } from 'vitest'
import { transcriptAtLeaf, transcriptSegments } from './transcript'
import { transcriptWindows } from './windows'

it('prepares originals through context edits, not derivative compaction or Brain output', () => {
  const entries = [
    { id: 'a', type: 'message', parentId: null, message: { role: 'user', content: 'original' } },
    { id: 'b', parentId: 'a', type: 'compaction', summary: 'derivative' },
    { id: 'c', parentId: 'b', type: 'context_edit', targetId: 'a', replacement: 'corrected' },
    {
      id: 'd',
      parentId: 'c',
      type: 'message',
      message: { role: 'toolResult', toolName: 'brain_search', content: 'recalled' },
    },
    { id: 'e', parentId: 'd', type: 'branch_summary', summary: 'context' },
    { id: 'later', parentId: 'e', type: 'message', message: { role: 'user', content: 'too late' } },
  ]
  const segments = transcriptSegments(transcriptAtLeaf(entries, 'e'))
  expect(segments.map((s) => s.text)).toEqual(['corrected'])
  expect(segments[0]!.label).toContain('1970-01-01T00:00:00.000Z')
})

it('bounds windows with two segment overlap and preserves long user text without truncation', () => {
  const segments = Array.from({ length: 8 }, (_, i) => ({
    entryId: `${i}`,
    role: 'user' as const,
    observedAt: 0,
    label: 'You',
    text: `${i}`.repeat(80000),
  }))
  const windows = transcriptWindows(segments)
  expect(windows.every((w) => w.text.length <= 300000)).toBe(true)
  expect(windows[0]!.segments.slice(-2)).toEqual(windows[1]!.segments.slice(0, 2))
  expect(
    transcriptWindows([{ ...segments[0]!, text: 'a'.repeat(500000) }])
      .map((w) => w.segments.map((s) => s.text).join(''))
      .join(''),
  ).toBe('a'.repeat(500000))
})

