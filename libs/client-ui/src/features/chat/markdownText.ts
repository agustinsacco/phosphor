/**
 * Markdown source reduced to roughly the text it renders as: the words a
 * reader sees, without the syntax around them, laid out the way the DOM find
 * indexes the rendered page (`indexText`) — one line per block, and a soft
 * line break read as the space it shows as.
 *
 * The transcript counts find hits from row DATA, because most of its rows are
 * virtualized out of the DOM, and a count taken from raw markdown would find
 * `**` and link URLs that are nowhere on screen. This is a line-oriented
 * approximation, not a parser (the renderer's remark pipeline costs far too
 * much to run over a whole session on every keystroke). Where it and the
 * rendered DOM disagree, the DOM wins when the hit is revealed: the bar steps
 * to the nearest rendered match in the same block.
 *
 * Raw HTML stays, as text: the renderer has no rehype-raw, so `<Suspense>`
 * is on screen exactly as written. Math goes: the DOM find cannot read KaTeX's
 * output either, and a count should not promise what a step cannot reach.
 */

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/
/** remark-math's `$$` block: its opening line carries no other `$`. */
const MATH_FENCE_OPEN = /^\s{0,3}(\${2,})[^$]*$/
const FENCE_CLOSE = /^\s{0,3}(`{3,}|~{3,}|\${2,})\s*$/
const HEADING = /^\s{0,3}#{1,6}(?:\s+|$)/
const HEADING_CLOSE = /\s+#+\s*$/
const BLOCKQUOTE = /^(?:\s{0,3}>\s?)+/
const THEMATIC_BREAK = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const SETEXT_UNDERLINE = /^\s{0,3}=+\s*$/
const LIST_MARKER = /^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/
const TABLE_ROW = /^\s*\|(.*)\|\s*$/
const LINK_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s+\S+.*$/
/** Two trailing spaces, or an unescaped trailing backslash: the line ends in a `<br>`. */
const HARD_BREAK = / {2,}$|(?:^|[^\\])(?:\\\\)*\\$/

/**
 * Code spans, inline math and backslash escapes, left to right as the
 * renderer reads them: whichever opens first wins, so a `$` inside code is
 * code, and `\*` is a literal star before any emphasis pass can take it. A
 * delimiter run counts whole (`$$` is not a `$` twice), as remark reads it.
 */
const LITERALS =
  /(?<!`)(`+)(?!`)([\s\S]*?[^`])\1(?!`)|(?<!\$)(\$+)(?!\$)([\s\S]*?[^$])\3(?!\$)|\\([!-/:-@[-`{-~])/g

/** A link destination, allowing one level of balanced parentheses: `(https://a.dev/f_(x))`. */
const DESTINATION = String.raw`\((?:[^()]|\([^()]*\))*\)`
const IMAGE = new RegExp(String.raw`!\[[^\]]*\]${DESTINATION}`, 'g')
const LINK = new RegExp(String.raw`\[([^\]]*)\]${DESTINATION}`, 'g')

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/** Placeholder brackets for literal text (code, escapes), which must survive the emphasis pass untouched. */
const HOLD = '\u0000'

function inline(source: string): string {
  const held: string[] = []
  const hold = (literal: string): string => `${HOLD}${held.push(literal) - 1}${HOLD}`
  let text = source.replace(
    LITERALS,
    (_, _ticks, code: string | undefined, _dollars, _math, escaped: string | undefined) => {
      if (code !== undefined) return hold(/^ .* $/.test(code) ? code.slice(1, -1) : code)
      if (escaped !== undefined) return hold(escaped)
      return ''
    },
  )
  text = text
    // Images render as pictures; their alt text is not on the page.
    .replace(IMAGE, '')
    .replace(LINK, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/\*(?=\S)([\s\S]*?\S)\*/g, '$1')
    // Underscores inside a word are part of it (snake_case), not emphasis.
    .replace(/(^|[^\w])_(?=\S)([\s\S]*?\S)_(?!\w)/g, '$1$2')
    .replace(/(~~?)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (entity, name: string) => {
      if (name[0] === '#') {
        const code =
          name[1] === 'x' || name[1] === 'X'
            ? parseInt(name.slice(2), 16)
            : parseInt(name.slice(1), 10)
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : entity
      }
      return ENTITIES[name.toLowerCase()] ?? entity
    })
  return held.length === 0
    ? text
    : text.replace(new RegExp(`${HOLD}(\\d+)${HOLD}`, 'g'), (_, i: string) => held[Number(i)] ?? '')
}

/**
 * A paragraph's source lines as one: a soft break shows as a space, and a
 * hard break is a `<br>` — a line of its own.
 */
function joinParagraph(lines: string[]): string {
  const last = lines.length - 1
  return lines
    .map((line, i) => {
      if (i === last) return line.replace(/[ \t]+$/, '')
      return HARD_BREAK.test(line) ? `${line.replace(/(?: {2,}|\\)$/, '')}\n` : `${line.trimEnd()} `
    })
    .join('')
}

export function markdownText(source: string): string {
  const out: string[] = []
  /** The open fence's marker, while inside a fenced code or math block. */
  let fence: string | null = null
  /**
   * The paragraph being gathered, and the blockquote depth it opened at. Its
   * lines are one text node on screen, so inline syntax that spans them
   * (`**two\nlines**`) is read once, over the whole of it.
   */
  let paragraph: { lines: string[]; depth: number } | null = null
  const flush = (): void => {
    if (paragraph) out.push(inline(joinParagraph(paragraph.lines)))
    paragraph = null
  }
  // NUL is U+FFFD to the renderer (CommonMark), and must not pass for a HOLD.
  for (const line of source.replaceAll(HOLD, '�').split(/\r\n?|\n/)) {
    if (fence !== null) {
      const close = FENCE_CLOSE.exec(line)
      if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length) fence = null
      else if (fence[0] !== '$') out.push(line)
      continue
    }
    const open = FENCE_OPEN.exec(line) ?? MATH_FENCE_OPEN.exec(line)
    if (open) {
      flush()
      fence = open[1]!
      continue
    }
    if (
      line.trim() === '' ||
      THEMATIC_BREAK.test(line) ||
      SETEXT_UNDERLINE.test(line) ||
      TABLE_DELIMITER.test(line) ||
      LINK_DEFINITION.test(line)
    ) {
      flush()
      out.push('')
      continue
    }
    const row = TABLE_ROW.exec(line)
    if (row) {
      flush()
      // Each cell is its own block on screen, so a match cannot span two.
      out.push(
        row[1]!
          .split(/(?<!\\)\|/)
          .map((cell) => inline(cell.trim()))
          .join('\n'),
      )
      continue
    }
    const quote = BLOCKQUOTE.exec(line)?.[0] ?? ''
    const depth = quote.split('>').length - 1
    let text = line.slice(quote.length)
    if (text.trim() === '') {
      flush()
      out.push('')
      continue
    }
    if (HEADING.test(text)) {
      flush()
      out.push(inline(text.replace(HEADING, '').replace(HEADING_CLOSE, '')))
      continue
    }
    const marker = LIST_MARKER.exec(text)
    if (marker) {
      flush()
      text = text.slice(marker[0].length)
    } else if (paragraph && (depth === 0 || depth === paragraph.depth)) {
      // A continuation line — lazily, too, when it drops the `>`.
      paragraph.lines.push(text.trimStart())
      continue
    } else {
      flush()
    }
    paragraph = { lines: [text.trimStart()], depth }
  }
  flush()
  return out.join('\n')
}
