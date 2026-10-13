/**
 * The word a right-click is about, as a range in a text field's value.
 *
 * macOS selects the word under the pointer on right-click; Windows and Linux
 * only move the caret there. So a selection is taken as is when it is one
 * word, and a caret is widened to the word around it.
 */

export interface WordRange {
  start: number
  end: number
  word: string
}

/** Letters and combining marks, plus apostrophes inside a word (don't, l’homme). */
const WORD_CHAR = /[\p{L}\p{M}'’]/u
const EDGE_APOSTROPHES = /^['’]+|['’]+$/g

export function wordRangeAt(value: string, start: number, end: number): WordRange | null {
  if (start !== end) {
    const selected = value.slice(start, end)
    if (!selected || ![...selected].every((ch) => WORD_CHAR.test(ch))) return null
    return trimApostrophes(value, start, end)
  }
  let from = start
  let to = start
  while (from > 0 && WORD_CHAR.test(value[from - 1]!)) from--
  while (to < value.length && WORD_CHAR.test(value[to]!)) to++
  // Digits or underscores glued on make it an identifier (v2beta, foo_bar), not a word.
  if (/[\p{N}_]/u.test(value[from - 1] ?? '') || /[\p{N}_]/u.test(value[to] ?? '')) return null
  return from === to ? null : trimApostrophes(value, from, to)
}

function trimApostrophes(value: string, start: number, end: number): WordRange | null {
  const raw = value.slice(start, end)
  const leading = raw.length - raw.replace(/^['’]+/, '').length
  const word = raw.replace(EDGE_APOSTROPHES, '')
  if (!word) return null
  return { start: start + leading, end: start + leading + word.length, word }
}
