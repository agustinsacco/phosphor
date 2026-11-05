// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_DIRECTIVES } from '@shared/models'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useWorkspacesStore } from '@/stores/workspaces'
import { prepareHostSettings, showHostSettings } from './__fixtures__/hostSettingsSurface'
import { useSettingsUiStore } from './settingsUiStore'

/*
 * This Mac's Agent section through the shared Settings surface: what it reads,
 * what each control writes, and how a broken settings.json blocks it. Only
 * behaviour the shared Agent view keeps is pinned here.
 */

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
let globalFile: Record<string, unknown>
let malformed: boolean
beforeEach(() => {
  globalFile = { compaction: { reserveTokens: 50000 } }
  malformed = false
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke, platform: 'darwin', onAccountChanged: () => () => {} })
  useWorkspacesStore.setState({
    homePath: '/work/app',
    recents: [{ path: '/work/app', name: 'app', lastOpenedAt: 1 }],
  })
  prepareHostSettings({ id: 'unused', label: 'unused' })
  useSettingsUiStore.setState({ folder: null })
  useExtensionUiStore.setState({ toasts: [] })
  invoke.mockReset().mockImplementation(async (channel: string) => {
    if (channel === 'pi:agentSettingsScoped') return { global: globalFile, project: null }
    if (channel === 'pi:checkAgentSettings')
      return {
        global: malformed
          ? { exists: true, malformed: true, error: 'Unexpected token' }
          : { exists: true, malformed: false },
        project: null,
      }
    if (channel === 'app:getPrefs')
      return {
        contextBudget: '',
        agentDirectives: DEFAULT_AGENT_DIRECTIVES,
        agentDirectivesByProject: {},
        retiredDirectives: {},
      }
    if (channel === 'packages:list') return []
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

const show = () => showHostSettings(root, 'local', 'agent')
const calls = (channel: string) => invoke.mock.calls.filter(([name]) => name === channel)
/** The one control in the row titled `title`. */
const control = <T extends Element>(title: string, selector: string): T => {
  const row = [...container.querySelectorAll('[data-setting-row]')].find(
    (r) => r.firstElementChild?.firstElementChild?.textContent === title,
  )
  if (!row) throw new Error(`No row ${title}`)
  return row.querySelector<T>(selector)!
}
const choose = async (title: string, value: string) => {
  const select = control<HTMLSelectElement>(title, 'select')
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
const typeNumber = async (title: string, value: string) => {
  const input = control<HTMLInputElement>(title, 'input[type="number"]')
  await act(async () => {
    input.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => input.blur())
}

it('reads each scope unmerged and writes the machine file from every kind of control', async () => {
  await show()
  expect(container.querySelector('h2')?.textContent).toBe('Agent defaults')
  expect(calls('pi:agentSettingsScoped').at(-1)).toEqual(['pi:agentSettingsScoped', undefined])
  await act(async () => control<HTMLButtonElement>('Hide thinking blocks', 'button').click())
  await choose('Steering delivery', 'all')
  await typeNumber('Reserve tokens', '32768')
  expect(calls('pi:patchAgentSettings')).toEqual([
    ['pi:patchAgentSettings', 'global', undefined, { hideThinkingBlock: true }],
    ['pi:patchAgentSettings', 'global', undefined, { steeringMode: 'all' }],
    ['pi:patchAgentSettings', 'global', undefined, { compaction: { reserveTokens: 32768 } }],
  ])
  expect(useExtensionUiStore.getState().toasts.map((t) => t.message)).toContain(
    'Saved — applies to newly started sessions',
  )
})

it('writes the folder override in folder scope', async () => {
  useSettingsUiStore.setState({ folder: '/work/app' })
  await show()
  expect(calls('pi:agentSettingsScoped').at(-1)).toEqual(['pi:agentSettingsScoped', '/work/app'])
  await choose('Default thinking level', 'high')
  expect(calls('pi:patchAgentSettings').at(-1)).toEqual([
    'pi:patchAgentSettings',
    'project',
    '/work/app',
    { defaultThinkingLevel: 'high' },
  ])
})

it('blocks editing a malformed settings.json and points at Advanced', async () => {
  malformed = true
  await show()
  expect(container.textContent).toContain('settings.json is not valid JSON')
  expect(container.textContent).toContain('Unexpected token')
  await act(async () => control<HTMLButtonElement>('Hide thinking blocks', 'button').click())
  expect(calls('pi:patchAgentSettings')).toEqual([])
  const fix = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.startsWith('Fix it in Advanced'),
  )!
  const { setTab } = useSettingsUiStore.getState()
  const opened = vi.fn()
  useSettingsUiStore.setState({ setTab: opened })
  await act(async () => fix.click())
  useSettingsUiStore.setState({ setTab })
  expect(opened).toHaveBeenCalledWith('advanced')
})

it('saves the context budget and directive switches as Phosphor prefs', async () => {
  await show()
  const preset = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((r) =>
    r.textContent?.startsWith('400k tokens'),
  )!
  await act(async () => preset.click())
  expect(calls('app:setContextBudget')).toEqual([['app:setContextBudget', '400k']])
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[role="switch"][aria-label="Lane charter"]')!
      .click(),
  )
  expect(calls('app:setAgentDirectives')).toEqual([
    ['app:setAgentDirectives', { ...DEFAULT_AGENT_DIRECTIVES, laneCharter: false }, undefined],
  ])
})
