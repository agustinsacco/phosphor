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
  expect(thinking.selectedOptions[0]?.textContent).toBe('Machine (high)')
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
  const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry')
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

it.each([
  ['local', 'pi:patchAgentSettings'],
  [HOST.id, 'hosts:settingsPatch'],
])(
  'saves a custom model only as the whole pair the user entered (regression A2, %s)',
  async (machine, channel) => {
    invoke.mockImplementation(async (name: string, hostId, section, repositoryId) => {
      if (name === 'hosts:settingsPatch') return mockSettingsPatch(hostId, section)
      if (name === 'hosts:settingsRead') return mockSettingsRead(hostId, section, repositoryId)
      if (name === 'pi:agentSettingsScoped')
        return {
          global: { defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-4-5' },
          project: null,
        }
      return local(name)
    })
    await showHostSettings(root, machine, 'agent')
    const field = (title: string) => row(title).querySelector<HTMLInputElement>('input')!
    const type = async (title: string, value: string) => {
      const input = field(title)
      await act(async () => {
        input.focus()
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          value,
        )
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    const models = () =>
      invoke.mock.calls
        .filter(([name]) => name === channel)
        .map((call) => JSON.stringify(call.at(-1)))
        .filter((patch) => patch.includes('defaultModel'))
    await type('Provider id', 'openai')
    // Moving on to the model id leaves the provider id, not the disclosure.
    await type('Model id', 'gpt-5')
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(models()).toEqual([])
    await act(async () => {
      field('Model id').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(models()).toHaveLength(1)
    expect(models()[0]).toContain('"defaultProvider":"openai","defaultModel":"gpt-5"')
  },
)

it('keeps both of two quick This Mac edits on screen once both saves land (regression R-U2)', async () => {
  const saves: Array<() => void> = []
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'pi:patchAgentSettings')
      return new Promise<void>((resolve) => saves.push(resolve))
    return local(channel)
  })
  await showHostSettings(root, 'local', 'agent')
  const toggle = (title: string) => row(title).querySelector<HTMLButtonElement>('[role="switch"]')!
  await act(async () => toggle('Auto-compaction').click())
  await act(async () => toggle('Retry on transient errors').click())
  expect(saves).toHaveLength(2)
  await act(async () => saves.forEach((save) => save()))
  expect(toggle('Auto-compaction').getAttribute('aria-checked')).toBe('false')
  expect(toggle('Retry on transient errors').getAttribute('aria-checked')).toBe('false')
})

it('writes medium when it is chosen at machine scope while pi’s default medium is shown (regression R-U3)', async () => {
  await showHostSettings(root, 'local', 'agent')
  // A browser fires no change for the option already selected.
  const thinking = row('Default thinking level').querySelector('select')!
  expect(thinking.value).not.toBe('medium')
  await act(async () => {
    thinking.value = 'medium'
    thinking.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(invoke).toHaveBeenCalledWith('pi:patchAgentSettings', 'global', undefined, {
    defaultThinkingLevel: 'medium',
  })
})

it.each([
  [{ defaultModel: 'gpt-5' }, ['', 'gpt-5']],
  [{ defaultProvider: 'openai' }, ['openai', '']],
])(
  'shows a model key set on its own as set here, and Reset clears it (regression R-U4, %o)',
  async (global, ids) => {
    invoke.mockImplementation(async (channel: string) =>
      channel === 'pi:agentSettingsScoped' ? { global, project: null } : local(channel),
    )
    await showHostSettings(root, 'local', 'agent')
    const badge = row('Default model').querySelector('[data-setting-source]')
    expect(badge?.getAttribute('data-setting-source')).toBe('set-here')
    const field = (title: string) => row(title).querySelector<HTMLInputElement>('input')!.value
    expect([field('Provider id'), field('Model id')]).toEqual(ids)
    const reset = container.querySelector<HTMLButtonElement>('[aria-label="Reset Default model"]')
    await act(async () => reset!.click())
    expect(invoke).toHaveBeenCalledWith('pi:patchAgentSettings', 'global', undefined, {
      defaultProvider: undefined,
      defaultModel: undefined,
    })
  },
)

it.each([
  ['defaultProvider', ['', 'claude-sonnet-4-5']],
  ['defaultModel', ['anthropic', '']],
] as const)(
  'shows a Host model key set on its own as set here, and Reset clears it (regression R-U4, no %s)',
  async (missing, ids) => {
    invoke.mockImplementation(async (channel: string, hostId, section, repositoryId) => {
      if (channel === 'hosts:models') return []
      if (channel === 'hosts:settingsPatch') return mockSettingsPatch(hostId, section)
      if (channel !== 'hosts:settingsRead') return local(channel)
      const read = mockSettingsRead(hostId, section, repositoryId)
      // The mock Host keeps earlier tests' saves: pin the pair, then drop one key.
      Object.assign(read.agent!, {
        defaultProvider: 'anthropic',
        defaultModel: 'claude-sonnet-4-5',
      })
      delete read.agent![missing]
      return read
    })
    await showHostSettings(root, HOST.id, 'agent')
    const badge = row('Default model').querySelector('[data-setting-source]')
    expect(badge?.getAttribute('data-setting-source')).toBe('set-here')
    const field = (title: string) => row(title).querySelector<HTMLInputElement>('input')!.value
    expect([field('Provider id'), field('Model id')]).toEqual(ids)
    const reset = container.querySelector<HTMLButtonElement>('[aria-label="Reset Default model"]')
    await act(async () => reset!.click())
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(invoke).toHaveBeenCalledWith(
      'hosts:settingsPatch',
      HOST.id,
      expect.objectContaining({
        change: { type: 'agent.patch', patch: { defaultProvider: null, defaultModel: null } },
      }),
    )
  },
)
