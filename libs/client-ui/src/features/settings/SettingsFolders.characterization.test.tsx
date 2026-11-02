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

/* Host Folders, as the shared Settings renders it for a Host. */
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
    if (channel === 'hosts:listFolders') return { path: '', truncated: false, entries: [] }
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
function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  if (!found) throw new Error(`Missing ${text}`)
  return found
}

it("lists the Host's registered folders by name and Host path", async () => {
  await showHostSettings(root, machine.id, 'folders')
  expect(container.textContent).toContain('Phosphor')
  expect(container.textContent).toContain('/remote/phosphor')
})

it('unregisters a folder only after asking, and never deletes files', async () => {
  await showHostSettings(root, machine.id, 'folders')
  await act(async () => button('Unregister').click())
  expect(vi.mocked(promptChoice).mock.calls[0]?.[0].message).toContain('Files are never deleted')
  expect(invoke).not.toHaveBeenCalledWith('hosts:removeRepository', machine.id, '0000000000000001')
  vi.mocked(promptChoice).mockResolvedValue('remove')
  await act(async () => button('Unregister').click())
  expect(invoke).toHaveBeenCalledWith('hosts:removeRepository', machine.id, '0000000000000001')
})

it("reviews a folder's project trust through the Host's reviewed task", async () => {
  await showHostSettings(root, machine.id, 'folders')
  await act(async () => button('Review project trust').click())
  expect(vi.mocked(promptChoice).mock.calls[0]?.[0].title).toBe('Review project trust on bee1?')
})

it("adds a folder by browsing the Host's own folders", async () => {
  await showHostSettings(root, machine.id, 'folders')
  await act(async () => button('Add folder').click())
  expect(invoke).toHaveBeenCalledWith('hosts:listFolders', machine.id, '', false)
})
