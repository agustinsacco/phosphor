// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PageBody } from './PageBody'
import { PageShell } from './PageShell'
import { COMPACT_PLATFORM, DESKTOP_PLATFORM, PlatformProvider } from '@/platform/Platform'

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
})

it.each([
  DESKTOP_PLATFORM,
  COMPACT_PLATFORM,
  { ...COMPACT_PLATFORM, formFactor: 'expanded' as const },
])(
  'uses one content column and title at $formFactor width regardless of capabilities',
  (platform) => {
    act(() =>
      root.render(
        <PlatformProvider value={platform}>
          <PageShell title="Library" actions={<button>Create</button>}>
            <PageBody data-testid="library" className="library-page">
              <section>All library content</section>
            </PageBody>
          </PageShell>
        </PlatformProvider>,
      ),
    )
    expect(container.querySelectorAll('h1')).toHaveLength(1)
    expect(container.querySelectorAll('.page-body-content')).toHaveLength(1)
    expect(container.querySelector('.page-body-content')?.textContent).toBe('All library content')
    expect(container.querySelector('[data-testid="library"]')?.className).toBe(
      'page-body page-body-scroll library-page',
    )
    expect(container.querySelector('.page-shell-actions')?.textContent).toBe('Create')
  },
)

it('supports bounded editor/list content without adding a second scrolling body', () => {
  act(() =>
    root.render(
      <PageBody layout="fill">
        <div>Scrollable editor</div>
      </PageBody>,
    ),
  )
  expect(container.querySelector('.page-body-fill')).not.toBeNull()
  expect(container.querySelector('.page-body-scroll')).toBeNull()
  expect(container.querySelectorAll('.page-body-content')).toHaveLength(1)
})
