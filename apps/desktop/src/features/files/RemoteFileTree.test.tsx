// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { RemoteFileTree } from './RemoteFileTree'
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('./MonacoEditor', () => ({ releaseFileModel: vi.fn() }))
afterEach(() => vi.unstubAllGlobals())
it('shows loading, empty and bounded tree refusal rather than raw toolbar text or partial trees', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'),
    root = createRoot(container)
  const render = (files: string[], loading = false) =>
    act(() =>
      root.render(
        <RemoteFileTree files={files} selected={null} onSelect={() => {}} loading={loading} />,
      ),
    )
  try {
    render([], true)
    expect(container.textContent).toContain('Loading')
    render([])
    expect(container.textContent).toBe('No files yet')
    render([Array(64).fill('a').join('/')])
    expect(container.querySelectorAll('[role=treeitem]')).toHaveLength(64)
    render([Array(65).fill('a').join('/')])
    expect(container.textContent).toContain('Not available')
    expect(container.querySelector('[role=tree]')).toBeNull()
    render(Array.from({ length: 17000 }, (_v, i) => `dir${i}/sub/file`))
    expect(container.querySelector('[role=tree]')).toBeNull()
  } finally {
    act(() => root.unmount())
  }
})
