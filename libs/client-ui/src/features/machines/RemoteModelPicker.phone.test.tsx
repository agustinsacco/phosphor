// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { DEFAULT_APP_PREFS } from '@shared/models/prefs'
import { COMPACT_PLATFORM, PlatformProvider } from '@/platform/Platform'
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
function Picker(): React.JSX.Element {
  const selection = useRemoteModel(MOCK_HOST_ID)
  return <RemoteModelPicker selection={selection} />
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  useModelPicksStore.setState({ starred: [], recent: [], groupMode: 'family', hydrated: false })
  fake = createFakePhosphor({
    'hosts:skills': () => ({ skills: [], probe: 'rpc', userRoot: 'opaque' }),
    'hosts:models': () => [
      { id: 'opus', name: 'Claude Opus 5.5', provider: 'p', reasoning: true },
      { id: 'haiku', name: 'Claude Haiku', provider: 'p', reasoning: false },
    ],
    'hosts:providers': () => [{ id: 'p', name: 'Provider', status: 'ready' }],
    'app:getPrefs': () => DEFAULT_APP_PREFS,
    'app:setModelPicks': () => undefined,
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

it('gives a phone the shared model chip and menu sheet, not a dialog', async () => {
  await act(async () =>
    root.render(
      <PlatformProvider value={COMPACT_PLATFORM}>
        <Picker />
      </PlatformProvider>,
    ),
  )
  const chip = el.querySelector<HTMLButtonElement>('[data-testid="remote-model-picker"]')!
  expect(chip.textContent).toBe('Claude Opus 5.5')
  expect(el.querySelector('[data-testid="remote-thinking-picker"]')?.textContent).toBe('High')
  await act(async () => chip.click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  const list = document.querySelector<HTMLElement>('[data-testid="model-list"]')!
  expect(list.closest('[data-compact-menu]')).not.toBeNull()
  const haiku = [...list.querySelectorAll<HTMLElement>('[data-testid="model-row"]')].find((row) =>
    row.textContent?.includes('Claude Haiku'),
  )!
  await act(async () => haiku.click())
  expect(useRemoteModelPicks.getState().last[MOCK_HOST_ID]).toEqual({ provider: 'p', id: 'haiku' })
  expect(chip.textContent).toBe('Claude Haiku')
})
