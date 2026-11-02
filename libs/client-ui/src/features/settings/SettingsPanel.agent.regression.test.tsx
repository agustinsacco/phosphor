// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_DIRECTIVES } from '@shared/models'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { prepareHostSettings, showHostSettings } from './__fixtures__/hostSettingsSurface'
import { useSettingsUiStore } from './settingsUiStore'

/* Agent defects, each pinned through the Settings surface before its fix. */

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
const local = (channel: string): unknown => {
  if (channel === 'pi:agentSettingsScoped')
    return { global: { compaction: { reserveTokens: 50000 } }, project: null }
  if (channel === 'pi:checkAgentSettings')
    return { global: { exists: true, malformed: false }, project: null }
  if (channel === 'app:getPrefs')
    return {
      contextBudget: '',
      agentDirectives: DEFAULT_AGENT_DIRECTIVES,
      agentDirectivesByProject: {},
      retiredDirectives: {},
    }
  return undefined
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke, platform: 'darwin', onAccountChanged: () => () => {} })
  prepareHostSettings({ id: 'unused', label: 'unused' })
  useSettingsUiStore.setState({ folder: null })
  useExtensionUiStore.setState({ toasts: [] })
  invoke.mockReset().mockImplementation(async (channel: string) => local(channel))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

/** The row titled `title`. */
const row = (title: string): Element => {
  const found = [...container.querySelectorAll('[data-setting-row]')].find(
    (r) => r.firstElementChild?.firstElementChild?.textContent === title,
  )
  if (!found) throw new Error(`No row ${title}`)
  return found
}

it('keeps the other compaction values on screen after one is saved (regression A14)', async () => {
  await showHostSettings(root, 'local', 'agent')
  const reserve = () => row('Reserve tokens').querySelector<HTMLInputElement>('input')!.value
  expect(reserve()).toBe('50000')
  await act(async () => row('Auto-compaction').querySelector<HTMLButtonElement>('button')!.click())
  expect(invoke).toHaveBeenCalledWith('pi:patchAgentSettings', 'global', undefined, {
    compaction: { enabled: false },
  })
  expect(reserve()).toBe('50000')
})
