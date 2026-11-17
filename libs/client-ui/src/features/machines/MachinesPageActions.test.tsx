// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import {
  COMPACT_PLATFORM,
  DESKTOP_PLATFORM,
  PlatformProvider,
  WIDE_BROWSER_PLATFORM,
  type Platform,
} from '@/platform/Platform'
import { MachinesPageActions } from './MachinesPageActions'

let root: Root | null = null
let container: HTMLDivElement

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  container.remove()
})

function render(platform: Platform): HTMLDivElement {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() =>
    root!.render(
      <PlatformProvider value={platform}>
        <MachinesPageActions
          signedIn
          onAdd={() => {}}
          logOpen={false}
          onToggleLog={() => {}}
          onOpenLog={() => {}}
        />
      </PlatformProvider>,
    ),
  )
  return container
}

const debugLog = (el: HTMLElement) => el.querySelector('[aria-label="Debug log"]')

it('offers the debug log on Desktop, whose main process keeps it', () => {
  expect(debugLog(render(DESKTOP_PLATFORM))).not.toBeNull()
})

// The browser refuses hosts:traffic, so the panel could only ever say "Not updating".
it.each([COMPACT_PLATFORM, WIDE_BROWSER_PLATFORM])(
  'offers no debug log in the browser ($formFactor)',
  (platform) => {
    expect(debugLog(render(platform))).toBeNull()
  },
)
