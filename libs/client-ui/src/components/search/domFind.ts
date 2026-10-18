import { findMatches, type TextRange } from '@shared/text-search'

/**
 * Finding text in RENDERED content — the transcript's rows, an artifact's
 * preview or source — and painting it.
 *
 * Painting uses the CSS Custom Highlight API rather than wrapping matches in
 * `<mark>`: a match routinely spans several of shiki's token spans or crosses
 * a markdown `<strong>`, and React owns all of that DOM. Mutating it would
 * fight the next render (and, for dangerouslySetInnerHTML code blocks, be
 * silently undone). A Range paints over whatever nodes it spans and touches
 * nothing. jsdom has no `CSS.highlights`, so painting is feature-detected and
 * everything else here still runs under test.
 */

/**
 * Subtrees a reader cannot see or that are chrome, not content: copy-button
 * labels, screen-reader text, a collapsed activity body (`aria-hidden` while
 * closed), form fields — and KaTeX math, whole. Its visible half is glyph
 * boxes in layout order and its MathML twin is visually hidden, so neither
 * reads back as anything a reader would type; `markdownText` drops math too,
 * so the transcript's count agrees.
 */
const SKIP_SELECTOR = [
  '[data-find-skip]',
  '[aria-hidden="true"]',
  '[hidden]',
  '.sr-only',
  '.katex',
  'script',
  'style',
  'noscript',
  'template',
  'textarea',
  'input',
  'select',
].join(', ')

/**
 * Tags that break a line of text. Their boundaries become a newline in the
 * joined text, so a query cannot match across two paragraphs or two table
 * cells that merely sit next to each other in the DOM.
 */
const BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'BR',
  'DD',
  'DETAILS',
  'DIV',
  'DL',
  'DT',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'SUMMARY',
  'TABLE',
  'TBODY',
  'TD',
  'TFOOT',
  'TH',
  'THEAD',
  'TR',
  'UL',
])

/** A subtree's visible text, joined, with a map back to its text nodes. */
export interface TextIndex {
  text: string
  nodes: Text[]
  /** Offset in `text` where each of `nodes` begins. */
  starts: number[]
}

/** `white-space` (and `white-space-collapse`) values that show a source line break as one. */
const KEEPS_BREAKS = /^(?:pre|pre-wrap|pre-line|break-spaces|preserve|preserve-breaks)$/

/**
 * Index `root`'s visible text.
 *
 * Where white-space collapses, a line break or tab in a text node shows as a
 * space — markdown's soft breaks (`brown\nfox` in one `<p>`) are the common
 * case — so it is indexed as one, and `brown fox` matches what the reader
 * sees. The swap is character for character, so offsets still map 1:1 onto
 * the node. Whitespace alone at the start of a line shows as nothing, and is
 * left out.
 */
export function indexText(root: Node): TextIndex {
  const nodes: Text[] = []
  const starts: number[] = []
  let text = ''
  const lineBreak = (): void => {
    if (text !== '' && !text.endsWith('\n')) text += '\n'
  }
  const keepsBreaks = new Map<Element, boolean>()
  const collapses = (parent: Element | null): boolean => {
    if (!parent) return true
    let keeps = keepsBreaks.get(parent)
    if (keeps === undefined) {
      // PRE by tag as well: jsdom's computed style does not inherit it.
      const style = getComputedStyle(parent)
      keeps =
        parent.closest('pre') !== null ||
        KEEPS_BREAKS.test(style.whiteSpace) ||
        KEEPS_BREAKS.test(style.getPropertyValue('white-space-collapse'))
      keepsBreaks.set(parent, keeps)
    }
    return !keeps
  }
  const walk = (parent: Node): void => {
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === Node.TEXT_NODE) {
        let value = (child as Text).data
        if (value === '') continue
        // Only a node holding a break pays for the style lookup.
        if (/[\n\r\t]/.test(value) && collapses(child.parentElement)) {
          if (/^[ \n\r\t]*$/.test(value) && (text === '' || text.endsWith('\n'))) continue
          value = value.replace(/[\n\r\t]/g, ' ')
        }
        nodes.push(child as Text)
        starts.push(text.length)
        text += value
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const element = child as Element
        if (element.matches(SKIP_SELECTOR)) continue
        const block = BLOCK_TAGS.has(element.tagName)
        if (block) lineBreak()
        walk(element)
        if (block) lineBreak()
      }
    }
  }
  walk(root)
  return { text, nodes, starts }
}

/** Index of the last node starting at or before `offset`. */
function nodeAt(index: TextIndex, offset: number): number {
  let low = 0
  let high = index.starts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (index.starts[mid]! <= offset) low = mid
    else high = mid - 1
  }
  return low
}

/**
 * DOM Ranges for matches found in `index.text`.
 *
 * A match edge can land on one of the synthetic block newlines, which belongs
 * to no node (only a regex can match one). The start then snaps forward to
 * the next node and the end back to the previous one.
 */
function rangesFor(index: TextIndex, matches: TextRange[]): Range[] {
  if (index.nodes.length === 0) return []
  const ranges: Range[] = []
  for (const match of matches) {
    let startNode = nodeAt(index, match.start)
    let startOffset = match.start - index.starts[startNode]!
    if (startOffset >= index.nodes[startNode]!.length && startNode + 1 < index.nodes.length) {
      startNode++
      startOffset = 0
    }
    const endNode = nodeAt(index, Math.max(match.start, match.end - 1))
    const endOffset = Math.min(match.end - index.starts[endNode]!, index.nodes[endNode]!.length)
    if (endNode < startNode) continue
    const range = document.createRange()
    try {
      range.setStart(index.nodes[startNode]!, Math.min(startOffset, index.nodes[startNode]!.length))
      range.setEnd(index.nodes[endNode]!, endOffset)
    } catch {
      continue
    }
    if (!range.collapsed) ranges.push(range)
  }
  return ranges
}

/**
 * Ranges for every match of `regex` under `root`, up to `limit`. Pass an index
 * already taken of `root` to skip the walk.
 */
export function findRanges(
  root: Node,
  regex: RegExp,
  limit: number,
  index: TextIndex = indexText(root),
): Range[] {
  return rangesFor(index, findMatches(index.text, regex, limit))
}

/** How often a surface re-finds while its DOM keeps changing. */
const REFIND_EVERY_MS = 150

/** What counts as a content change: text, nodes, and what is hidden. */
const CONTENT_CHANGES: MutationObserverInit = {
  subtree: true,
  childList: true,
  characterData: true,
  attributes: true,
  attributeFilter: ['aria-hidden', 'hidden'],
}

/**
 * Call `onChange` once `root`'s text or what is hidden in it changes: a
 * streaming reply, shiki re-highlighting, rows mounting on scroll, a section
 * opening. At most every 150 ms while changes keep coming — a reply streams
 * for a minute, and its matches should appear as it grows, not once it stops.
 * Returns the disconnect.
 */
export function observeContent(root: HTMLElement, onChange: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const observer = new MutationObserver(() => {
    timer ??= setTimeout(() => {
      timer = undefined
      onChange()
    }, REFIND_EVERY_MS)
  })
  observer.observe(root, CONTENT_CHANGES)
  return () => {
    observer.disconnect()
    clearTimeout(timer)
  }
}

/**
 * `root`'s index, kept until its content changes. Walking a large artifact
 * costs far more than matching its text, and the query changes on every
 * keystroke while the content mostly does not.
 *
 * Changes not yet delivered to the observer are taken synchronously on read,
 * so an index is never served for a DOM React has just rewritten in the same
 * commit that asks for it.
 */
export function cacheIndex(root: HTMLElement): { read: () => TextIndex; disconnect: () => void } {
  let index: TextIndex | null = null
  const observer = new MutationObserver(() => {
    index = null
  })
  observer.observe(root, CONTENT_CHANGES)
  return {
    read: () => {
      if (observer.takeRecords().length > 0) index = null
      return (index ??= indexText(root))
    },
    disconnect: () => observer.disconnect(),
  }
}

// ---------------------------------------------------------------------------
// Painting

/** The `::highlight()` names index.css styles. */
const FIND_HIGHLIGHT = 'phosphor-find'
const FIND_HIGHLIGHT_ACTIVE = 'phosphor-find-active'

/**
 * Every surface's painted matches, by owner. The highlight registry is global
 * and keyed by name, so two open find bars (transcript and artifact) writing
 * the same name directly would erase each other; the union is repainted
 * instead.
 */
const painted = new Map<object, { all: Range[]; active: Range | null }>()

function highlightsSupported(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined'
}

function repaint(): void {
  if (!highlightsSupported()) return
  const all = new Highlight()
  const active = new Highlight()
  // Above the plain matches wherever both cover the same text.
  active.priority = 1
  for (const entry of painted.values()) {
    for (const range of entry.all) all.add(range)
    if (entry.active) active.add(entry.active)
  }
  if (all.size) CSS.highlights.set(FIND_HIGHLIGHT, all)
  else CSS.highlights.delete(FIND_HIGHLIGHT)
  if (active.size) CSS.highlights.set(FIND_HIGHLIGHT_ACTIVE, active)
  else CSS.highlights.delete(FIND_HIGHLIGHT_ACTIVE)
}

export function paintMatches(owner: object, all: Range[], active: Range | null): void {
  painted.set(owner, { all, active })
  repaint()
}

export function clearMatches(owner: object): void {
  if (painted.delete(owner)) repaint()
}

// ---------------------------------------------------------------------------
// Revealing

function scrollable(element: Element): { x: boolean; y: boolean } {
  const style = getComputedStyle(element)
  const canScroll = (value: string): boolean => value === 'auto' || value === 'scroll'
  return {
    x: canScroll(style.overflowX) && element.scrollWidth > element.clientWidth,
    y: canScroll(style.overflowY) && element.scrollHeight > element.clientHeight,
  }
}

/** Keep a revealed match at least this far inside its scroller's edges. */
const REVEAL_MARGIN = 24

function startElement(target: Range | Element): Element | null {
  if (target instanceof Element) return target
  const start = target.startContainer
  return start instanceof Element ? start : start.parentElement
}

/**
 * Where what `box` shows begins above `rect`: its top edge plus the margin,
 * pushed down past an open find bar that floats over that edge and covers
 * `rect`'s columns. A match under the bar is on screen, but no one can read it.
 */
function visibleTop(box: DOMRect, rect: DOMRect): number {
  let covered = 0
  for (const bar of document.querySelectorAll('[data-find-bar]')) {
    const edge = bar.getBoundingClientRect()
    const overTop = edge.top < box.top + REVEAL_MARGIN && edge.bottom > box.top
    const overColumns =
      edge.left < Math.min(box.right, rect.right) && edge.right > Math.max(box.left, rect.left)
    if (overTop && overColumns) covered = Math.max(covered, edge.bottom - box.top)
  }
  return box.top + covered + REVEAL_MARGIN
}

/** Whether `target` sits vertically inside `container`'s visible box, with the reveal margin. */
export function isVerticallyVisible(target: Range | Element, container: Element): boolean {
  if (typeof target.getBoundingClientRect !== 'function') return true
  const rect = target.getBoundingClientRect()
  const box = container.getBoundingClientRect()
  return rect.top >= visibleTop(box, rect) && rect.bottom <= box.bottom - REVEAL_MARGIN
}

/**
 * Scroll every scroller between a match (or the element standing in for it)
 * and `boundary`, inclusive, just far enough to show it — vertically centred
 * in the outer one when it has to move, horizontally inside the wide code
 * block or table that clips it. `scrollIntoView` would centre the whole
 * paragraph or code block, which for a 400-line block is nowhere near the
 * match, and would also scroll the app's own `overflow: hidden` frames.
 *
 * A closed `<details>` around the match (a compaction summary) is opened
 * first: its content has no layout until it is.
 */
export function revealRange(target: Range | Element, boundary: Element | null): void {
  for (let node = startElement(target); node && node !== boundary; node = node.parentElement) {
    if (node instanceof HTMLDetailsElement && !node.open) node.open = true
  }
  // jsdom: no layout, and no Range.getBoundingClientRect.
  if (typeof target.getBoundingClientRect !== 'function') return
  const margin = REVEAL_MARGIN
  let element = target instanceof Element ? target.parentElement : startElement(target)
  while (element) {
    const axes = scrollable(element)
    if (axes.x || axes.y) {
      const rect = target.getBoundingClientRect()
      const box = element.getBoundingClientRect()
      const top = visibleTop(box, rect)
      const bottom = box.bottom - margin
      if (axes.y && (rect.top < top || rect.bottom > bottom)) {
        // Centred when it fits; top-aligned when it is taller than the view,
        // so the start of a long block is what lands on screen.
        element.scrollTop +=
          rect.height > bottom - top
            ? rect.top - top
            : rect.top + rect.height / 2 - (top + bottom) / 2
      }
      if (axes.x && (rect.left < box.left + margin || rect.right > box.right - margin)) {
        element.scrollLeft += rect.left - box.left - Math.min(box.width / 3, 120)
      }
    }
    if (element === boundary) break
    element = element.parentElement
  }
}

/**
 * Pulse an element that holds a hit the page cannot paint — a match the
 * rendered view dropped (a diff past its fold, an image's alt) — so a jump
 * still lands somewhere the eye can find.
 */
export function flashElement(element: HTMLElement): void {
  element.classList.remove('find-flash')
  // Restart the animation when the same element is flashed twice in a row.
  void element.offsetWidth
  element.classList.add('find-flash')
  element.addEventListener('animationend', () => element.classList.remove('find-flash'), {
    once: true,
  })
}
