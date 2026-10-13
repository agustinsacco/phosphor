import type { TextEdit } from '@/lib/composerText'

/**
 * Put dictated text in place of the selection, with a space on either side
 * where it would otherwise run into a word. The caret lands after it, so a
 * second dictation continues the first.
 */
export function insertDictation(
  value: string,
  from: number,
  to: number,
  dictated: string,
): TextEdit | null {
  const text = dictated.trim()
  if (!text) return null
  const before = value.slice(0, from)
  const after = value.slice(to)
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  const trail = after && !/^\s/.test(after) ? ' ' : ''
  const caret = from + lead.length + text.length + trail.length
  return { value: before + lead + text + trail + after, selectionStart: caret, selectionEnd: caret }
}
