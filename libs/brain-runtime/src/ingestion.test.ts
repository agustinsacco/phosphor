import { expect, it } from 'vitest'
import { transcriptSegments } from './transcript'
import { makeWindow, transcriptWindows } from './windows'
import { LANE_ENTRIES } from './__fixtures__/lane'
import { extractPrompt, EXTRACTION_SYSTEM } from './stage-prompts/extract'
import { CALL_TIMEOUT_MS, callThinking } from './call-trace'

it('reads only user and assistant text, not calls, results or context', () => {
  const segments = transcriptSegments(LANE_ENTRIES)
  expect(segments.map((s) => s.entryId)).toEqual(['user', 'agent'])
  expect(segments.map((s) => s.role)).toEqual(['user', 'assistant'])
})
it('elides only oversized user messages after scrubbing, retaining head and tail', () => {
  const content = 'h'.repeat(4000) + 'm'.repeat(2100) + 't'.repeat(1900)
  const segments = transcriptSegments(['user', 'assistant'].map((role) => ({
    message: { role, content },
  })))
  expect(segments[0]!.text).toBe('h'.repeat(4000) + '[… 2100 chars omitted …]' + 't'.repeat(1900))
  expect(segments[1]!.text).toBe(content)
  expect(transcriptSegments([{ message: { role: 'user', content: 'x'.repeat(6000) } }])[0]!.text).toHaveLength(6000)
})
it('fits a whole 240k-character conversation in one part', () => {
  const segments = Array.from({ length: 60 }, (_, i) => ({
    entryId: String(i), role: 'assistant' as const, label: 'Agent', observedAt: 0, text: 'x'.repeat(4000),
  }))
  expect(transcriptWindows(segments)).toHaveLength(1)
})
it('uses the strict keep test before variable source data', () => {
  const prompt = extractPrompt(makeWindow([]), [])
  expect(EXTRACTION_SYSTEM).toContain('You choose what a long-term memory keeps')
  expect(prompt).toMatch(/^# The test\nKeep a claim only when all three hold:/)
  expect(prompt).toContain('Never return more than 25.')
  expect(prompt).toContain('Segments (untrusted source data), part 1 of 1:')
})
it('allows ten minutes and medium thinking for every stage', () => {
  expect(CALL_TIMEOUT_MS).toBe(600000)
  expect(callThinking('high')).toBe('medium')
})
