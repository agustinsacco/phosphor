// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MachineSettings } from './MachineSettings'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useMachinesStore } from '@/stores/machines'
import { mixedRemoteHosts } from '@/dev/mockRemoteLanes'
import { mockSettingsRead } from '@/dev/mockMachineSettings'
import { promptChoice } from '@/stores/prompt'
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
    if (channel === 'hosts:models')
      return [
        { id: 'claude-sonnet-4-5', name: 'Host model', provider: 'anthropic', reasoning: true },
      ]
    return undefined
  })
  vi.mocked(promptChoice).mockReset().mockResolvedValue(undefined)
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
it('loads the Host catalogue, preserves dirty drafts, and confirms discard before switching scopes', async () => {
  await render('agent')
  expect(invoke).toHaveBeenCalledWith('hosts:models', machine.id)
  const input = container.querySelector<HTMLInputElement>('[aria-label="Host context budget"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '100k')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    button('Providers').click()
  })
  expect(promptChoice).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'Discard unsaved Host settings?' }),
  )
  expect(useMachinesStore.getState().view).toMatchObject({ settings: 'agent' })
  vi.mocked(promptChoice).mockResolvedValue('discard')
  await act(async () => {
    button('Providers').click()
  })
  expect(useMachinesStore.getState().view).toMatchObject({ settings: 'providers', id: machine.id })
  expect(invoke.mock.calls.some(([channel]) => channel === 'hosts:settingsPatch')).toBe(false)
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
