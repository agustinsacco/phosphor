// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CodeBlock } from './CodeBlock'
import { highlightCode } from './highlighter'
vi.mock('./highlighter', () => ({ highlightCode: vi.fn() }))
vi.mock('@/stores/terminal', () => ({ runInTerminal: vi.fn() }))
vi.mock('@/stores/workspaces', () => ({ getActiveWorkspace: () => undefined }))
let root: Root
let el: HTMLDivElement
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
  vi.mocked(highlightCode).mockReset()
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})
it.each(['text', 'plaintext', 'txt', ''])(
  'renders captured %s literally without loading the syntax engine',
  async (language) => {
    await act(async () =>
      root.render(<CodeBlock code={'<img src=x onerror="bad()">'} language={language} />),
    )
    expect(el.querySelector('pre')?.textContent).toBe('<img src=x onerror="bad()">')
    expect(el.querySelector('img')).toBeNull()
    expect(highlightCode).not.toHaveBeenCalled()
  },
)
it('falls back safely if syntax highlighting fails, without retaining stale HTML', async () => {
  vi.mocked(highlightCode).mockResolvedValue('<pre><code>old highlight</code></pre>')
  await act(async () => root.render(<CodeBlock code="old" language="js" />))
  vi.mocked(highlightCode).mockRejectedValue(new Error('WASM refused by CSP'))
  await act(async () => root.render(<CodeBlock code="new text" language="js" />))
  expect(el.querySelector('pre')?.textContent).toBe('new text')
  expect(el.textContent).not.toContain('old highlight')
})
