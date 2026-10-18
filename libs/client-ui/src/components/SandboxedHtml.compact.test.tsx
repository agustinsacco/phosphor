// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { SandboxedHtml } from './SandboxedHtml'
import { readOnlyHtml } from './readOnlyHtml'
import { COMPACT_PLATFORM, DESKTOP_PLATFORM, PlatformProvider } from '@/platform/Platform'
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) => selector({ resolvedTheme: 'dark' }),
}))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
it('prepends network/script denial before untrusted markup and removes navigation markup', () => {
  const html = readOnlyHtml(
    '<meta http-equiv="refresh" content="0;url=https://invalid.test"><base href="https://invalid.test"><script>alert(1)</script><a href="https://invalid.test">safe label</a><img src="https://invalid.test/image" onerror="alert(1)"><style>p{background:url(https://invalid.test)}</style>',
  )
  expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('safe label'))
  expect(html).toContain("connect-src 'none'")
  expect(html).toContain("script-src 'none'")
  expect(html).toContain('img-src data:')
  expect(html).not.toMatch(/<script|<base|http-equiv="refresh"|href=|onerror=/)
})
it('uses an opaque script-free Blob and revokes it on replacement and unmount', async () => {
  const create = vi.fn().mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second')
  const revoke = vi.fn()
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })
  const invoke = vi.fn()
  vi.stubGlobal('phosphor', { invoke })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const render = (html: string) =>
    root.render(
      <PlatformProvider value={COMPACT_PLATFORM}>
        <SandboxedHtml html={html} title="Preview" />
      </PlatformProvider>,
    )
  await act(async () => render('<p>first</p>'))
  expect(container.querySelector('iframe')?.getAttribute('sandbox')).toBe('')
  expect(container.querySelector('iframe')?.getAttribute('src')).toBe('blob:first')
  expect(container.querySelector('iframe')?.hasAttribute('srcdoc')).toBe(false)
  expect(invoke).not.toHaveBeenCalled()
  await act(async () => render('<p>second</p>'))
  expect(revoke).toHaveBeenCalledWith('blob:first')
  await act(async () => root.unmount())
  expect(revoke).toHaveBeenCalledWith('blob:second')
  container.remove()
})
it('preserves Desktop staged script sandbox without same-origin', async () => {
  const invoke = vi.fn(async () => 'phosphor-artifact://preview/token')
  vi.stubGlobal('phosphor', { invoke })
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () =>
    root.render(
      <PlatformProvider value={DESKTOP_PLATFORM}>
        <SandboxedHtml html="<p>Desktop</p>" title="Preview" />
      </PlatformProvider>,
    ),
  )
  expect(invoke).toHaveBeenCalledWith('artifacts:stageHtml', '<p>Desktop</p>', 'dark')
  expect(container.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts')
  await act(async () => root.unmount())
})
