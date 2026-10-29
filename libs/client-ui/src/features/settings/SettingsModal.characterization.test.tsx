// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MachineView } from '@shared/control-api'
import { SettingsModal } from './SettingsModal'
import { useSettingsUiStore } from './settingsUiStore'
import { useLayoutStore } from '@/stores/layout'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useMachinesStore } from '@/stores/machines'
import { useFeedbackStore } from '@/features/feedback/feedbackStore'

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
vi.mock('./tabs/AppearanceTab', () => ({ AppearanceTab: () => <p>Appearance</p> }))
vi.mock('./tabs/AgentTab', () => ({ AgentTab: () => <p>Local agent controls</p> }))
vi.mock('./tabs/AccountsTab', () => ({ AccountsTab: () => <p>Local account controls</p> }))
vi.mock('./tabs/ExtensionsTab', () => ({ ExtensionsTab: () => <p>Local machine controls</p> }))
vi.mock('./tabs/ConnectorsTab', () => ({ ConnectorsTab: () => <p>Local machine controls</p> }))
vi.mock('./tabs/AdvancedTab', () => ({ AdvancedTab: () => <p>Local machine controls</p> }))
vi.mock('./tabs/AboutTab', () => ({ AboutTab: () => null }))

const invoke = vi.fn(async (channel: string): Promise<unknown> =>
  channel === 'packages:list'
    ? []
    : channel === 'feedback:state'
      ? { mode: 'github', repo: 'agustinsacco/Phosphor', nudge: false }
      : undefined,
)
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  invoke.mockClear()
  useRemoteLanesStore.setState({ filter: 'local', hosts: {} })
  useSessionsStore.setState({ activeSessionId: null, live: {} })
  useMachinesStore.setState({ machines: [], view: { kind: 'list' } })
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

const navLabels = (): string[] =>
  [...document.querySelectorAll('nav[aria-label="Settings sections"] button')].map(
    (b) => b.textContent ?? '',
  )

const DEVICE_TABS = ['Appearance', 'Writing', 'Keybindings', 'About']
const THIS_MAC_TABS = [
  'Agent',
  'Accounts',
  'Extensions',
  'MCP Connectors',
  'Workspaces',
  'Optimization',
  'Voice',
  'Advanced',
]

it('lists the device and This Mac sections in the Settings dialog, each in its order', async () => {
  await act(async () => root.render(<SettingsModal />))
  expect(document.querySelector('[role="dialog"][aria-label="Settings"]')).not.toBeNull()
  const labels = navLabels()
  expect(labels.filter((label) => DEVICE_TABS.includes(label))).toEqual(DEVICE_TABS)
  expect(labels.filter((label) => THIS_MAC_TABS.includes(label))).toEqual(THIS_MAC_TABS)
})

it('names the targeted Host and keeps This Mac controls and package discovery off it', async () => {
  useMachinesStore.setState({
    machines: [{ id: 'test-host', label: 'Studio' } as MachineView],
  })
  useRemoteLanesStore.setState({ filter: 'test-host' })
  useSettingsUiStore.setState({ tab: 'agent' })
  await act(async () => root.render(<SettingsModal />))
  const dialog = document.querySelector('[role="dialog"][aria-label="Settings"]')
  expect(dialog?.textContent).toContain('Studio')
  expect(dialog?.textContent).not.toContain('Local agent controls')
  expect(invoke.mock.calls.some(([channel]) => channel === 'packages:list')).toBe(false)
})
