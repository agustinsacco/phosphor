// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { Markdown } from './Markdown'
vi.mock('./CodeBlock', () => ({ CodeBlock: () => null, InlineCode: () => null }))
vi.mock('./MermaidBlock', () => ({ MermaidBlock: () => null }))
vi.mock('./ChartBlock', () => ({ ChartBlock: () => null }))
vi.mock('./VegaLiteBlock', () => ({ VegaLiteBlock: () => null }))
vi.mock('./HtmlBlock', () => ({ HtmlBlock: () => null }))

it('does not resolve unverified child paths or artifact IDs in the parent namespace', () => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const el = document.createElement('div')
  const root = createRoot(el)
  const text = '[source](./src/index.ts) [saved](artifact://report) [web](https://example.com)'
  try {
    act(() => root.render(<Markdown text={text} inAppLinks={false} />))
    expect(el.textContent).toContain('source saved web')
    expect(el.querySelectorAll('a')).toHaveLength(1)
    expect(el.querySelector('a')?.href).toBe('https://example.com/')
    act(() => root.render(<Markdown text={text} />))
    expect(el.querySelectorAll('a')).toHaveLength(3)
  } finally {
    act(() => root.unmount())
  }
})
