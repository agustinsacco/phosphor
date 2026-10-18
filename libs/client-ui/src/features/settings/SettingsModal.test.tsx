// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SettingsModal } from './SettingsModal'
import type { HostConnectionView } from '@shared/ipc'
import { useSettingsUiStore } from './settingsUiStore'
import { useLayoutStore } from '@/stores/layout'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useMachinesStore } from '@/stores/machines'
import { mockRemoteInfo } from '@/dev/mockRemoteLanes'
import { isMachineSettingsTab } from './SettingsMachineScope'
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
  useMachinesStore.setState({ machines: [], view: { kind: 'list' } })
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
    expect(document.body.textContent).toContain('Remote settings are not available here.')
    expect(document.body.textContent).not.toContain('Local account controls')
    expect(document.body.textContent).not.toContain('Local agent controls')
    expect(document.body.textContent).not.toContain('Local machine controls')
    expect(invoke.mock.calls.filter(([channel]) => channel !== 'feedback:state')).toEqual([])
    const button = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('readiness'),
    )
    act(() => button?.click())
    expect(useSettingsUiStore.getState().open).toBe(false)
    expect(useMachinesStore.getState().view).toEqual({ kind: 'machine', id: 'test-host' })
  },
)

it('links supporting Hosts directly to their settings without mounting local controls', async () => {
  useRemoteLanesStore.setState({
    filter: 'test-host',
    hosts: {
      'test-host': {
        state: 'ready',
        capabilities: [],
        configurationSupported: true,
      } as unknown as HostConnectionView,
    },
  })
  useSettingsUiStore.setState({ tab: 'accounts' })
  await act(async () => root.render(<SettingsModal />))
  const button = [...document.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Open this machine settings'),
  )
  expect(button).toBeTruthy()
  await act(async () => button?.click())
  expect(useMachinesStore.getState().view).toEqual({
    kind: 'machine',
    id: 'test-host',
    settings: 'providers',
  })
  expect(invoke.mock.calls.filter(([channel]) => channel !== 'feedback:state')).toEqual([])
})

it('blocks machine settings for an active remote lane even with This Mac selected', async () => {
  const { sessionId, workspacePath, target, laneId } = mockRemoteInfo
  useSessionsStore.setState({
    activeSessionId: sessionId,
    live: { [sessionId]: { phosphorId: sessionId, workspacePath, target, laneId } },
  })
  useSettingsUiStore.setState({ tab: 'accounts' })
  await act(async () => root.render(<SettingsModal />))
  expect(document.body.textContent).toContain('To sign in on')
  expect(document.body.textContent).not.toContain('Local account controls')
  expect(invoke).not.toHaveBeenCalledWith('packages:list', workspacePath)
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
] as const)('marks %s as This Mac policy', (tab) => expect(isMachineSettingsTab(tab)).toBe(true))

it('blocks machine effects for a selected Machines detail without an active remote lane', async () => {
  useLayoutStore.setState({ page: 'machines' })
  useMachinesStore.setState({ view: { kind: 'machine', id: 'selected-host' } })
  useSettingsUiStore.setState({ tab: 'agent' })
  await act(async () => root.render(<SettingsModal />))
  expect(document.body.textContent).toContain('Remote settings are not available here.')
  expect(document.body.textContent).not.toContain('Local agent controls')
  expect(invoke.mock.calls.filter(([channel]) => channel !== 'feedback:state')).toEqual([])
})

it('refreshes scope from This Mac to a Host and back while Settings is open', async () => {
  useSettingsUiStore.setState({ tab: 'accounts' })
  await act(async () => root.render(<SettingsModal />))
  expect(document.body.textContent).toContain('Local account controls')
  invoke.mockClear()
  await act(async () => useRemoteLanesStore.setState({ filter: 'test-host' }))
  expect(document.body.textContent).not.toContain('Local account controls')
  expect(document.body.textContent).toContain('Remote settings are not available here.')
  expect(invoke).not.toHaveBeenCalled()
  await act(async () => useRemoteLanesStore.setState({ filter: 'local' }))
  expect(document.body.textContent).toContain('Local account controls')
  expect(document.body.textContent).not.toContain('Remote settings are not available here.')
})

it('refreshes scope on a Mac lane to Host lane to Mac lane switch', async () => {
  const { sessionId, workspacePath, target, laneId } = mockRemoteInfo
  useSessionsStore.setState({
    activeSessionId: 'mac-lane',
    live: { [sessionId]: { phosphorId: sessionId, workspacePath, target, laneId } },
  })
  useSettingsUiStore.setState({ tab: 'accounts' })
  await act(async () => root.render(<SettingsModal />))
  expect(document.body.textContent).toContain('Local account controls')
  await act(async () => useSessionsStore.setState({ activeSessionId: sessionId }))
  expect(document.body.textContent).toContain('To sign in on')
  expect(document.body.textContent).not.toContain('Local account controls')
  await act(async () => useSessionsStore.setState({ activeSessionId: 'mac-lane' }))
  expect(document.body.textContent).toContain('Local account controls')
  expect(document.body.textContent).not.toContain('To sign in on')
})
