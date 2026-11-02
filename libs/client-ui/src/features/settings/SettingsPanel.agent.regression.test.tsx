// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_DIRECTIVES } from '@shared/models'
import { mockSettingsPatch, mockSettingsRead } from '@/dev/mockMachineSettings'
import { mixedRemoteHosts } from '@/dev/mockRemoteLanes'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
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

const HOST = { id: '11111111-1111-4111-8111-111111111111', label: 'bee1' }
const FOLDER = '0000000000000001'
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
  useRemoteLanesStore.setState({ hosts: mixedRemoteHosts() })
  prepareHostSettings(HOST)
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

it('shows a Host folder inheriting its machine thinking level, and lets it pin medium over that (regression A15)', async () => {
  invoke.mockImplementation(async (channel: string, hostId, section, repositoryId) => {
    if (channel === 'hosts:models') return []
    if (channel === 'hosts:settingsPatch') return mockSettingsPatch(hostId, section)
    if (channel !== 'hosts:settingsRead') return local(channel)
    const read = mockSettingsRead(hostId, section, repositoryId)
    // The machine thinks hard; the folder sets nothing of its own.
    if (read.agent && repositoryId) delete read.agent.defaultThinkingLevel
    else if (read.agent) read.agent.defaultThinkingLevel = 'high'
    return read
  })
  useSettingsUiStore.setState({ folder: FOLDER })
  await showHostSettings(root, HOST.id, 'agent')
  const thinking = [...container.querySelectorAll('select')].find((s) =>
    [...s.options].some((o) => o.value === 'xhigh'),
  )!
  expect(thinking.value).toBe('high')
  await act(async () => {
    thinking.value = 'medium'
    thinking.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  expect(invoke).toHaveBeenCalledWith(
    'hosts:settingsPatch',
    HOST.id,
    expect.objectContaining({
      repositoryId: FOLDER,
      change: { type: 'agent.patch', patch: { defaultThinkingLevel: 'medium' } },
    }),
  )
})

it('recovers a failed context budget read and rolls back a failed save (regression D2b)', async () => {
  let failRead = true
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'app:getPrefs' && failRead) throw new Error('prefs unavailable')
    if (channel === 'app:setContextBudget') throw new Error('disk full')
    return local(channel)
  })
  await showHostSettings(root, 'local', 'agent')
  const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Try again')
  expect(retry).toBeTruthy()
  failRead = false
  await act(async () => retry!.click())
  const radio = (title: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((r) =>
      r.textContent?.startsWith(title),
    )!
  expect(radio('Default: 200k tokens').getAttribute('aria-checked')).toBe('true')
  await act(async () => radio('400k tokens').click())
  expect(radio('400k tokens').getAttribute('aria-checked')).toBe('false')
  expect(radio('Default: 200k tokens').getAttribute('aria-checked')).toBe('true')
  expect(useExtensionUiStore.getState().toasts.map((t) => [t.kind, t.message])).toContainEqual([
    'error',
    'disk full',
  ])
})
