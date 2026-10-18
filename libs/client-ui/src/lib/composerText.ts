/**
 * Markdown list/emphasis editing over a plain textarea value.
 *
 * The composer is a `<textarea>` and stays one. The `/` command menu and the
 * `@` mention menu are regexes over the raw string, prompt recall replaces the
 * whole value, and `!cmd` is a prefix test — a rich-text editor would have to
 * re-implement every one of those to gain WYSIWYG the wire format does not
 * want. What the model receives is markdown text, so markdown text is what the
 * user should be editing.
 *
 * Everything here is pure: `(value, selection) → (value, selection)`. The
 * React side does nothing but apply the result.
 */

export type ListKind = 'bullet' | 'ordered'

export interface ParsedListLine {
  indent: string
  kind: ListKind
  /** '-' | '*' | '+' for a bullet list. */
  bullet?: string
  /** 1-based item number for an ordered list. */
  number?: number
  /** '.' or ')' after an ordered number. */
  delim?: string
  /** Whitespace between the marker and the content. */
  space: string
  /** '[ ]' or '[x]' when the item is a task. */
  task?: string
  /** Everything after the marker (and checkbox). */
  content: string
  /** The marker text as it appears, e.g. '- ', '3. ', '- [ ] '. */
  prefix: string
}

export interface TextEdit {
  value: string
  selectionStart: number
  selectionEnd: number
}

const LIST_RE = /^(\s*)(?:([-*+])|(\d+)([.)]))([ \t]+)(\[[ xX]\][ \t]+)?([\s\S]*)$/

/** Parse one line as a markdown list item, or null when it is not one. */
export function parseListLine(line: string): ParsedListLine | null {
  const m = LIST_RE.exec(line)
  if (!m) return null
  const [, indent = '', bullet, digits, delim, space = ' ', taskRaw, content = ''] = m
  const task = taskRaw ? taskRaw.trimEnd() : undefined
  const prefix = line.slice(0, line.length - content.length)
  if (bullet) return { indent, kind: 'bullet', bullet, space, task, content, prefix }
  return {
    indent,
    kind: 'ordered',
    number: Number(digits),
    delim,
    space,
    task,
    content,
    prefix,
  }
}

/** Marker text for a parsed line, with an optional replacement number. */
function markerFor(parsed: ParsedListLine, num?: number): string {
  const body =
    parsed.kind === 'bullet'
      ? `${parsed.bullet ?? '-'}${parsed.space}`
      : `${num ?? parsed.number ?? 1}${parsed.delim ?? '.'}${parsed.space}`
  const task = parsed.task ? `${parsed.task} ` : ''
  return `${parsed.indent}${body}${task}`
}

/** Index of the line containing `caret`, plus its bounds in `value`. */
export function lineAt(value: string, caret: number): { start: number; end: number; text: string } {
  const start = value.lastIndexOf('\n', caret - 1) + 1
  const nl = value.indexOf('\n', caret)
  const end = nl === -1 ? value.length : nl
  return { start, end, text: value.slice(start, end) }
}

/**
 * Renumber every ordered run in the document.
 *
 * A run ends at a blank line or at a non-list line: that is how markdown reads
 * it too. The first item of a run keeps its own number, so a list the user
 * deliberately started at 3 is not silently reset to 1.
 */
export function renumber(value: string): string {
  const lines = value.split('\n')
  const counters = new Map<number, number>()
  const out = lines.map((line) => {
    const parsed = parseListLine(line)
    if (!parsed) {
      counters.clear()
      return line
    }
    const width = parsed.indent.length
    for (const key of [...counters.keys()]) if (key > width) counters.delete(key)
    if (parsed.kind !== 'ordered') return line
    const previous = counters.get(width)
    const next = previous === undefined ? (parsed.number ?? 1) : previous + 1
    counters.set(width, next)
    return `${markerFor(parsed, next)}${parsed.content}`
  })
  return out.join('\n')
}

/**
 * Enter inside a list.
 *
 * Returns null when the caret is not on a list item, so the caller falls
 * through to its normal Enter (which sends the message).
 */
export function continueList(value: string, caret: number): TextEdit | null {
  const { start, end, text } = lineAt(value, caret)
  const parsed = parseListLine(text)
  if (!parsed) return null
  // Only continue from the end of the item; splitting mid-word should just
  // insert a newline the way it always did.
  if (caret < start + parsed.prefix.length) return null

  // An empty item means "I'm done with this list": drop the marker instead of
  // producing a second empty one.
  if (parsed.content.trim() === '') {
    const outdented = parsed.indent.length >= 2
    if (outdented) {
      // Nested: step out one level first, so Enter walks back up the tree.
      const lifted = `${parsed.indent.slice(2)}${markerFor(parsed).slice(parsed.indent.length)}`
      const next = value.slice(0, start) + lifted + value.slice(end)
      const caretNext = start + lifted.length
      return { value: renumber(next), selectionStart: caretNext, selectionEnd: caretNext }
    }
    const next = value.slice(0, start) + value.slice(end)
    return { value: next, selectionStart: start, selectionEnd: start }
  }

  const marker = markerFor(parsed, (parsed.number ?? 0) + 1)
  // A continued task item always starts unchecked.
  const nextMarker = parsed.task ? marker.replace(/\[[xX]\]/, '[ ]') : marker
  const inserted = `\n${nextMarker}`
  const next = value.slice(0, caret) + inserted + value.slice(caret)
  const caretNext = caret + inserted.length
  const renumbered = renumber(next)
  // Renumbering only rewrites digits after the caret's line, so the caret
  // offset holds unless an earlier line changed width — it cannot here.
  return { value: renumbered, selectionStart: caretNext, selectionEnd: caretNext }
}

/** Line indices touched by a selection. */
function selectedLines(value: string, from: number, to: number): { first: number; last: number } {
  const before = value.slice(0, from).split('\n').length - 1
  const through = value.slice(0, to).split('\n').length - 1
  return { first: before, last: through }
}

/**
 * Toggle a bullet or ordered marker across the selected lines.
 *
 * Every selected line already carrying that kind means "remove it"; anything
 * else means "make them all that kind".
 */
export function toggleList(value: string, from: number, to: number, kind: ListKind): TextEdit {
  const lines = value.split('\n')
  const { first, last } = selectedLines(value, from, to)
  const range = lines.slice(first, last + 1)
  const nonEmpty = range.filter((l) => l.trim() !== '')
  if (nonEmpty.length === 0) {
    // Nothing to convert: seed a marker so the very first keystroke works.
    const seed = kind === 'bullet' ? '- ' : '1. '
    const next = value.slice(0, from) + seed + value.slice(to)
    return { value: next, selectionStart: from + seed.length, selectionEnd: from + seed.length }
  }
  const allSame = nonEmpty.every((l) => parseListLine(l)?.kind === kind)

  let ordinal = 0
  const rewritten = range.map((line) => {
    if (line.trim() === '') return line
    const parsed = parseListLine(line)
    if (allSame && parsed)
      return `${parsed.indent}${parsed.task ? `${parsed.task} ` : ''}${parsed.content}`
    const indent = parsed ? parsed.indent : (/^\s*/.exec(line)?.[0] ?? '')
    const content = parsed ? parsed.content : line.slice(indent.length)
    const task = parsed?.task ? `${parsed.task} ` : ''
    ordinal += 1
    const marker = kind === 'bullet' ? '- ' : `${ordinal}. `
    return `${indent}${marker}${task}${content}`
  })

  const nextLines = [...lines.slice(0, first), ...rewritten, ...lines.slice(last + 1)]
  const nextValue = renumber(nextLines.join('\n'))
  const lineStart = nextLines.slice(0, first).join('\n').length + (first > 0 ? 1 : 0)
  const selectionEnd = lineStart + rewritten.join('\n').length
  return { value: nextValue, selectionStart: lineStart, selectionEnd }
}

const INDENT = '  '

/** Tab / ⇧Tab inside a list. Returns null when no selected line is a list item. */
export function indentSelection(
  value: string,
  from: number,
  to: number,
  direction: 'in' | 'out',
): TextEdit | null {
  const lines = value.split('\n')
  const { first, last } = selectedLines(value, from, to)
  const range = lines.slice(first, last + 1)
  if (!range.some((l) => parseListLine(l))) return null

  let delta = 0
  let firstDelta = 0
  const rewritten = range.map((line, i) => {
    if (!parseListLine(line)) return line
    let next = line
    if (direction === 'in') {
      next = INDENT + line
      // A freshly nested ordered item starts its own run at 1. `renumber`
      // seeds a level from the first item it sees there, so without this the
      // new sub-list would inherit the outer list's numbering.
      const nested = parseListLine(next)
      if (nested?.kind === 'ordered') next = `${markerFor(nested, 1)}${nested.content}`
    } else if (line.startsWith(INDENT)) {
      next = line.slice(INDENT.length)
    } else if (/^\s/.test(line)) {
      next = line.replace(/^\s+/, '')
    }
    const d = next.length - line.length
    if (i === 0) firstDelta = d
    delta += d
    return next
  })

  const nextLines = [...lines.slice(0, first), ...rewritten, ...lines.slice(last + 1)]
  return {
    value: renumber(nextLines.join('\n')),
    selectionStart: Math.max(0, from + firstDelta),
    selectionEnd: Math.max(0, to + delta),
  }
}

/**
 * Wrap (or unwrap) the selection in an inline marker — `**bold**`, `_italic_`,
 * `` `code` ``.
 */
export function wrapSelection(value: string, from: number, to: number, marker: string): TextEdit {
  const selected = value.slice(from, to)
  const outerStart = from - marker.length
  const alreadyOutside =
    outerStart >= 0 &&
    value.slice(outerStart, from) === marker &&
    value.slice(to, to + marker.length) === marker
  if (alreadyOutside) {
    const next = value.slice(0, outerStart) + selected + value.slice(to + marker.length)
    return { value: next, selectionStart: outerStart, selectionEnd: outerStart + selected.length }
  }
  if (
    selected.startsWith(marker) &&
    selected.endsWith(marker) &&
    selected.length > marker.length * 2
  ) {
    const inner = selected.slice(marker.length, selected.length - marker.length)
    const next = value.slice(0, from) + inner + value.slice(to)
    return { value: next, selectionStart: from, selectionEnd: from + inner.length }
  }
  const next = value.slice(0, from) + marker + selected + marker + value.slice(to)
  return {
    value: next,
    selectionStart: from + marker.length,
    selectionEnd: from + marker.length + selected.length,
  }
}

/** Insert a Markdown link and select the destination for replacement. */
export function wrapLink(value: string, from: number, to: number): TextEdit {
  const label = (value.slice(from, to) || 'link text').replace(/([\\[\]])/g, '\\$1')
  const destination = 'https://'
  const inserted = `[${label}](${destination})`
  const selectionStart = from + label.length + 3
  return {
    value: value.slice(0, from) + inserted + value.slice(to),
    selectionStart,
    selectionEnd: selectionStart + destination.length,
  }
}

/** Wrap the selection in a fenced code block on its own lines. */
export function wrapCodeBlock(value: string, from: number, to: number): TextEdit {
  const selected = value.slice(from, to)
  const before = from > 0 && value[from - 1] !== '\n' ? '\n' : ''
  const after = to < value.length && value[to] !== '\n' ? '\n' : ''
  const block = `${before}\`\`\`\n${selected}\n\`\`\`${after}`
  const next = value.slice(0, from) + block + value.slice(to)
  const caret = from + before.length + 4
  return { value: next, selectionStart: caret, selectionEnd: caret + selected.length }
}

/**
 * Paste multi-line text into a list.
 *
 * Every pasted line after the first inherits the current item's marker, so
 * pasting three lines into a bullet list yields three bullets rather than one
 * bullet followed by two orphan lines. Returns null when the caret is not on a
 * list item, leaving the browser's own paste alone.
 */
export function pasteIntoList(value: string, caret: number, pasted: string): TextEdit | null {
  if (!pasted.includes('\n')) return null
  const { start, text } = lineAt(value, caret)
  const parsed = parseListLine(text)
  if (!parsed) return null
  if (caret < start + parsed.prefix.length) return null
  // Text that is already a list pastes verbatim; re-marking it would double up.
  const pastedLines = pasted.split('\n')
  if (pastedLines.some((l) => l.trim() !== '' && parseListLine(l))) return null

  const marker = markerFor(parsed)
  const body = pastedLines
    .map((line, i) => (i === 0 ? line : line.trim() === '' ? line : `${marker}${line}`))
    .join('\n')
  const next = value.slice(0, caret) + body + value.slice(caret)
  const caretNext = caret + body.length
  return { value: renumber(next), selectionStart: caretNext, selectionEnd: caretNext }
}
