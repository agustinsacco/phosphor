// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  needsRenderedPreview,
  previewReadySelector,
  printableHtml,
  serializePreview,
  waitForPreview,
} from './previewHtml'

function preview(html: string): HTMLElement {
  const node = document.createElement('div')
  node.innerHTML = html
  document.body.append(node)
  return node
}

describe('serializePreview', () => {
  it('keeps the rendered markup, including a mermaid SVG', () => {
    const node = preview('<h1>Plan</h1><svg><text>step</text></svg>')
    expect(serializePreview(node)).toBe('<h1>Plan</h1><svg><text>step</text></svg>')
  })

  it('drops preview chrome — a copy button is not part of the document', () => {
    const node = preview('<pre>code</pre><button aria-label="Copy">copy</button>')
    expect(serializePreview(node)).toBe('<pre>code</pre>')
  })

  it('swaps a canvas for its own bitmap, since markup carries no pixels', () => {
    const node = preview('<canvas></canvas>')
    const canvas = node.querySelector('canvas')!
    canvas.toDataURL = () => 'data:image/png;base64,AAA'
    const html = serializePreview(node)
    expect(html).toContain('<img src="data:image/png;base64,AAA"')
    expect(html).not.toContain('<canvas')
  })

  it('leaves the live preview untouched', () => {
    const node = preview('<p>x</p><button>copy</button>')
    serializePreview(node)
    expect(node.querySelector('button')).not.toBeNull()
  })
})

describe('printableHtml', () => {
  it('passes HTML through — it owns its own layout', () => {
    expect(printableHtml('html', '<section>hi</section>')).toBe('<section>hi</section>')
  })

  it('centres an SVG the way its preview centres it', () => {
    expect(printableHtml('svg', '<svg/>')).toContain('place-items:center')
  })

  it('wraps rendered output in the house column', () => {
    expect(printableHtml('markdown', '# raw', '<h1>raw</h1>')).toBe(
      '<div class="wrap"><h1>raw</h1></div>',
    )
  })
})

describe('needsRenderedPreview / previewReadySelector', () => {
  it('only the types React draws need the live DOM', () => {
    expect(needsRenderedPreview('html')).toBe(false)
    expect(needsRenderedPreview('svg')).toBe(false)
    expect(needsRenderedPreview('markdown')).toBe(true)
    expect(needsRenderedPreview('chart')).toBe(true)
  })

  it('waits for the async renderers, and nothing else', () => {
    expect(previewReadySelector('mermaid')).toBe('svg')
    expect(previewReadySelector('chart')).toContain('canvas')
    expect(previewReadySelector('markdown')).toBeNull()
  })
})

describe('waitForPreview', () => {
  it('resolves once the async render lands', async () => {
    const node = preview('<div>placeholder</div>')
    setTimeout(() => {
      node.innerHTML = '<svg></svg>'
    }, 30)
    expect(await waitForPreview(() => node, 'svg', 1000, 10)).toBe(node)
  })

  it('gives up rather than printing a blank page', async () => {
    const node = preview('<div>placeholder</div>')
    expect(await waitForPreview(() => node, 'svg', 60, 10)).toBeNull()
  })

  it('resolves immediately when no element is required', async () => {
    const node = preview('<p>done</p>')
    expect(await waitForPreview(() => node, null, 1000, 10)).toBe(node)
  })
})
