// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ArtifactToolbar } from './ArtifactToolbar'
import { ContextMenuHost } from '@/components/ContextMenu'
import {
  COMPACT_PLATFORM,
  DESKTOP_PLATFORM,
  PlatformProvider,
  type Platform,
} from '@/platform/Platform'

const props: React.ComponentProps<typeof ArtifactToolbar> = {
  artifact: { id: 'guide', title: 'Guide', type: 'markdown', versions: [], updatedAt: 1 },
  shown: { version: 1, title: 'Guide', content: 'Guide', createdAt: 1 },
  mode: 'preview',
  setMode: () => {},
  selectVersion: () => {},
  reference: null,
  promoted: false,
  copyReference: () => {},
  saveTitle: 'Download source',
  save: async () => {},
  exporting: false,
  downloads: 'Downloads',
  exportPdf: async () => {},
  canWrite: true,
  writeIn: { refusal: undefined },
  write: () => {},
}
const roots: (() => void)[] = []
afterEach(() => {
  for (const dispose of roots.splice(0)) dispose()
  vi.unstubAllGlobals()
})
async function render(platform: Platform, overrides: Partial<typeof props> = {}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(() => {
    act(() => root.unmount())
    container.remove()
  })
  await act(async () =>
    root.render(
      <PlatformProvider value={platform}>
        <ArtifactToolbar {...props} {...overrides} />
        <ContextMenuHost />
      </PlatformProvider>,
    ),
  )
  const actions = container.querySelector<HTMLButtonElement>('[aria-label="Artifact actions"]')
  if (actions) await act(async () => actions.click())
  return container
}

it.each([
  [false, 'Available once pi reports the session.'],
  [true, 'The agent cannot read a code block copied here.'],
])('a phone explains why Copy reference is disabled (promoted=%s)', async (promoted, reason) => {
  await render(COMPACT_PLATFORM, { promoted })
  const copy = [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
    node.textContent?.includes('Copy reference'),
  )
  expect(copy?.disabled).toBe(true)
  expect(copy?.textContent).toContain(reason)
})
it('a phone uses a concise Write in Files label and keeps its refusal visible', async () => {
  await render(COMPACT_PLATFORM, { writeIn: { refusal: 'Take control first.' } })
  const write = [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
    node.textContent?.includes('Write in Files'),
  )
  expect(write?.disabled).toBe(true)
  expect(write?.textContent).toContain('Take control first.')
})
it('Desktop keeps its existing write action and reference tooltip', async () => {
  const container = await render(DESKTOP_PLATFORM)
  expect(
    container.querySelector('[aria-label="Write into workspace and open in Files"]'),
  ).not.toBeNull()
  expect(
    container.querySelector(
      '[aria-label="Copy reference (available once pi reports the session)"]',
    ),
  ).not.toBeNull()
})
