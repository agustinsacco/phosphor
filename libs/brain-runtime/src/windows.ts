import { createHash } from 'node:crypto'
import type { TranscriptSegment } from '@phosphor/memory-engine/types'
import { WINDOW_CHARS, WINDOW_OVERLAP } from './constants'

export interface TranscriptWindow {
  segments: TranscriptSegment[]
  text: string
  inputHash: string
}
export const inputHash = (text: string): string => createHash('sha256').update(text).digest('hex')

export function windowText(segments: TranscriptSegment[]): string {
  return segments.map((s, i) => `[s${i + 1}] ${s.role} ${s.label}\n${s.text}`).join('\n\n')
}
export function makeWindow(segments: TranscriptSegment[]): TranscriptWindow {
  const text = windowText(segments)
  return { segments, text, inputHash: inputHash(text) }
}

/** Oversize messages are sliced without elision: every user/assistant character is retained. */
export function transcriptWindows(segments: TranscriptSegment[]): TranscriptWindow[] {
  const pieces = segments.flatMap((segment) => {
    const max = WINDOW_CHARS - windowText([{ ...segment, text: '' }]).length - 100
    const out: TranscriptSegment[] = []
    for (let start = 0; start < segment.text.length; start += max)
      out.push({ ...segment, text: segment.text.slice(start, start + max) })
    return out
  })
  const windows: TranscriptWindow[] = []
  let start = 0
  while (start < pieces.length) {
    let end = start + 1
    while (end < pieces.length && windowText(pieces.slice(start, end + 1)).length <= WINDOW_CHARS)
      end++
    windows.push(makeWindow(pieces.slice(start, end)))
    if (end === pieces.length) break
    start = Math.max(start + 1, end - WINDOW_OVERLAP)
  }
  return windows
}

export function splitWindow(window: TranscriptWindow): TranscriptWindow[] {
  const middle = Math.ceil(window.segments.length / 2)
  return [makeWindow(window.segments.slice(0, middle)), makeWindow(window.segments.slice(middle))]
}
