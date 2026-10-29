// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MachineView } from '@shared/control-api'
import { SettingsModal } from './SettingsModal'
import { useSettingsUiStore } from './settingsUiStore'
import { CompactSettings } from '@/shell/compact/CompactSettings'
import { COMPACT_PLATFORM, PlatformProvider } from '@/platform/Platform'
import { NavigationProvider } from '@/navigation/Navigation'
import { useLayoutStore } from '@/stores/layout'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useMachinesStore } from '@/stores/machines'
import { useFeedbackStore } from '@/features/feedback/feedbackStore'
import { MOCK_HOST_ID, mockRemoteHosts, mockRemoteInfo } from '@/dev/mockRemoteLanes'

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  })
})
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('./tabs/AgentTab', () => ({ AgentTab: () => <p>Local agent controls</p> }))
vi.mock('./tabs/AccountsTab', () => ({ AccountsTab: () => <p>Local account controls</p> }))
vi.mock('./tabs/AboutTab', () => ({ AboutTab: () => null }))

const invoke = vi.fn(async (channel: string): Promise<unknown> =>
  channel === 'packages:list'
    ? []
    : channel === 'account:get'
      ? { account: { status: 'signed-in', user: { name: 'Ada', login: 'ada' } } }
      : channel === 'feedback:state'
        ? { mode: 'github', repo: 'agustinsacco/Phosphor', nudge: false }
        : undefined,
)
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  invoke.mockClear()
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  host.configurationSupported = true
  useRemoteLanesStore.setState({ filter: 'local', hosts: { [MOCK_HOST_ID]: host } })
  useSessionsStore.setState({ activeSessionId: null, live: {} })
  useMachinesStore.setState({
    machines: [{ id: MOCK_HOST_ID, label: 'Studio' } as MachineView],
    view: { kind: 'list' },
  })
  useLayoutStore.setState({ page: null })
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: () => undefined,
  })
  vi.stubGlobal('phosphor', { invoke, platform: 'darwin', onAccountChanged: () => () => {} })
  useSettingsUiStore.setState({ open: true, tab: 'appearance', reveal: null })
  useFeedbackStore.setState({ open: false, state: null })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function activateRemoteLane(): void {
  const { sessionId, workspacePath, target, laneId } = mockRemoteInfo
  useSessionsStore.setState({
    activeSessionId: sessionId,
    live: { [sessionId]: { phosphorId: sessionId, workspacePath, target, laneId } },
  })
  useRemoteLanesStore.setState({ filter: 'all' })
}
const navLabels = (): string[] =>
  [...document.querySelectorAll('nav[aria-label="Settings sections"] button')].map(
    (b) => b.textContent?.trim() ?? '',
  )
const machineSelect = (): HTMLSelectElement | null =>
  document.querySelector<HTMLSelectElement>('select[aria-label="Configure"]')
async function choose(select: HTMLSelectElement | null, value: string): Promise<void> {
  expect(select).not.toBeNull()
  await act(async () => {
    select!.value = value
    select!.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
async function openSection(label: string): Promise<void> {
  const entry = [...document.querySelectorAll('nav[aria-label="Settings sections"] button')].find(
    (b) => b.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined
  expect(entry, label).toBeDefined()
  await act(async () => entry?.click())
}
async function search(query: string): Promise<string> {
  const field = document.querySelector<HTMLInputElement>('input[aria-label="Search settings"]')
  expect(field).not.toBeNull()
  await act(async () => useSettingsUiStore.getState().setQuery(query))
  return document.querySelector('[role="status"]')?.textContent ?? ''
}
async function renderBrowserPage(): Promise<void> {
  await act(async () =>
    root.render(
      <PlatformProvider value={COMPACT_PLATFORM}>
        <NavigationProvider
          value={{
            location: { to: 'page', page: 'settings', machine: MOCK_HOST_ID },
            navigate: () => undefined,
          }}
        >
          <CompactSettings machine={MOCK_HOST_ID} />
        </NavigationProvider>
      </PlatformProvider>,
    ),
  )
}

it('selects This Mac and renders its Agent tab while a Host lane is active', async () => {
  activateRemoteLane()
  useSettingsUiStore.setState({ tab: 'agent' })
  await act(async () => root.render(<SettingsModal />))
  expect(machineSelect()?.value).toBe(MOCK_HOST_ID)
  await choose(machineSelect(), 'local')
  await openSection('Agent')
  expect(document.body.textContent).toContain('Configuring This Mac')
  expect(document.body.textContent).toContain('Local agent controls')
  expect(document.body.textContent).not.toContain('Remote settings are not available here.')
})

it('selects a Host and renders its Providers section behind the configuration gate', async () => {
  await act(async () => root.render(<SettingsModal />))
  await choose(machineSelect(), MOCK_HOST_ID)
  expect(navLabels()).toEqual(
    expect.arrayContaining(['Providers', 'Agent defaults', 'Skills & extensions']),
  )
  expect(navLabels()).not.toContain('Accounts')
  await openSection('Providers')
  expect(document.body.textContent).toContain('Configuring Studio')
  expect(document.body.textContent).toContain('Configuration access is not enabled')
  expect(document.body.textContent).not.toContain('Local account controls')
})

it('renders the shared surface on the browser settings page with device and Host sections', async () => {
  await renderBrowserPage()
  expect(document.querySelector('input[aria-label="Search settings"]')).not.toBeNull()
  const labels = navLabels()
  expect(labels).toEqual(
    expect.arrayContaining([
      'Appearance',
      'Phosphor account',
      'App installation',
      'About',
      'Providers',
      'Agent defaults',
    ]),
  )
  for (const hidden of ['Writing', 'Keybindings', 'Agent', 'Accounts', 'MCP Connectors'])
    expect(labels).not.toContain(hidden)
  expect([...(machineSelect()?.options ?? [])].map((o) => o.value)).not.toContain('local')
  expect(document.body.textContent).not.toContain('available in Desktop')
  await openSection('Phosphor account')
  expect(document.body.textContent).not.toContain('available in Desktop')
})

it('never lists hidden sections in search results', async () => {
  await renderBrowserPage()
  expect(await search('spelling')).toContain('No settings match')
  expect(await search('UI scale')).toContain('No settings match')
  expect(await search('command palette')).toContain('No settings match')
  expect(await search('theme')).toMatch(/result/)
  act(() => root.unmount())
  root = createRoot(container)
  useSettingsUiStore.setState({ query: '', listing: false })
  await act(async () => root.render(<SettingsModal />))
  await choose(machineSelect(), MOCK_HOST_ID)
  expect(await search('auto-compaction')).toContain('No settings match')
  expect(await search('providers')).toMatch(/result/)
})
