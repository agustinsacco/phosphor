/**
 * Autocomplete learned from the prompts you have sent. Local and synchronous:
 * no model, no network, a lookup per keystroke.
 *
 * Two strategies, first hit wins:
 *
 * 1. **Earlier prompt.** The line you are typing starts an earlier line
 *    (case-insensitively): suggest the rest of it, newest first, to the end of
 *    that sentence. This is zsh-autosuggestions' history strategy.
 * 2. **Next word.** Word counts over your prompts, with the two words before
 *    the caret as context (trigram, then bigram). Finishes the word you are in
 *    (`subag` → `subagents`), or after a space suggests the next one, then
 *    keeps going while the following words are clearly the usual ones
 *    (`ok good lets ` → `open a PR`). A partial word with no context left
 *    falls back to your vocabulary, from three typed letters.
 *
 * Only confident guesses show. The winner must have followed that context at
 * least twice after two words, three times after one, and hold 40% of what
 * followed it (50% for each extra word), so a context you have used many
 * different ways shows nothing.
 *
 * Tuned by replaying the newest 150 of 925 real prompts keystroke by
 * keystroke, accepting a suggestion only as far as it was right: about 15% of
 * keystrokes saved, a suggestion on about 23% of keystrokes, and 0.01 ms per
 * lookup at p99. An earlier prompt needs 12 typed characters because one-off
 * prompts rarely recur: offered from 5, they added long wrong guesses and
 * almost no savings.
 *
 * Words are whitespace-separated chunks, so `file.ts`, `--no-tools` and
 * `can't` come back exactly as you wrote them. Counting is case-insensitive;
 * the spelling shown is the latest one used. A chunk ending in . ? or ! ends a
 * sentence: the context starts over and a suggestion stops there. Fenced code
 * is skipped.
 */

export interface Predictor {
  /** The text to show after the caret, or null. `text` is everything before the caret. */
  predict(text: string): string | null
  /** Learn one more prompt. */
  add(prompt: string): void
}

type Counter = Map<string, number>

/** Start of a line or sentence. Not a character any chunk can contain. */
const START = '\u0000'
const SEP = '\u0001'

/** Typed characters on the line before an earlier prompt is offered. */
const MIN_LINE_CHARS = 12
/** Letters of a word before it is finished from vocabulary alone. */
const MIN_VOCABULARY_PREFIX = 3
const MAX_PROMPT_WORDS = 8
const MAX_NEXT_WORDS = 6

const TRAILING_PUNCTUATION = /[.,;:!?)\]}"'`’”]+$/u

const endsSentence = (chunk: string): boolean => /[.?!]["')\]]?$/.test(chunk)

export function createPredictor(prompts: readonly string[] = []): Predictor {
  /** Earlier lines, oldest first, with their lowercase twin for matching. */
  const lines: Array<{ text: string; lower: string }> = []
  const unigrams: Counter = new Map()
  const bigrams = new Map<string, Counter>()
  const trigrams = new Map<string, Counter>()
  /** Latest spelling seen for each lowercase word. */
  const surface = new Map<string, string>()

  const bump = (map: Map<string, Counter>, context: string, word: string): void => {
    let counter = map.get(context)
    if (!counter) map.set(context, (counter = new Map()))
    counter.set(word, (counter.get(word) ?? 0) + 1)
  }

  const add = (prompt: string): void => {
    let fenced = false
    for (const raw of prompt.split('\n')) {
      if (raw.trimStart().startsWith('```')) {
        fenced = !fenced
        continue
      }
      const line = raw.trim()
      if (fenced || !line) continue
      const lower = line.toLowerCase()
      if (lower.length === line.length) lines.push({ text: line, lower })

      let before = START
      let previous = START
      for (const chunk of line.split(/\s+/)) {
        const word = chunk.toLowerCase()
        surface.set(word, chunk)
        // Vocabulary finishes words, so `worktree,` and `worktree.` count as one.
        const bare = chunk.replace(TRAILING_PUNCTUATION, '')
        if (bare) {
          const key = bare.toLowerCase()
          if (!surface.has(key)) surface.set(key, bare)
          unigrams.set(key, (unigrams.get(key) ?? 0) + 1)
        }
        bump(bigrams, previous, word)
        bump(trigrams, before + SEP + previous, word)
        ;[before, previous] = endsSentence(chunk) ? [START, START] : [previous, word]
      }
    }
  }

  /**
   * The most likely word after the context that starts with `partial`, or null.
   * Backs off to a shorter context only when the longer one has too little
   * data to judge; a context that has data but no clear winner shows nothing.
   */
  const pickWord = (
    before: string,
    previous: string,
    partial: string,
    share: number,
  ): string | null => {
    const sources: Array<[Counter | undefined, number]> = [
      [trigrams.get(before + SEP + previous), 2],
      [bigrams.get(previous), 3],
    ]
    if (partial.length >= MIN_VOCABULARY_PREFIX) sources.push([unigrams, 3])

    for (const [counter, minCount] of sources) {
      if (!counter) continue
      let total = 0
      let best: string | null = null
      let bestCount = 0
      for (const [word, count] of counter) {
        if (!word.startsWith(partial)) continue
        // Vocabulary alone only finishes a word, it never confirms one.
        if (counter === unigrams && word.length <= partial.length) continue
        total += count
        if (count > bestCount) [best, bestCount] = [word, count]
      }
      if (total < minCount) continue
      return bestCount >= minCount && bestCount / total >= share ? best : null
    }
    return null
  }

  const fromEarlierPrompt = (line: string): string | null => {
    // Stored lines are trimmed, so an indented line matches by its text.
    const typed = line.trimStart()
    if (typed.trim().length < MIN_LINE_CHARS) return null
    const lower = typed.toLowerCase()
    if (lower.length !== typed.length) return null
    for (let index = lines.length - 1; index >= 0; index--) {
      const earlier = lines[index]!
      if (earlier.lower.length > lower.length && earlier.lower.startsWith(lower)) {
        return clip(earlier.text.slice(typed.length))
      }
    }
    return null
  }

  const nextWords = (line: string): string | null => {
    const chunks = line.trim().split(/\s+/)
    const partial = /\s$/.test(line) ? '' : chunks.pop()!.toLowerCase()
    let before = START
    let previous = START
    for (const chunk of chunks) {
      ;[before, previous] = endsSentence(chunk) ? [START, START] : [previous, chunk.toLowerCase()]
    }

    const first = pickWord(before, previous, partial, 0.4)
    if (!first) return null
    // The shown spelling continues what was typed, so it must line up with it.
    const spelled = surface.get(first)
    const firstSurface = spelled && spelled.length === first.length ? spelled : first
    let out = firstSurface.slice(partial.length)
    let last = firstSurface
    ;[before, previous] = [previous, first]
    for (let words = 1; words < MAX_NEXT_WORDS && !endsSentence(last); words++) {
      const next = pickWord(before, previous, '', 0.5)
      if (!next) break
      last = surface.get(next) ?? next
      out += ' ' + last
      ;[before, previous] = [previous, next]
    }
    return out.trim() === '' ? null : out
  }

  for (const prompt of prompts) add(prompt)

  return {
    add,
    predict(text) {
      const line = text.slice(text.lastIndexOf('\n') + 1)
      if (line.trim().length < 2) return null
      return fromEarlierPrompt(line) ?? nextWords(line)
    },
  }
}

/** The start of an earlier line's remainder, to the end of its sentence. */
function clip(rest: string): string | null {
  let out = ''
  let words = 0
  for (const match of rest.matchAll(/(\s*)(\S+)/g)) {
    out += match[1]! + match[2]!
    words++
    if (words >= MAX_PROMPT_WORDS || endsSentence(match[2]!)) break
  }
  return out.trim() === '' ? null : out
}
