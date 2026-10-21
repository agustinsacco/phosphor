// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { DEFAULT_APP_PREFS } from '@shared/models/prefs'
import { DESKTOP_PLATFORM, PlatformProvider, WIDE_BROWSER_PLATFORM } from '@/platform/Platform'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useMachineCataloguesStore } from '@/stores/machineCatalogues'
import { useRemoteModelPicks } from '@/stores/remoteModelPicks'
import { useModelPicksStore } from '@/stores/modelPicks'
import { RemoteModelPicker, useRemoteModel } from './RemoteModelPicker'

let root: Root
let el: HTMLDivElement
let restore: () => void
let fake: ReturnType<typeof createFakePhosphor>
const savePicks = vi.fn()
function Picker(): React.JSX.Element {
  const selection = useRemoteModel(MOCK_HOST_ID)
  return <RemoteModelPicker selection={selection} />
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  savePicks.mockClear()
  useModelPicksStore.setState({ starred: [], recent: [], groupMode: 'family', hydrated: false })
  fake = createFakePhosphor({
    'hosts:skills': () => ({ skills: [], probe: 'rpc', userRoot: 'opaque' }),
    'hosts:models': () => [
      { id: 'opus', name: 'Claude Opus 5.5', provider: 'p', reasoning: true },
      { id: 'haiku', name: 'Claude Haiku', provider: 'p', reasoning: false },
    ],
    'hosts:providers': () => [{ id: 'p', name: 'Provider', status: 'ready' }],
    'app:getPrefs': () => DEFAULT_APP_PREFS,
    'app:setModelPicks': savePicks,
  })
  restore = installFakePhosphor(fake)
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  host.capabilities.push('skills.read')
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host } })
  useMachineCataloguesStore.setState({ catalogues: {} })
  useRemoteModelPicks.setState({ last: {}, thinking: { [MOCK_HOST_ID]: 'high' } })
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

it.each([DESKTOP_PLATFORM, WIDE_BROWSER_PLATFORM])(
  'uses the composer chip and model menu, not a dialog, at expanded width (localLanes: $localLanes)',
  async (platform) => {
    await act(async () =>
      root.render(
        <PlatformProvider value={platform}>
          <Picker />
        </PlatformProvider>,
      ),
    )
    const chip = el.querySelector<HTMLButtonElement>('[data-testid="remote-model-picker"]')
    expect(chip?.textContent).toBe('Claude Opus 5.5')
    const thinking = el.querySelector<HTMLButtonElement>('[data-testid="remote-thinking-picker"]')
    expect(thinking?.textContent).toBe('High')
    await act(async () => thinking!.click())
    const low = [...document.querySelectorAll<HTMLButtonElement>('[data-popup-menu] button')].find(
      (button) => button.textContent === 'Low',
    )!
    await act(async () => low.click())
    expect(thinking!.textContent).toBe('Low')
    expect(useRemoteModelPicks.getState().thinking[MOCK_HOST_ID]).toBe('low')
    expect(document.querySelector('[data-popup-menu]')).toBeNull()

    await act(async () => chip!.click())
    expect(document.querySelector('[role="dialog"][aria-label="Choose model"]')).toBeNull()
    const list = document.querySelector<HTMLElement>('[data-testid="model-list"]')!
    expect(list.textContent).toContain('Claude Haiku')
    const haiku = [...list.querySelectorAll<HTMLElement>('[data-testid="model-row"]')].find((row) =>
      row.textContent?.includes('Claude Haiku'),
    )!
    await act(async () => haiku.click())
    expect(useRemoteModelPicks.getState().last[MOCK_HOST_ID]).toEqual({
      provider: 'p',
      id: 'haiku',
    })
    expect(document.querySelector('[data-testid="model-list"]')).toBeNull()
    // Recents are the composer's own, so the Host pick joins them too.
    expect(savePicks).toHaveBeenCalled()
    expect(chip!.textContent).toBe('Claude Haiku')
    // A model without reasoning has no thinking half, as in the lane composer.
    expect(el.querySelector('[data-testid="remote-thinking-picker"]')).toBeNull()
  },
)
