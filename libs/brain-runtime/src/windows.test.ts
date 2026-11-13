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
  expect(segments.map((s) => s.text)).toEqual(['corrected', 'context'])
  expect(segments[0]!.label).toContain('1970-01-01T00:00:00.000Z')
})

it('bounds windows with two segment overlap and preserves long user text without truncation', () => {
  const segments = Array.from({ length: 8 }, (_, i) => ({
    entryId: `${i}`,
    role: 'user' as const,
    observedAt: 0,
    label: 'You',
    text: `${i}`.repeat(8000),
  }))
  const windows = transcriptWindows(segments)
  expect(windows.every((w) => w.text.length <= 32000)).toBe(true)
  expect(windows[0]!.segments.slice(-2)).toEqual(windows[1]!.segments.slice(0, 2))
  expect(
    transcriptWindows([{ ...segments[0]!, text: 'a'.repeat(50000) }])
      .map((w) => w.segments.map((s) => s.text).join(''))
      .join(''),
  ).toBe('a'.repeat(50000))
})

it('truncates tool output and arguments but never user and assistant text', () => {
  const entries = [
    { id: 'a', message: { role: 'user', content: 'x'.repeat(5000) } },
    {
      id: 'b',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'y'.repeat(5000) },
          { type: 'toolCall', name: 'bash', arguments: { command: 'z'.repeat(1000) } },
        ],
      },
    },
    ...['bash', 'read'].map((toolName) => ({
      id: toolName,
      message: { role: 'toolResult', toolName, content: 't'.repeat(10000) },
    })),
  ]
  const segments = transcriptSegments(entries)
  expect(segments.slice(0, 2).map((s) => s.text.length)).toEqual([5000, 5000])
  expect(segments[2]!.text.length).toBeLessThanOrEqual(300)
  expect(segments[3]!.text).toContain('chars omitted')
  expect(segments[3]!.text.length).toBeLessThan(900)
  expect(segments[4]!.text.length).toBeLessThanOrEqual(4000)
})
