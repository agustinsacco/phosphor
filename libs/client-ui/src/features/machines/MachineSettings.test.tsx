// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MachineSettings } from './MachineSettings'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useMachinesStore } from '@/stores/machines'
import { mixedRemoteHosts } from '@/dev/mockRemoteLanes'
import { mockSettingsRead, mockSettingsPatch } from '@/dev/mockMachineSettings'
import { promptChoice } from '@/stores/prompt'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { COMPACT_PLATFORM, PlatformProvider, WIDE_BROWSER_PLATFORM } from '@/platform/Platform'
vi.mock('@/stores/prompt', () => ({
  promptChoice: vi.fn(async () => undefined),
  promptText: vi.fn(),
}))
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
const machine = { id: '11111111-1111-4111-8111-111111111111', label: 'bee1' }
const invoke = vi.fn()
let root: Root, container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(window, 'phosphor', { configurable: true, value: { invoke } })
  useRemoteLanesStore.setState({ hosts: mixedRemoteHosts() })
  useMachinesStore.setState({ view: { kind: 'machine', id: machine.id, settings: 'agent' } })
  invoke.mockReset().mockImplementation(async (channel, hostId, section, repositoryId) => {
    if (channel === 'hosts:settingsRead') return mockSettingsRead(hostId, section, repositoryId)
    if (channel === 'hosts:settingsPatch') return mockSettingsPatch(hostId, section)
    if (channel === 'hosts:models')
      return [
        { id: 'claude-sonnet-4-5', name: 'Host model', provider: 'anthropic', reasoning: true },
      ]
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
async function render(section: Parameters<typeof MachineSettings>[0]['section']) {
  await act(async () => {
    root.render(<MachineSettings machine={machine} section={section} />)
  })
}
it('shows explicit configuration authority instead of borrowing local settings or lane control', async () => {
  const hosts = mixedRemoteHosts()
  hosts[machine.id]!.capabilities = ['sessions.read', 'sessions.control']
  useRemoteLanesStore.setState({ hosts })
  await render('providers')
  expect(container.textContent).toContain('Configuring bee1, not this computer')
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
  await render('providers')
  expect(container.textContent).toContain('Update the Host')
  expect(invoke).not.toHaveBeenCalled()
  hosts[machine.id]!.state = 'down'
  await act(async () => {
    useRemoteLanesStore.setState({ hosts: structuredClone(hosts) })
  })
  expect(container.textContent).toContain('Connect to bee1 first')
  expect(container.textContent).toContain('Nothing is queued')
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
const patches = () => invoke.mock.calls.filter(([channel]) => channel === 'hosts:settingsPatch')
const toasts = () => useExtensionUiStore.getState().toasts.map((t) => [t.kind, t.message])
it('saves a committed Host policy edit on its own, says so, and leaves without asking', async () => {
  await render('agent')
  expect(invoke).toHaveBeenCalledWith('hosts:models', machine.id)
  expect(container.textContent).toContain('Changes save automatically.')
  expect(container.textContent).not.toContain('Review Host policy')
  const input = container.querySelector<HTMLInputElement>('[aria-label="Host context budget"]')!
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
    button('Providers').click()
  })
  expect(promptChoice).not.toHaveBeenCalled()
  expect(useMachinesStore.getState().view).toMatchObject({ settings: 'providers', id: machine.id })
})
it('refuses an invalid context budget in place instead of sending it', async () => {
  await render('agent')
  const input = container.querySelector<HTMLInputElement>('[aria-label="Host context budget"]')!
  typeInto(input, '77k')
  await act(async () => input.blur())
  expect(container.textContent).toContain('Not saved: use a budget from 100k to 1M')
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
  await act(async () => select('Default Host thinking', 'high'))
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
  expect(container.textContent).toContain('Could not read bee1’s model catalogue')
  await act(async () => button('Retry bee1 model catalogue').click())
  expect(container.textContent).not.toContain('Could not read bee1’s model catalogue')
  expect(container.textContent).toContain('Host model')
})
it('saves thinking and agent behavior on the Host even if its model is absent from the catalogue', async () => {
  const normal = invoke.getMockImplementation()!
  invoke.mockImplementation(async (...args) => (args[0] === 'hosts:models' ? [] : normal(...args)))
  await render('agent')
  // The demo Host keeps its state between tests: pick a level no other test saves.
  await act(async () => select('Default Host thinking', 'low'))
  await act(async () => select('Enable automatic compaction', 'false'))
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
  expect(container.querySelector('[aria-label="Enable automatic retry"]')).toBeNull()
  expect(
    container.querySelector<HTMLSelectElement>('[aria-label="Default Host thinking"]')!.disabled,
  ).toBe(false)
})
it('offers a headless-safe extension catalogue and existing multiple-account controls', async () => {
  await render('resources')
  expect(container.textContent).toContain('Standard Host extensions')
  expect(container.textContent).toContain('computer use is not installed')
  expect(button('Install Swarm subagents').disabled).toBe(false)
  expect(button('Install Web access').disabled).toBe(false)
  await render('providers')
  expect(button('Add account').disabled).toBe(false)
  expect(container.textContent).toContain('work@bee1.example')
})
it('keeps provider credentials separated by Host and makes usage unavailable, not zero', async () => {
  await render('providers')
  expect(container.textContent).toContain('dev@bee1.example')
  expect(container.textContent).not.toContain('dev@bee5.example')
  await act(async () => {
    button('Usage & lanes').click()
  })
  expect(container.textContent).toContain('Unavailable is not zero')
  expect(invoke.mock.calls.every(([channel]) => channel.startsWith('hosts:'))).toBe(true)
})
it.each([COMPACT_PLATFORM, WIDE_BROWSER_PLATFORM])(
  'offers the same explicit configuration access in a $formFactor browser',
  async (platform) => {
    const hosts = mixedRemoteHosts()
    hosts[machine.id]!.capabilities = ['sessions.read', 'sessions.control']
    useRemoteLanesStore.setState({ hosts })
    await act(async () => {
      root.render(
        <PlatformProvider value={platform}>
          <MachineSettings machine={machine} section="providers" />
        </PlatformProvider>,
      )
    })
    expect(container.textContent).not.toContain('available in Phosphor Desktop')
    vi.mocked(promptChoice).mockResolvedValue('enable')
    await act(async () => {
      button('Enable configuration access').click()
    })
    expect(promptChoice).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith('hosts:settingsAccess', machine.id)
  },
)
