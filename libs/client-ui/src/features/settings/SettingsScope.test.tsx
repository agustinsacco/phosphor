// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_DIRECTIVES } from '@shared/models'
import { mockSettingsPatch, mockSettingsRead } from '@/dev/mockMachineSettings'
import { mixedRemoteHosts } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useWorkspacesStore } from '@/stores/workspaces'
import { prepareHostSettings, showHostSettings } from './__fixtures__/hostSettingsSurface'
import { useSettingsUiStore } from './settingsUiStore'

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  })
})
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))

const machine = { id: '11111111-1111-4111-8111-111111111111', label: 'bee1' }
const FOLDER = '0000000000000001'
const invoke = vi.fn()
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  useSessionsStore.setState({ activeSessionId: null, live: {} })
  useSettingsUiStore.setState({ folder: null })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke, platform: 'darwin', onAccountChanged: () => () => {} })
  useRemoteLanesStore.setState({ hosts: mixedRemoteHosts() })
  useWorkspacesStore.setState({
    homePath: '/work/app',
    recents: [
      { path: '/work/app', name: 'app', lastOpenedAt: 1 },
      { path: '/work/site', name: 'site', lastOpenedAt: 2 },
    ],
  })
  prepareHostSettings(machine)
  invoke.mockReset().mockImplementation(async (channel, hostId, section, repositoryId) => {
    if (channel === 'hosts:settingsRead') return mockSettingsRead(hostId, section, repositoryId)
    if (channel === 'hosts:settingsPatch') return mockSettingsPatch(hostId, section)
    if (channel === 'pi:agentSettingsScoped') return { global: {}, project: null }
    if (channel === 'pi:checkAgentSettings')
      return { global: { exists: true, malformed: false }, project: null }
    if (channel === 'app:getPrefs')
      return {
        contextBudget: '200k',
        agentDirectives: DEFAULT_AGENT_DIRECTIVES,
        agentDirectivesByProject: {},
        retiredDirectives: {},
      }
    if (channel === 'packages:list' || channel === 'hosts:models') return []
    return undefined
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const scopeLine = (): HTMLElement =>
  container.querySelector<HTMLElement>('[data-testid="settings-scope-line"]')!
const radio = (name: string): HTMLButtonElement =>
  [...scopeLine().querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
    (r) => r.textContent === name,
  )!
const calls = (channel: string) => invoke.mock.calls.filter(([name]) => name === channel)

it('puts the folder scope and Refresh in the scope line of a scoped Host section', async () => {
  await showHostSettings(root, machine.id, 'agent')
  expect(scopeLine().textContent).toContain('Configuring bee1')
  expect(scopeLine().querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe(
    'Configuration scope',
  )
  expect(radio('Machine').getAttribute('aria-checked')).toBe('true')
  expect(scopeLine().textContent).toContain('Refresh')
  // The section names its machine once, in the scope line.
  expect(container.textContent).not.toContain('machine defaults')
  expect(container.textContent).not.toContain('Machine-wide settings')
  await act(async () => radio('Folder').click())
  expect(useSettingsUiStore.getState().folder).toBe(FOLDER)
  expect(calls('hosts:settingsRead')).toContainEqual([
    'hosts:settingsRead',
    machine.id,
    'agent',
    FOLDER,
  ])
  const folder = scopeLine().querySelector<HTMLSelectElement>(
    'select[aria-label="Configuration folder"]',
  )!
  expect([...folder.options].map((o) => o.textContent)).toEqual(['Phosphor'])
})

it('offers no folder scope on an unscoped Host section, and Refresh reads again', async () => {
  await showHostSettings(root, machine.id, 'accounts')
  expect(scopeLine().querySelector('[role="radiogroup"]')).toBeNull()
  const before = calls('hosts:settingsRead').length
  const refresh = [...scopeLine().querySelectorAll('button')].find(
    (b) => b.textContent === 'Refresh',
  )!
  await act(async () => refresh.click())
  expect(calls('hosts:settingsRead').length).toBe(before + 1)
})

it('lets a new machine start on its machine scope', async () => {
  useSettingsUiStore.setState({ machine: machine.id, folder: FOLDER })
  useSettingsUiStore.getState().setMachine('local')
  expect(useSettingsUiStore.getState().folder).toBeNull()
})

it('scopes This Mac’s Agent from the scope line, with no switch of its own', async () => {
  await showHostSettings(root, 'local', 'agent')
  expect(container.querySelector('[aria-label="Settings scope"]')).toBeNull()
  expect(calls('pi:agentSettingsScoped').at(-1)).toEqual(['pi:agentSettingsScoped', undefined])
  await act(async () => radio('Folder').click())
  expect(useSettingsUiStore.getState().folder).toBe('/work/app')
  expect(calls('pi:agentSettingsScoped').at(-1)).toEqual(['pi:agentSettingsScoped', '/work/app'])
  const folder = scopeLine().querySelector<HTMLSelectElement>(
    'select[aria-label="Configuration folder"]',
  )!
  expect([...folder.options].map((o) => o.textContent)).toEqual(['app', 'site'])
})

it('chooses the active workspace’s folder for Folder on This Mac when it is listed', async () => {
  useWorkspacesStore.setState({ homePath: '/work/site' })
  await showHostSettings(root, 'local', 'agent')
  await act(async () => radio('Folder').click())
  expect(useSettingsUiStore.getState().folder).toBe('/work/site')
  const folder = scopeLine().querySelector<HTMLSelectElement>(
    'select[aria-label="Configuration folder"]',
  )!
  expect([...folder.options].map((o) => o.textContent)).toEqual(['app', 'site'])
})

it('chooses the active lane’s folder for Folder on its Host', async () => {
  const hosts = mixedRemoteHosts()
  const host = hosts[machine.id]!
  const lane = { ...host.lanes[0]!, laneId: 'lane-in-site', repositoryId: '0000000000000002' }
  host.repositories = [
    ...host.repositories,
    { id: '0000000000000002', name: 'Site', path: '/remote/site' },
  ]
  host.lanes = [...host.lanes, lane]
  useRemoteLanesStore.setState({ hosts })
  useSessionsStore.setState({
    activeSessionId: 'remote',
    live: {
      remote: {
        sessionId: 'remote',
        workspacePath: `host:${machine.id}/lane:lane-in-site`,
        target: { kind: 'remote', hostId: machine.id },
        laneId: 'lane-in-site',
      },
    } as never,
  })
  await showHostSettings(root, machine.id, 'agent')
  await act(async () => radio('Folder').click())
  expect(useSettingsUiStore.getState().folder).toBe('0000000000000002')
})

it('lists This Mac’s extension items for the scope line’s folder, as the Extensions page does', async () => {
  useSettingsUiStore.setState({ folder: '/work/site' })
  await showHostSettings(root, 'local', 'extensions')
  expect(calls('packages:list').length).toBeGreaterThan(0)
  expect(calls('packages:list').map(([, workspace]) => workspace)).not.toContain('/work/app')
})
