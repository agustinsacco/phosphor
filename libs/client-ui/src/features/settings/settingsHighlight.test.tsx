// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_DIRECTIVES } from '@shared/models'
import { prepareHostSettings, showHostSettings } from './__fixtures__/hostSettingsSurface'
import { useSettingsUiStore } from './settingsUiStore'

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  })
})
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))

const invoke = vi.fn()
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke, platform: 'darwin', onAccountChanged: () => () => {} })
  prepareHostSettings({ id: '11111111-1111-4111-8111-111111111111', label: 'bee1' })
  useSettingsUiStore.setState({ folder: null })
  invoke.mockReset().mockImplementation(async (channel: string) => {
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
