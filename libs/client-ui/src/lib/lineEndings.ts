/** The line break an editor keeps a file in. */
export type LineEnding = '\n' | '\r\n'

/**
 * The line ending an editor keeps `text` in, picked as Monaco picks its model's: CRLF when
 * more than half of the line breaks hold a CR (a lone CR counts), else LF. Null when the text
 * has no line break, so there is nothing to keep.
 */
export function dominantLineEnding(text: string): LineEnding | null {
  let breaks = 0
  let withCr = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 13) {
      breaks++
      withCr++
      if (text.charCodeAt(i + 1) === 10) i++
    } else if (code === 10) breaks++
  }
  if (!breaks) return null
  return withCr > breaks / 2 ? '\r\n' : '\n'
}

/** `text` with every line break (CRLF, a lone CR or LF) written as `ending`. */
export function withLineEnding(text: string, ending: LineEnding): string {
  return text.replace(/\r\n?|\n/g, ending)
}
