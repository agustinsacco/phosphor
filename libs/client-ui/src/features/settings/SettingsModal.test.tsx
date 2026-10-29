// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SettingsModal } from './SettingsModal'
import { useSettingsUiStore } from './settingsUiStore'
import { useLayoutStore } from '@/stores/layout'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useMachinesStore } from '@/stores/machines'
import { useWorkspacesStore } from '@/stores/workspaces'
import { MOCK_HOST_ID, mockRemoteInfo } from '@/dev/mockRemoteLanes'
import { isThisMacTab } from './settingsIndex'
import type { MachineView } from '@shared/control-api'
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
vi.mock('./tabs/ClaudeProviderTab', () => ({
  ClaudeProviderTab: () => <p>Local machine controls</p>,
}))
vi.mock('./tabs/WebAccessTab', () => ({ WebAccessTab: () => <p>Local machine controls</p> }))
vi.mock('./tabs/WorkspacesTab', () => ({ WorkspacesTab: () => <p>Local machine controls</p> }))
vi.mock('./tabs/OptimizationTab', () => ({ OptimizationTab: () => <p>Local machine controls</p> }))
vi.mock('./tabs/AdvancedTab', () => ({ AdvancedTab: () => <p>Local machine controls</p> }))
vi.mock('./tabs/ConnectorsTab', () => ({ ConnectorsTab: () => <p>Local machine controls</p> }))
vi.mock('./tabs/ComputerUseTab', () => ({ ComputerUseTab: () => <p>Local machine controls</p> }))
vi.mock('./tabs/SubagentsTab', () => ({ SubagentsTab: () => <p>Local machine controls</p> }))
vi.mock('./tabs/AboutTab', () => ({ AboutTab: () => null }))
let root: Root
let container: HTMLDivElement
const defaultInvoke = async (channel: string): Promise<unknown> =>
  channel === 'packages:list'
    ? []
    : channel === 'feedback:state'
      ? { mode: 'github', repo: 'agustinsacco/Phosphor', nudge: false }
      : undefined
const invoke = vi.fn(defaultInvoke)
beforeEach(() => {
  invoke.mockClear()
  invoke.mockImplementation(defaultInvoke)
  useRemoteLanesStore.setState({ filter: 'local', hosts: {} })
  useSessionsStore.setState({ activeSessionId: null, live: {} })
  useMachinesStore.setState({
    machines: [
      { id: 'test-host', label: 'Test Host' },
      { id: 'selected-host', label: 'Selected Host' },
      { id: MOCK_HOST_ID, label: 'Lane Host' },
    ] as MachineView[],
    view: { kind: 'list' },
  })
  useLayoutStore.setState({ page: null })
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: () => undefined,
  })
  vi.stubGlobal('phosphor', { invoke, platform: 'darwin' })
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
it('lists MCP Connectors as its own section, after the packages nested under Extensions', async () => {
  invoke.mockImplementation(async (channel: string) =>
    channel === 'packages:list'
      ? [{ spec: 'npm:pi-web-access', name: 'pi-web-access', scope: 'global', installed: true }]
      : undefined,
  )
  await act(async () => root.render(<SettingsModal />))
  const nav = [...document.querySelectorAll('nav[aria-label="Settings sections"] button')]
  const rows = nav.map((b) => `${b.hasAttribute('data-nested') ? '↳ ' : ''}${b.textContent}`)
  const at = rows.indexOf('Extensions')
  expect(rows.slice(at, at + 4)).toEqual([
    'Extensions',
    '↳ Web access',
    'MCP Connectors',
    'Workspaces',
  ])
})

it('keeps Send feedback in the Settings footer and opens the same form', async () => {
  await act(async () => root.render(<SettingsModal />))
  const footer = document.querySelector('[data-testid=settings-footer]')
  expect(footer?.textContent).toContain('Send feedback')
  const button = footer?.querySelector<HTMLButtonElement>('[data-testid=feedback-button]')
  expect(button?.dataset.nudge).toBe('false')
  act(() => button?.click())
  expect(useFeedbackStore.getState().open).toBe(true)
})
it('preserves the one-time nudge and dismisses it without opening feedback', async () => {
  await act(async () => root.render(<SettingsModal />))
  act(() =>
    useFeedbackStore.setState({
      state: { mode: 'github', repo: 'agustinsacco/Phosphor', nudge: true },
    }),
  )
  const footer = document.querySelector('[data-testid=settings-footer]')
  expect(footer?.querySelector<HTMLElement>('[data-testid=feedback-button]')?.dataset.nudge).toBe(
    'true',
  )
  expect(footer?.textContent).toContain('How is Phosphor going?')
  await act(async () => footer?.querySelector<HTMLButtonElement>('[aria-label=Dismiss]')?.click())
  expect(invoke).toHaveBeenCalledWith('feedback:dismiss')
  expect(footer?.textContent).toContain('Send feedback')
  expect(useFeedbackStore.getState().open).toBe(false)
})

it('labels local machine settings without labelling appearance as machine policy', async () => {
  await act(async () => root.render(<SettingsModal />))
  expect(document.body.textContent).not.toContain('These settings configure This Mac')
  await act(async () => useSettingsUiStore.getState().setTab('accounts'))
  expect(document.body.textContent).toContain('This Mac')
  expect(document.body.textContent).toContain('Local account controls')
})

it.each([
  'accounts',
  'agent',
  'extensions',
  'connectors',
  'optimization',
  'advanced',
  'voice',
  'workspaces',
  'claude-provider',
  'web-access',
  'computer-use',
  'subagents',
] as const)(
  'does not mount local %s controls or discover packages for a selected Host',
  async (tab) => {
    useRemoteLanesStore.setState({ filter: 'test-host' })
    useSettingsUiStore.setState({ tab })
    await act(async () => root.render(<SettingsModal />))
    expect(document.body.textContent).toContain('Configuring Test Host')
    expect(document.body.textContent).not.toContain('Local account controls')
    expect(document.body.textContent).not.toContain('Local agent controls')
    expect(document.body.textContent).not.toContain('Local machine controls')
    expect(invoke.mock.calls.some(([channel]) => channel === 'packages:list')).toBe(false)
  },
)

function activateRemoteLane(): string {
  const { sessionId, workspacePath, target, laneId } = mockRemoteInfo
  useSessionsStore.setState({
    activeSessionId: sessionId,
    live: { [sessionId]: { phosphorId: sessionId, workspacePath, target, laneId } },
  })
  return workspacePath
}

it('follows This Mac in the switcher while a Host lane is still active', async () => {
  const remotePath = activateRemoteLane()
  useWorkspacesStore.setState({ homePath: '/Users/me/phosphor-home' })
  useSettingsUiStore.setState({ tab: 'accounts' })
  await act(async () => root.render(<SettingsModal />))
  expect(document.body.textContent).toContain('Local account controls')
  expect(document.body.textContent).not.toContain('Remote settings are not available here.')
  expect(invoke).toHaveBeenCalledWith('packages:list', '/Users/me/phosphor-home')
  expect(invoke).not.toHaveBeenCalledWith('packages:list', remotePath)
})

it('opens on the Host of an active Host lane under All machines', async () => {
  const remotePath = activateRemoteLane()
  useRemoteLanesStore.setState({ filter: 'all' })
  useSettingsUiStore.setState({ tab: 'accounts' })
  await act(async () => root.render(<SettingsModal />))
  expect(document.body.textContent).toContain('Configuring Lane Host')
  expect(document.body.textContent).not.toContain('Local account controls')
  expect(invoke).not.toHaveBeenCalledWith('packages:list', remotePath)
})

it.each([
  'accounts',
  'claude-provider',
  'agent',
  'connectors',
  'extensions',
  'optimization',
  'advanced',
  'web-access',
  'subagents',
  'computer-use',
] as const)('marks %s as This Mac policy', (tab) => expect(isThisMacTab(tab)).toBe(true))

it('opens on a selected Machines detail without an active remote lane', async () => {
  useLayoutStore.setState({ page: 'machines' })
  useMachinesStore.setState({ view: { kind: 'machine', id: 'selected-host' } })
  useSettingsUiStore.setState({ tab: 'agent' })
  await act(async () => root.render(<SettingsModal />))
  expect(document.body.textContent).toContain('Configuring Selected Host')
  expect(document.body.textContent).not.toContain('Local agent controls')
  expect(invoke.mock.calls.some(([channel]) => channel === 'packages:list')).toBe(false)
})

it('refreshes scope from This Mac to a Host and back while Settings is open', async () => {
  useSettingsUiStore.setState({ tab: 'accounts' })
  await act(async () => root.render(<SettingsModal />))
  expect(document.body.textContent).toContain('Local account controls')
  invoke.mockClear()
  await act(async () => useRemoteLanesStore.setState({ filter: 'test-host' }))
  expect(document.body.textContent).not.toContain('Local account controls')
  expect(document.body.textContent).toContain('Configuring Test Host')
  expect(invoke.mock.calls.some(([channel]) => channel === 'packages:list')).toBe(false)
  await act(async () => useRemoteLanesStore.setState({ filter: 'local' }))
  expect(document.body.textContent).toContain('Local account controls')
  expect(document.body.textContent).toContain('Configuring This Mac')
})

it('refreshes scope on a Mac lane to Host lane to Mac lane switch', async () => {
  const { sessionId, workspacePath, target, laneId } = mockRemoteInfo
  useRemoteLanesStore.setState({ filter: 'all' })
  useSessionsStore.setState({
    activeSessionId: 'mac-lane',
    live: { [sessionId]: { phosphorId: sessionId, workspacePath, target, laneId } },
  })
  useSettingsUiStore.setState({ tab: 'accounts' })
  await act(async () => root.render(<SettingsModal />))
  expect(document.body.textContent).toContain('Local account controls')
  await act(async () => useSessionsStore.setState({ activeSessionId: sessionId }))
  expect(document.body.textContent).toContain('Configuring Lane Host')
  expect(document.body.textContent).not.toContain('Local account controls')
  await act(async () => useSessionsStore.setState({ activeSessionId: 'mac-lane' }))
  expect(document.body.textContent).toContain('Local account controls')
  expect(document.body.textContent).not.toContain('Configuring Lane Host')
})

it('keeps the chosen machine until Settings closes, then follows the default again', async () => {
  useRemoteLanesStore.setState({ filter: 'test-host' })
  useSettingsUiStore.setState({ tab: 'accounts' })
  await act(async () => root.render(<SettingsModal />))
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="Configure"]')!
  await act(async () => {
    select.value = 'local'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(document.body.textContent).toContain('Local account controls')
  await act(async () => useSettingsUiStore.getState().setOpen(false))
  await act(async () => useSettingsUiStore.getState().setOpen(true))
  expect(document.body.textContent).toContain('Configuring Test Host')
})
