// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { prepareHostSettings, showHostSettings } from './__fixtures__/hostSettingsSurface'
import { useSettingsUiStore, type SettingsTab } from './settingsUiStore'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { mixedRemoteHosts } from '@/dev/mockRemoteLanes'
import { mockSettingsRead, mockSettingsPatch } from '@/dev/mockMachineSettings'
import { promptChoice } from '@/stores/prompt'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useMachineCataloguesStore } from '@/stores/machineCatalogues'
import { COMPACT_PLATFORM, WIDE_BROWSER_PLATFORM } from '@/platform/Platform'
vi.mock('@/stores/prompt', () => ({
  promptChoice: vi.fn(async () => undefined),
  promptText: vi.fn(),
}))
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
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
const machine = { id: '11111111-1111-4111-8111-111111111111', label: 'bee1' }
const invoke = vi.fn()
let root: Root, container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(window, 'phosphor', { configurable: true, value: { invoke } })
  useRemoteLanesStore.setState({ hosts: mixedRemoteHosts() })
  prepareHostSettings(machine)
  useMachineCataloguesStore.setState({ catalogues: {} })
  invoke.mockReset().mockImplementation(async (channel, hostId, section, repositoryId) => {
    if (channel === 'hosts:settingsRead') return mockSettingsRead(hostId, section, repositoryId)
    if (channel === 'hosts:settingsPatch') return mockSettingsPatch(hostId, section)
    if (channel === 'hosts:models')
      return [
        { id: 'claude-sonnet-4-5', name: 'Host model', provider: 'anthropic', reasoning: true },
      ]
    if (channel === 'hosts:providers') return []
    return undefined
  })
  vi.mocked(promptChoice).mockReset().mockResolvedValue(undefined)
  useExtensionUiStore.setState({ toasts: [] })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})
function button(text: string) {
  const value = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  )
  if (!value) throw new Error(`Missing ${text}`)
  return value
}
const render = (tab: SettingsTab) => showHostSettings(root, machine.id, tab)
it('shows explicit configuration authority instead of borrowing local settings or lane control', async () => {
  const hosts = mixedRemoteHosts()
  hosts[machine.id]!.capabilities = ['sessions.read', 'sessions.control']
  useRemoteLanesStore.setState({ hosts })
  await render('accounts')
  expect(container.textContent).toContain('Configuring bee1')
  expect(container.textContent).toContain('Configuration access is not enabled')
  expect(invoke).not.toHaveBeenCalled()
  vi.mocked(promptChoice).mockResolvedValue('enable')
  await act(async () => {
    button('Enable configuration access').click()
  })
  expect(invoke).toHaveBeenCalledWith('hosts:settingsAccess', machine.id)
  expect(
    invoke.mock.calls.some(
      ([channel]) => channel.startsWith('claude:') || channel.startsWith('pi:'),
    ),
  ).toBe(false)
})
it('distinguishes old and offline Hosts without presenting credentials as empty', async () => {
  const hosts = mixedRemoteHosts()
  hosts[machine.id]!.configurationSupported = false
  useRemoteLanesStore.setState({ hosts })
  await render('accounts')
  expect(container.textContent).toContain('Update this Host')
  expect(invoke).not.toHaveBeenCalled()
  hosts[machine.id]!.state = 'down'
  await act(async () => {
    useRemoteLanesStore.setState({ hosts: structuredClone(hosts) })
  })
  // The control plane has never seen bee1 check in: the Machines page's words, and its fix.
  expect(container.textContent).toContain('bee1 has never connected.')
  expect(container.textContent).toContain('phosphor setup')
  expect(container.textContent).toContain('Nothing is queued')
  expect(button('Reconnect').disabled).toBe(false)
})
function typeInto(input: HTMLInputElement, value: string) {
  act(() => {
    input.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function select(label: string, value: string) {
  const field = container.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!
  field.value = value
  field.dispatchEvent(new Event('change', { bubbles: true }))
}
const toggle = (label: string) =>
  container.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`)!.click()
const patches = () => invoke.mock.calls.filter(([channel]) => channel === 'hosts:settingsPatch')
const toasts = () => useExtensionUiStore.getState().toasts.map((t) => [t.kind, t.message])
it('saves a committed Host policy edit on its own, says so, and leaves without asking', async () => {
  await render('agent')
  expect(invoke).toHaveBeenCalledWith('hosts:models', machine.id)
  expect(container.textContent).toContain('Changes save as you make them.')
  expect(container.textContent).not.toContain('Review Host policy')
  const input = container.querySelector<HTMLInputElement>('[aria-label="Custom context budget"]')!
  typeInto(input, '100k')
  expect(patches()).toHaveLength(0)
  await act(async () => input.blur())
  expect(patches()).toEqual([
    [
      'hosts:settingsPatch',
      machine.id,
      expect.objectContaining({
        section: 'agent',
        change: { type: 'agent.patch', patch: { contextBudget: '100k' } },
      }),
    ],
  ])
  expect(promptChoice).not.toHaveBeenCalled()
  expect(toasts()).toContainEqual(['info', 'Saved on bee1 — applies to new lanes'])
  await act(async () => {
    button('Accounts').click()
  })
  expect(promptChoice).not.toHaveBeenCalled()
  expect(useSettingsUiStore.getState()).toMatchObject({ tab: 'accounts', machine: machine.id })
})
it('refuses an invalid context budget in place instead of sending it', async () => {
  await render('agent')
  const input = container.querySelector<HTMLInputElement>('[aria-label="Custom context budget"]')!
  typeInto(input, '77k')
  await act(async () => input.blur())
  expect(container.textContent).toContain('Use a budget from 100k to 1M')
  expect(patches()).toHaveLength(0)
})
it('keeps a change the Host refused, says so, and retries on request', async () => {
  const normal = invoke.getMockImplementation()!
  let refuse = true
  invoke.mockImplementation(async (...args) => {
    if (args[0] === 'hosts:settingsPatch' && refuse) throw new Error('Host is busy')
    return normal(...args)
  })
  await render('agent')
  await act(async () => select('Default thinking level', 'high'))
  expect(container.textContent).toContain('Some changes are not saved on bee1')
  expect(container.textContent).toContain('Host is busy')
  expect(toasts()).toContainEqual([
    'error',
    'Couldn’t save on bee1. Your change is kept in Agent defaults.',
  ])
  refuse = false
  await act(async () => button('Try again').click())
  expect(patches()).toHaveLength(2)
  expect(container.textContent).not.toContain('Some changes are not saved')
  expect(toasts()).toContainEqual(['info', 'Saved on bee1 — applies to new lanes'])
})
it('recovers a failed Host model catalogue without borrowing local models', async () => {
  const normal = invoke.getMockImplementation()!
  let attempts = 0
  invoke.mockImplementation(async (...args) => {
    if (args[0] === 'hosts:models' && attempts++ === 0) throw new Error('temporarily unavailable')
    return normal(...args)
  })
  await render('agent')
  expect(container.textContent).toContain('Could not read this machine’s model catalogue')
  await act(async () => button('Retry model catalogue').click())
  expect(container.textContent).not.toContain('Could not read this machine’s model catalogue')
  expect(container.textContent).toContain('Host model')
})
it('saves thinking and agent behavior on the Host even if its model is absent from the catalogue', async () => {
  const normal = invoke.getMockImplementation()!
  invoke.mockImplementation(async (...args) => (args[0] === 'hosts:models' ? [] : normal(...args)))
  await render('agent')
  // The demo Host keeps its state between tests: pick a level no other test saves.
  await act(async () => select('Default thinking level', 'low'))
  await act(async () => toggle('Auto-compaction'))
  expect(patches().map(([, host, patch]) => [host, patch.change])).toEqual([
    [machine.id, { type: 'agent.patch', patch: { defaultThinkingLevel: 'low' } }],
    [machine.id, { type: 'agent.patch', patch: { compaction: { enabled: false } } }],
  ])
  expect(promptChoice).not.toHaveBeenCalled()
  expect(container.textContent).not.toContain('Review agent behavior')
  expect(invoke.mock.calls.every(([channel]) => channel.startsWith('hosts:'))).toBe(true)
})
it('keeps older Host model defaults usable without offering unsupported behavior edits', async () => {
  const normal = invoke.getMockImplementation()!
  invoke.mockImplementation(async (...args) => {
    const result = await normal(...args)
    if (args[0] === 'hosts:settingsRead' && args[2] === 'agent')
      delete result.agentBehaviorSupported
    return result
  })
  await render('agent')
  expect(container.textContent).toContain('Update this Host to configure compaction')
  expect(container.querySelector('[aria-label="Retry on transient errors"]')).toBeNull()
  expect(
    container.querySelector<HTMLSelectElement>('[aria-label="Default thinking level"]')!.disabled,
  ).toBe(false)
})
it('offers a headless-safe extension catalogue and existing multiple-account controls', async () => {
  await render('extensions')
  const add = (title: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="Add ${title}"]`)
  expect(container.textContent).toContain('Recommended')
  expect(add('Subagents')?.disabled).toBe(false)
  expect(add('Web access')?.disabled).toBe(false)
  // Computer use needs a desktop session: a Host never offers it.
  expect(add('Computer use')).toBeNull()
  await render('claude-provider')
  expect(button('Add account').disabled).toBe(false)
  expect(container.textContent).toContain('work@bee1.example')
})
it('keeps provider credentials separated by Host and makes usage unavailable, not zero', async () => {
  await render('claude-provider')
  expect(container.textContent).toContain('dev@bee1.example')
  expect(container.textContent).not.toContain('dev@bee5.example')
  const row = container.querySelector('[data-account-id="default"]')!
  await act(async () => {
    row.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click()
  })
  expect(container.textContent).toContain('No usage reading yet')
  expect(row.querySelector('.border-t')?.textContent).not.toContain('%')
  expect(invoke.mock.calls.every(([channel]) => channel.startsWith('hosts:'))).toBe(true)
})
it.each([COMPACT_PLATFORM, WIDE_BROWSER_PLATFORM])(
  'offers the same explicit configuration access in a $formFactor browser',
  async (platform) => {
    const hosts = mixedRemoteHosts()
    hosts[machine.id]!.capabilities = ['sessions.read', 'sessions.control']
    useRemoteLanesStore.setState({ hosts })
    await showHostSettings(root, machine.id, 'accounts', platform)
    expect(container.textContent).not.toContain('available in Phosphor Desktop')
    vi.mocked(promptChoice).mockResolvedValue('enable')
    await act(async () => {
      button('Enable configuration access').click()
    })
    expect(promptChoice).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith('hosts:settingsAccess', machine.id)
  },
)
it("links a Host's Accounts to its Claude Code page under Extensions", async () => {
  await render('accounts')
  expect(button('Open Claude Code').disabled).toBe(false)
  await act(async () => {
    button('Open Claude Code').click()
  })
  expect(useSettingsUiStore.getState().tab).toBe('claude-provider')
  const selected = [
    ...container.querySelectorAll(
      'nav[aria-label="Settings sections"] button[aria-current="page"]',
    ),
  ].map((b) => b.textContent)
  expect(selected).toEqual(['Extensions', 'Claude Code'])
  expect(container.textContent).toContain('work@bee1.example')
})
