// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_DIRECTIVES, DEFAULT_LANE_PREFS } from '@shared/models'
import { mockSettingsPatch, mockSettingsRead } from '@/dev/mockMachineSettings'
import { mixedRemoteHosts } from '@/dev/mockRemoteLanes'
import { useLanePrefsStore } from '@/stores/lanePrefs'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { prepareHostSettings, showHostSettings } from '../../__fixtures__/hostSettingsSurface'
import { useSettingsUiStore } from '../../settingsUiStore'

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  })
})
vi.mock('@/lib/monaco', () => ({}))

const HOST = { id: '11111111-1111-4111-8111-111111111111', label: 'bee1' }
const invoke = vi.fn()
let root: Root
let container: HTMLDivElement
let edit: (read: ReturnType<typeof mockSettingsRead>) => void
beforeEach(() => {
  edit = () => undefined
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke, platform: 'darwin', onAccountChanged: () => () => {} })
  useRemoteLanesStore.setState({ hosts: mixedRemoteHosts() })
  useLanePrefsStore.setState({ lanes: DEFAULT_LANE_PREFS })
  prepareHostSettings(HOST)
  useSettingsUiStore.setState({ folder: null })
  invoke.mockReset().mockImplementation(async (channel: string, hostId, section, repositoryId) => {
    if (channel === 'hosts:settingsRead') {
      const read = mockSettingsRead(hostId, section, repositoryId)
      edit(read)
      return read
    }
    if (channel === 'hosts:settingsPatch') return mockSettingsPatch(hostId, section)
    if (channel === 'hosts:models') return []
    if (channel === 'pi:agentSettingsScoped')
      return { global: { defaultThinkingLevel: 'high', retry: { maxRetries: 5 } }, project: {} }
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

const row = (title: string): Element => {
  const found = [...container.querySelectorAll('[data-setting-row]')].find(
    (r) => r.firstElementChild?.firstElementChild?.textContent === title,
  )
  if (!found) throw new Error(`No row ${title}`)
  return found
}
const badge = (title: string) =>
  row(title).querySelector('[data-setting-source]')?.getAttribute('data-setting-source')
const reset = (title: string) =>
  container.querySelector<HTMLButtonElement>(`[aria-label="Reset ${title}"]`)
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
const hostPatches = () =>
  invoke.mock.calls.filter(([c]) => c === 'hosts:settingsPatch').map(([, , p]) => p.change.patch)

it('orders the groups the same on every machine', async () => {
  await showHostSettings(root, 'local', 'agent')
  const groups = [...container.querySelectorAll('section')].map((s) => s.getAttribute('aria-label'))
  expect(groups).toEqual([
    'New lanes',
    'Behaviour',
    'Compaction',
    'Retry',
    'Instructions and directives',
  ])
  await showHostSettings(root, HOST.id, 'agent')
  const host = [...container.querySelectorAll('section')].map((s) => s.getAttribute('aria-label'))
  expect(host).toEqual(groups)
})

it('says where This Mac takes each value from, and Reset clears it', async () => {
  await showHostSettings(root, 'local', 'agent')
  expect([badge('Default thinking level'), badge('Max retries'), badge('Base delay (ms)')]).toEqual(
    ['set-here', 'set-here', 'pi-default'],
  )
  expect(reset('Base delay (ms)')).toBeNull()
  await act(async () => reset('Default thinking level')!.click())
  expect(invoke).toHaveBeenCalledWith('pi:patchAgentSettings', 'global', undefined, {
    defaultThinkingLevel: undefined,
  })
  expect(badge('Default thinking level')).toBe('pi-default')
})

it("shows This Mac's machine values as inherited in folder scope", async () => {
  useSettingsUiStore.setState({ folder: '/work/app' })
  await showHostSettings(root, 'local', 'agent')
  const thinking = row('Default thinking level').querySelector('select')!
  expect(thinking.selectedOptions[0]?.textContent).toBe('Machine (high)')
  expect([badge('Default thinking level'), badge('Max retries')]).toEqual([
    'inherited',
    'inherited',
  ])
  expect(container.textContent).not.toContain('Name new lanes automatically')
})

it('names new lanes from the Agent section on This Mac', async () => {
  await showHostSettings(root, 'local', 'agent')
  await act(async () => row('Name new lanes automatically').querySelector('button')!.click())
  expect(invoke).toHaveBeenCalledWith('app:setLanePrefs', {
    ...DEFAULT_LANE_PREFS,
    autoName: false,
  })
})

it('clears a Host value with null, and offers Reset only on a Host that supports it', async () => {
  edit = (read) => delete read.agentClearSupported
  await showHostSettings(root, HOST.id, 'agent')
  expect(badge('Default thinking level')).toBe('set-here')
  expect(reset('Default thinking level')).toBeNull()
  edit = () => undefined
  await act(async () => root.unmount())
  root = createRoot(container)
  await showHostSettings(root, HOST.id, 'agent')
  await act(async () => reset('Default thinking level')!.click())
  await settle()
  expect(hostPatches()).toEqual([{ defaultThinkingLevel: null }])
  expect(badge('Default thinking level')).toBe('pi-default')
})

it('keeps the restart note only on a Host that binds naming at boot', async () => {
  await showHostSettings(root, HOST.id, 'agent')
  expect(row('Name new lanes automatically').textContent).not.toContain('service restarts')
  edit = (read) => delete read.agent?.namingLive
  await act(async () => root.unmount())
  root = createRoot(container)
  await showHostSettings(root, HOST.id, 'agent')
  expect(row('Name new lanes automatically').textContent).toContain(
    'applies after its service restarts',
  )
})

it('saves a custom Host model pair from the disclosure once it is left', async () => {
  await showHostSettings(root, HOST.id, 'agent')
  const field = (title: string) => row(title).querySelector<HTMLInputElement>('input')!
  const type = async (title: string, value: string) => {
    const input = field(title)
    await act(async () => {
      input.focus()
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => input.blur())
  }
  await type('Provider id', 'openai')
  await type('Model id', 'gpt-5')
  await settle()
  // The last field left takes focus out of the disclosure, which saves the whole pair.
  expect(hostPatches().at(-1)).toEqual({ defaultProvider: 'openai', defaultModel: 'gpt-5' })
  expect(row('Default model').querySelector('select')!.value).toBe(
    JSON.stringify(['openai', 'gpt-5']),
  )
})

it('offers the unset choice for a value set here only where it can be cleared, as Reset', async () => {
  const unset = () => row('Default thinking level').querySelector('select')!.options[0]!
  const thinkHard = (read: ReturnType<typeof mockSettingsRead>) => {
    if (read.agent) read.agent.defaultThinkingLevel = 'high'
  }
  edit = (read) => {
    thinkHard(read)
    delete read.agentClearSupported
  }
  await showHostSettings(root, HOST.id, 'agent')
  expect(badge('Default thinking level')).toBe('set-here')
  expect(unset().value).toBe('off')
  edit = thinkHard
  await act(async () => root.unmount())
  root = createRoot(container)
  await showHostSettings(root, HOST.id, 'agent')
  expect([unset().value, unset().textContent]).toEqual(['', 'pi default (medium)'])
  const select = row('Default thinking level').querySelector('select')!
  await act(async () => {
    select.value = ''
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
  expect(hostPatches()).toEqual([{ defaultThinkingLevel: null }])
})

it('lets a folder pin the model it inherits from the machine', async () => {
  const sonnet = JSON.stringify(['anthropic', 'claude-sonnet-4-5'])
  const answer = invoke.getMockImplementation()!
  invoke.mockImplementation(async (channel: string, ...rest: unknown[]) =>
    channel === 'pi:agentSettingsScoped'
      ? { global: { defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-4-5' }, project: {} }
      : answer(channel, ...rest),
  )
  useSettingsUiStore.setState({ folder: '/work/app' })
  await showHostSettings(root, 'local', 'agent')
  const select = row('Default model').querySelector('select')!
  expect(select.selectedOptions[0]?.textContent).toBe('Machine (anthropic/claude-sonnet-4-5)')
  await act(async () => {
    select.value = sonnet
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(invoke).toHaveBeenCalledWith('pi:patchAgentSettings', 'project', '/work/app', {
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4-5',
  })
})
