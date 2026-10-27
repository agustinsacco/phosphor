import { styleText } from 'node:util'
import { stripAnsi } from '@phosphor/shared/ansi'
import { S_BAR, S_ERROR, S_INFO, S_STEP_SUBMIT, S_SUCCESS, S_WARN, unicodeOr } from '@clack/prompts'

/** What a line says about its subject; each has one mark and one colour everywhere. */
export type Tone = 'ok' | 'warn' | 'fail' | 'info' | 'skip' | 'done'

type Style = Parameters<typeof styleText>[0]
export type Paint = (style: Style, text: string) => string

/** Colour only for a terminal that shows it; NO_COLOR and TERM=dumb turn it off. */
export function painter(color: boolean): Paint {
  return color ? (style, text) => styleText(style, text, { validateStream: false }) : (_, t) => t
}

export const BAR = S_BAR

/** The rail symbol a block opens with, as Clack draws its own. */
export const RAIL: Record<Tone, string> = {
  ok: S_SUCCESS,
  warn: S_WARN,
  fail: S_ERROR,
  info: S_INFO,
  skip: S_STEP_SUBMIT,
  done: S_STEP_SUBMIT,
}

/** The mark a row in a list carries. */
export const MARK: Record<Tone, string> = {
  ok: unicodeOr('✓', '+'),
  warn: unicodeOr('▲', '!'),
  fail: unicodeOr('✗', 'x'),
  info: unicodeOr('●', '*'),
  skip: unicodeOr('–', '-'),
  done: unicodeOr('◇', 'o'),
}

export const TONE_STYLE: Record<Tone, Style> = {
  ok: 'green',
  warn: 'yellow',
  fail: 'red',
  info: 'blue',
  skip: 'gray',
  done: 'green',
}

/** A check's status as a tone. */
export const CHECK_TONE = { pass: 'ok', warn: 'warn', fail: 'fail', info: 'info' } as const

/** One aligned row of a list. */
export interface Row {
  tone: Tone
  name: string
  text: string
}

/** Rows as lines: a coloured mark, a padded name, then the text wrapped to `width`. */
export function rowLines(paint: Paint, rows: readonly Row[], width = Infinity): string[] {
  const name = Math.max(0, ...rows.map((row) => row.name.length))
  const indent = name + 4
  return rows.flatMap((row) => {
    const text = row.tone === 'skip' ? paint('dim', row.text) : row.text
    const [first = '', ...rest] = wrap(text, width - indent)
    const head = `${paint(TONE_STYLE[row.tone], MARK[row.tone])} ${row.name.padEnd(name)}  ${first}`
    return [head, ...rest.map((line) => ' '.repeat(indent) + line)]
  })
}

/** How many columns `text` takes, without its colour codes. */
export const visible = (text: string) => stripAnsi(text).length

/** A colour code at the start of a string: wrapping keeps these whole. */
// eslint-disable-next-line no-control-regex
const LEADING_SGR = /^\x1b\[[0-9;]*m/

/**
 * Words onto lines of at most `width` columns, keeping colour codes whole;
 * a word longer than a line (a path) is split where the line ends.
 */
export function wrap(text: string, width: number): string[] {
  if (width < 10 || visible(text) <= width) return [text]
  const lines: string[] = []
  let line = ''
  for (let word of text.split(' ')) {
    if (line && visible(line) + 1 + visible(word) > width) {
      lines.push(line)
      line = ''
    }
    // Only an empty line is left here for a word too long for any line.
    while (visible(word) > width) {
      const [head, tail] = splitVisible(word, width)
      lines.push(head)
      word = tail
    }
    line = line ? `${line} ${word}` : word
  }
  if (line) lines.push(line)
  return lines
}

/** The first `columns` visible characters of `text`, and the rest. */
function splitVisible(text: string, columns: number): [string, string] {
  let seen = 0
  for (let i = 0; i < text.length;) {
    const code = LEADING_SGR.exec(text.slice(i))
    if (code) i += code[0].length
    else if (seen === columns) return [text.slice(0, i), text.slice(i)]
    else {
      seen++
      i++
    }
  }
  return [text, '']
}

/** "3 minutes ago", "in 2 hours": coarse, for a person reading a status. */
export function relativeTime(iso: string | null, now: number): string {
  if (!iso) return 'never'
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return iso
  const seconds = Math.round((now - at) / 1000)
  const past = seconds >= 0
  const abs = Math.abs(seconds)
  const [count, unit] =
    abs < 45
      ? [0, 'now']
      : abs < 3600
        ? [Math.max(1, Math.round(abs / 60)), 'minute']
        : abs < 86_400
          ? [Math.round(abs / 3600), 'hour']
          : [Math.round(abs / 86_400), 'day']
  if (unit === 'now') return 'just now'
  const text = `${count} ${unit}${count === 1 ? '' : 's'}`
  return past ? `${text} ago` : `in ${text}`
}
