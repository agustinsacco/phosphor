const ELEMENTS = new Set(
  'article section header footer main nav aside div span p br hr h1 h2 h3 h4 h5 h6 strong em b i u s pre code blockquote ul ol li dl dt dd table thead tbody tfoot tr th td caption figure figcaption details summary'.split(
    ' ',
  ),
)
const DROP = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'template',
  'svg',
  'math',
  'link',
  'meta',
  'base',
  'form',
  'input',
  'button',
  'textarea',
  'select',
])
const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** Static, opaque-origin preview. No authored attributes, CSS, scripts or URL-bearing elements survive. */
export function staticArtifactPreview(html: string): string {
  if (typeof html !== 'string' || new TextEncoder().encode(html).length > 2 * 1024 * 1024)
    throw new Error('Preview too large.')
  // Template contents have no browsing context and are never adopted into the page.
  // Unlike a parsed HTML document, they cannot start image/iframe resource loads.
  const template = document.createElement('template')
  template.innerHTML = html
  let nodes = 0
  function render(node: Node, depth: number): string {
    if (++nodes > 50_000 || depth > 100) throw new Error('Preview too complex.')
    if (node.nodeType === 3) return escape(node.textContent ?? '')
    if (node.nodeType !== 1) return ''
    const name = (node as Element).localName.toLowerCase()
    if (DROP.has(name)) return ''
    const children = Array.from(node.childNodes)
      .map((child) => render(child, depth + 1))
      .join('')
    return ELEMENTS.has(name) ? `<${name}>${children}</${name}>` : children
  }
  const content = Array.from(template.content.childNodes)
    .map((node) => render(node, 0))
    .join('')
  const policy =
    "default-src 'none'; script-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}"><meta charset="utf-8">${content}`)}`
}
