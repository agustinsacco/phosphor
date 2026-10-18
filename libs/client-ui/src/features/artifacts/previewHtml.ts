/**
 * The HTML an artifact PRINTS as — which is the HTML it is previewing as.
 *
 * Two shapes reach the exporter. An `html` (or `svg`) artifact already IS
 * markup, so it prints from its source and comes out byte-identical to the
 * iframe. Every other type is drawn by a React component — react-markdown,
 * mermaid's rendered `<svg>`, a Chart.js canvas, Shiki's inline-coloured
 * `<pre>` — and nothing reconstructs those in the main process. That is what
 * the first version of this tried, with `marked` and `mermaid` from a CDN, and
 * an artifact CSP that grants no network is exactly why it produced empty
 * pages. So the rendered DOM is serialised instead: what you see is what you
 * print, with no second renderer to keep in sync.
 */

/** Chrome that lives inside a preview and must not appear in a document. */
const CHROME_SELECTOR = 'button, [role="button"], [data-print-hide]'

/**
 * Serialise a rendered preview subtree.
 *
 * A `<canvas>` (Chart.js) serialises to nothing at all — the bitmap is not in
 * the markup — so each one is swapped for its own `toDataURL()` image. The
 * artifact CSP allows `img-src data:`, which is what makes that legal in the
 * printed document.
 */
export function serializePreview(node: HTMLElement): string {
  const clone = node.cloneNode(true) as HTMLElement

  const sourceCanvases = [...node.querySelectorAll('canvas')]
  const clonedCanvases = [...clone.querySelectorAll('canvas')]
  clonedCanvases.forEach((cloned, index) => {
    const source = sourceCanvases[index]
    const image = clone.ownerDocument.createElement('img')
    try {
      if (source) image.src = source.toDataURL('image/png')
    } catch {
      // A tainted canvas cannot be read; drop the image rather than fail the export.
    }
    image.style.maxWidth = '100%'
    cloned.replaceWith(image)
  })

  for (const element of clone.querySelectorAll(CHROME_SELECTOR)) element.remove()

  return clone.innerHTML
}

/**
 * Wrap what the preview produced for the printed page.
 *
 * `.wrap` is the house sheet's column; an SVG artifact is centred the way its
 * preview centres it. An HTML artifact is passed through untouched — it owns
 * its own layout, and wrapping a full document in a `<div>` would nest it.
 */
export function printableHtml(type: string, content: string, rendered?: string): string {
  switch (type) {
    case 'html':
      return content
    case 'svg':
      return `<div style="display:grid;place-items:center;min-height:88vh">${content}</div>`
    default:
      return `<div class="wrap">${rendered ?? ''}</div>`
  }
}

/** Types whose preview is React-rendered, so the export needs the live DOM. */
export function needsRenderedPreview(type: string): boolean {
  return type !== 'html' && type !== 'svg'
}

/**
 * What has to exist in the preview before it is worth serialising.
 *
 * Mermaid and Chart.js both render asynchronously (a dynamic import, then a
 * layout pass), so a click that arrives a moment after the pane opens would
 * otherwise print the placeholder.
 */
export function previewReadySelector(type: string): string | null {
  if (type === 'mermaid') return 'svg'
  if (type === 'chart') return 'canvas, .code-block'
  return null
}

/**
 * Poll for the preview node — and, when the type needs one, for the element
 * that says its async render finished. Resolves with `null` on timeout, which
 * the caller reports rather than printing a blank page.
 */
export async function waitForPreview(
  getNode: () => HTMLElement | null,
  requiredSelector: string | null,
  timeoutMs = 4000,
  pollMs = 50,
): Promise<HTMLElement | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const node = getNode()
    if (node && (!requiredSelector || node.querySelector(requiredSelector))) return node
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}
