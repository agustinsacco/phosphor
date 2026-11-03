// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_DIRECTIVES } from '@shared/models'
import { mockSettingsPatch, mockSettingsRead } from '@/dev/mockMachineSettings'
import { mixedRemoteHosts } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { prepareHostSettings, showHostSettings } from './__fixtures__/hostSettingsSurface'
import { useSettingsUiStore } from './settingsUiStore'

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  })
})
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))

const HOST = { id: '11111111-1111-4111-8111-111111111111', label: 'bee1' }
const invoke = vi.fn()
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke, platform: 'darwin', onAccountChanged: () => () => {} })
  useRemoteLanesStore.setState({ hosts: mixedRemoteHosts() })
  prepareHostSettings(HOST)
  // jsdom has no scrolling; the results list keeps its active option in view.
  Element.prototype.scrollIntoView ??= () => undefined
  useSettingsUiStore.setState({ folder: null })
  invoke.mockReset().mockImplementation(async (channel: string, hostId, section, repositoryId) => {
    if (channel === 'hosts:settingsRead') return mockSettingsRead(hostId, section, repositoryId)
    if (channel === 'hosts:settingsPatch') return mockSettingsPatch(hostId, section)
    if (channel === 'hosts:models') return []
    if (channel === 'pi:agentSettingsScoped') return { global: {}, project: {} }
    if (channel === 'pi:checkAgentSettings')
      return { global: { exists: true, malformed: false }, project: null }
    if (channel === 'mcp:readConfigs') return { projectTrust: null }
    if (channel === 'app:getPrefs')
      return {
        contextBudget: '',
        agentDirectives: DEFAULT_AGENT_DIRECTIVES,
        agentDirectivesByProject: {},
        retiredDirectives: {},
      }
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

it('opens the Custom model disclosure to reveal a row inside it (R-U10)', async () => {
  await showHostSettings(root, 'local', 'agent')
  expect(container.querySelector('details')?.open).toBe(false)
  await act(async () => useSettingsUiStore.getState().openResult('agent', 'Provider id'))
  expect(container.querySelector('details')?.open).toBe(true)
})

/** Searches for `title` and opens its result, as a reader does. */
async function openResult(title: string): Promise<void> {
  await act(async () => useSettingsUiStore.getState().setQuery(title))
  const result = container.querySelector<HTMLElement>(`[role="option"][data-tooltip="${title}"]`)
  await act(async () => result!.click())
}
const rowTitles = () =>
  [...container.querySelectorAll('[data-setting-row]')].map(
    (row) => row.firstElementChild?.firstElementChild?.textContent,
  )

it.each(['Global instructions', 'Lane charter', 'Context budget'])(
  'switches a Host folder to Machine scope to reveal %s, which only the machine has (regression R-U10)',
  async (title) => {
    useSettingsUiStore.setState({ folder: '0000000000000001' })
    await showHostSettings(root, HOST.id, 'agent')
    await openResult(title)
    expect(useSettingsUiStore.getState().folder).toBeNull()
    expect(rowTitles()).toContain(title)
  },
)
