// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { COMPACT_PLATFORM, PlatformProvider } from '@/platform/Platform'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useMachineCataloguesStore } from '@/stores/machineCatalogues'
import { useRemoteModelPicks } from '@/stores/remoteModelPicks'
import { RemoteModelPicker, useRemoteModel } from './RemoteModelPicker'

let root: Root
let el: HTMLDivElement
let restore: () => void
let fake: ReturnType<typeof createFakePhosphor>
let attempts: number
function Picker(): React.JSX.Element {
  const selection = useRemoteModel(MOCK_HOST_ID)
  return <RemoteModelPicker selection={selection} />
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  attempts = 0
  fake = createFakePhosphor({
    'hosts:skills': () => ({ skills: [], probe: 'rpc', userRoot: 'opaque' }),
    'hosts:models': () => {
      if (++attempts === 1) throw new Error('temporary failure')
      return [{ id: 'model', name: 'Recovered model', provider: 'p', reasoning: false }]
    },
    'hosts:providers': () => [{ id: 'p', name: 'Provider', status: 'ready' }],
  })
  restore = installFakePhosphor(fake)
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  host.capabilities.push('skills.read')
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host } })
  useMachineCataloguesStore.setState({ catalogues: {} })
  useRemoteModelPicks.setState({ last: {}, thinking: {} })
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  restore()
  fake.dispose()
  vi.restoreAllMocks()
})
it('lets the user retry a failed initial catalogue read without leaving the composer', async () => {
  await act(async () =>
    root.render(
      <PlatformProvider value={COMPACT_PLATFORM}>
        <Picker />
      </PlatformProvider>,
    ),
  )
  const retry = [...el.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Retry models'),
  )
  expect(retry).toBeDefined()
  await act(async () => retry!.click())
  expect(el.textContent).toContain('Recovered model')
  expect(attempts).toBe(2)
})

// Expanded width uses the composer's chips instead: RemoteModelPicker.expanded.test.tsx.
it.each([COMPACT_PLATFORM])(
  'offers the same accessible bounded model dialog without native reads at $formFactor width',
  async (platform) => {
    attempts = 1
    await act(async () =>
      root.render(
        <PlatformProvider value={platform}>
          <Picker />
        </PlatformProvider>,
      ),
    )
    const trigger = el.querySelector<HTMLButtonElement>('[aria-label="Model"]')!
    await act(async () => trigger.click())
    const dialog = document.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Choose model"]',
    )!
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.textContent).toContain('The Host does not expose a default model.')
    const radio = dialog.querySelector<HTMLInputElement>('input[type=radio]')!
    expect(radio.checked).toBe(true)
    const search = dialog.querySelector<HTMLInputElement>('[aria-label="Search models"]')!
    expect(document.activeElement).toBe(search)
    const done = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Done')!
    act(() => done.focus())
    act(() => {
      done.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
      )
    })
    expect(document.activeElement).toBe(search)
    await act(async () =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    )
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  },
)
