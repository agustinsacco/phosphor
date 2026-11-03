// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { prepareHostSettings, showHostSettings } from './__fixtures__/hostSettingsSurface'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { mixedRemoteHosts } from '@/dev/mockRemoteLanes'
import { mockSettingsRead } from '@/dev/mockMachineSettings'
import { promptChoice } from '@/stores/prompt'

vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
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

/* Host Advanced, as the shared Settings renders it for a Host. */
const machine = { id: '11111111-1111-4111-8111-111111111111', label: 'bee1' }
const invoke = vi.fn()
let root: Root, container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(window, 'phosphor', { configurable: true, value: { invoke } })
  useRemoteLanesStore.setState({ hosts: mixedRemoteHosts() })
  prepareHostSettings(machine)
  invoke.mockReset().mockImplementation(async (channel, hostId, section) => {
    if (channel === 'hosts:settingsRead') return mockSettingsRead(hostId, section)
    // No terminal opens here: the task call itself is what is pinned.
    if (channel === 'hosts:machineTask') throw new Error('no terminal in this test')
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
function update(): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === 'Pause and update',
  )
  if (!found) throw new Error('Missing Pause and update')
  return found
}

it('asks before the Host pauses and updates itself through its fixed-purpose task', async () => {
  await showHostSettings(root, machine.id, 'advanced')
  expect(container.textContent).toContain('Host updates')
  await act(async () => update().click())
  expect(vi.mocked(promptChoice).mock.calls[0]?.[0].title).toBe('Pause and update bee1?')
  expect(invoke).not.toHaveBeenCalledWith('hosts:machineTask', machine.id, expect.anything())
  vi.mocked(promptChoice).mockResolvedValue('run')
  await act(async () => update().click())
  expect(invoke).toHaveBeenCalledWith('hosts:machineTask', machine.id, {
    type: 'machine.task',
    task: 'host.update',
  })
})

it('offers no update while a private Host program cannot run', async () => {
  const hosts = mixedRemoteHosts()
  hosts[machine.id]!.capabilities = hosts[machine.id]!.capabilities.filter((c) => c !== 'terminal')
  useRemoteLanesStore.setState({ hosts })
  await showHostSettings(root, machine.id, 'advanced')
  expect(update().disabled).toBe(true)
})

it("shows the Host's paths, PATH and environment names, never values or raw editors", async () => {
  await showHostSettings(root, machine.id, 'advanced')
  const text = container.textContent ?? ''
  expect(text).toContain('/home/bee1/.config/phosphor/host.json')
  expect(text).toContain('/home/bee1/.pi/agent')
  expect(text).toContain('/usr/bin')
  expect(text).toContain('EXAMPLE_API_KEY')
  expect(text).toContain('Missing from service')
  expect(text).not.toContain('settings.json')
  expect(text).not.toContain('Edit…')
})
