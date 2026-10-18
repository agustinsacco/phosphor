/**
 * How much of an autocomplete suggestion a field can show.
 *
 * The composer grows with what you typed, not with the suggestion, so a long
 * one wraps below the field and is clipped. Accepting it would then insert
 * words nobody saw. A suggestion is cut to whole words instead, and what is
 * shown is exactly what Tab inserts.
 */

/**
 * The longest run of whole words whose last character `isVisible` accepts, or
 * null when not even the first one fits. `isVisible(end)` is asked about the
 * character just before `end`. Words wrap in order, so the first word that
 * falls outside ends the run.
 */
export function fitGhost(full: string, isVisible: (end: number) => boolean): string | null {
  let shown: string | null = null
  for (const match of full.matchAll(/\s*\S+/g)) {
    const end = match.index + match[0].length
    if (!isVisible(end)) break
    shown = full.slice(0, end)
  }
  return shown
}

/**
 * `isVisible` for a ghost text node drawn inside `box`, which clips it. Null
 * when there is no layout to measure (jsdom, a hidden window): the caller then
 * keeps the whole suggestion, as it did before measuring.
 */
export function ghostVisibility(
  box: HTMLElement,
  text: Node | null,
): ((end: number) => boolean) | null {
  if (!(text instanceof Text)) return null
  const range = text.ownerDocument.createRange()
  if (typeof range.getBoundingClientRect !== 'function') return null
  const bounds = box.getBoundingClientRect()
  if (bounds.height === 0) return null
  return (end) => {
    range.setStart(text, end - 1)
    range.setEnd(text, end)
    const rect = range.getBoundingClientRect()
    return rect.top >= bounds.top - 0.5 && rect.bottom <= bounds.bottom + 0.5
  }
}
