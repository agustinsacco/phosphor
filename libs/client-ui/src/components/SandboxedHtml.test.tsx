// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { SandboxedHtml } from './SandboxedHtml'
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (s: { resolvedTheme: string }) => unknown) =>
    selector({ resolvedTheme: 'dark' }),
}))

it('stages model HTML locally and keeps its iframe origin opaque without srcdoc', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const invoke = vi.fn(async () => 'phosphor-artifact://staged/document')
  vi.stubGlobal('phosphor', { invoke })
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(<SandboxedHtml html="<script>hello()</script>" title="Remote artifact" />),
    )
    expect(invoke).toHaveBeenCalledWith(
      'artifacts:stageHtml',
      '<script>hello()</script>',
      expect.any(String),
    )
    const iframe = container.querySelector('iframe')
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts')
    expect(iframe?.getAttribute('src')).toBe('phosphor-artifact://staged/document')
    expect(iframe?.hasAttribute('srcdoc')).toBe(false)
  } finally {
    act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})
