// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mockSettingsRead } from '@/dev/mockMachineSettings'
import { mixedRemoteHosts } from '@/dev/mockRemoteLanes'
import { NavigationProvider } from '@/navigation/Navigation'
import { COMPACT_PLATFORM, PlatformProvider } from '@/platform/Platform'
import { useBrowserNavigation } from '@/shell/compact/useBrowserNavigation'
import { CompactSettings } from '@/shell/compact/CompactSettings'
import { promptChoice } from '@/stores/prompt'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { prepareHostSettings } from './__fixtures__/hostSettingsSurface'
import { SettingsModal } from './SettingsModal'
import { useSettingsUiStore } from './settingsUiStore'

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  })
})
vi.mock('@/stores/prompt', () => ({
  promptChoice: vi.fn(async () => undefined),
  promptText: vi.fn(),
}))
vi.mock('@/lib/monaco', () => ({}))

const machine = { id: '11111111-1111-4111-8111-111111111111', label: 'bee1' }
const invoke = vi.fn()
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke, platform: 'darwin', onAccountChanged: () => () => {} })
  useRemoteLanesStore.setState({ hosts: mixedRemoteHosts() })
  prepareHostSettings(machine)
  // Every save is refused, so the edit stays an unsaved draft.
  invoke.mockReset().mockImplementation(async (channel, hostId, section, repositoryId) => {
    if (channel === 'hosts:settingsRead') return mockSettingsRead(hostId, section, repositoryId)
    if (channel === 'hosts:settingsPatch') throw new Error('Host is busy')
    if (channel === 'hosts:models') return []
    return undefined
  })
  vi.mocked(promptChoice).mockReset().mockResolvedValue(undefined)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function leaveAnUnsavedDraft(): Promise<void> {
  const thinking = document.querySelector<HTMLSelectElement>(
    '[aria-label="Default thinking level"]',
  )!
  await act(async () => {
    thinking.value = thinking.value === 'high' ? 'low' : 'high'
    thinking.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(document.body.textContent).toContain('Some changes are not saved on bee1')
}

it('asks before closing the Settings dialog over an unsaved Host draft', async () => {
  useSettingsUiStore.setState({ open: true, tab: 'agent', machine: machine.id, folder: null })
  await act(async () => root.render(<SettingsModal />))
  await leaveAnUnsavedDraft()
  const close = document.querySelector<HTMLButtonElement>('[aria-label="Close settings"]')!
  await act(async () => close.click())
  expect(promptChoice).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'Discard unsaved Host settings?' }),
  )
  expect(useSettingsUiStore.getState().open).toBe(true)
})

function BrowserSettings(): React.JSX.Element {
  const navigation = useBrowserNavigation()
  return (
    <NavigationProvider value={navigation}>
      <CompactSettings machine={machine.id} />
    </NavigationProvider>
  )
}

it('asks before the browser leaves the Settings page over an unsaved Host draft', async () => {
  window.history.replaceState(null, '', `/pages/settings/${machine.id}`)
  useSettingsUiStore.setState({ tab: 'agent', machine: null, folder: null })
  let navigate: ((next: { to: 'lanes' }) => void) | undefined
  function Capture(): null {
    navigate = useBrowserNavigation().navigate
    return null
  }
  await act(async () =>
    root.render(
      <PlatformProvider value={COMPACT_PLATFORM}>
        <BrowserSettings />
        <Capture />
      </PlatformProvider>,
    ),
  )
  await leaveAnUnsavedDraft()
  await act(async () => navigate!({ to: 'lanes' }))
  expect(promptChoice).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'Discard unsaved Host settings?' }),
  )
  expect(window.location.pathname).toBe(`/pages/settings/${machine.id}`)
})

it('asks before browser Back leaves the Settings page over an unsaved Host draft', async () => {
  window.history.replaceState(null, '', `/pages/settings/${machine.id}`)
  useSettingsUiStore.setState({ tab: 'agent', machine: null, folder: null })
  await act(async () =>
    root.render(
      <PlatformProvider value={COMPACT_PLATFORM}>
        <BrowserSettings />
      </PlatformProvider>,
    ),
  )
  await leaveAnUnsavedDraft()
  // Back has already moved the address when popstate arrives.
  await act(async () => {
    window.history.replaceState(null, '', '/lanes')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  expect(promptChoice).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'Discard unsaved Host settings?' }),
  )
  expect(window.location.pathname).toBe(`/pages/settings/${machine.id}`)
  expect(document.body.textContent).toContain('Some changes are not saved on bee1')
})
