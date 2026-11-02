// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mockSettingsPatch, mockSettingsRead } from '@/dev/mockMachineSettings'
import { mixedRemoteHosts } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { prepareHostSettings, showHostSettings } from '../../__fixtures__/hostSettingsSurface'

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  })
})
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))

const machine = { id: '11111111-1111-4111-8111-111111111111', label: 'bee1' }
let oldHost = false
const invoke = vi.fn()
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke, platform: 'darwin', onAccountChanged: () => () => {} })
  useRemoteLanesStore.setState({ hosts: mixedRemoteHosts(), filter: 'local' })
  prepareHostSettings(machine)
  oldHost = false
  invoke.mockReset().mockImplementation(async (channel, hostId, section, repositoryId) => {
    if (channel === 'packages:list')
      return [
        { spec: 'npm:pi-web-access', name: 'pi-web-access', scope: 'global', installed: true },
      ]
    if (channel === 'pi:webSearchConfig')
      return {
        path: '/home/me/.pi/web-search.json',
        exists: true,
        malformed: false,
        configured: ['tavilyApiKey'],
      }
    if (channel === 'hosts:settingsRead') {
      const read = await mockSettingsRead(hostId, section, repositoryId)
      if (!read.resources) return read
      const packages = [
        { spec: 'npm:pi-web-access', name: 'pi-web-access', installed: true, scope: 'global' },
      ]
      const { webAccess, ...rest } = read.resources
      return { ...read, resources: { ...rest, packages, ...(oldHost ? {} : { webAccess }) } }
    }
    if (channel === 'hosts:settingsPatch') return mockSettingsPatch(hostId, section)
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

const settle = (): Promise<void> => act(async () => new Promise((r) => setTimeout(r, 0)))
const button = (text: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
/** The provider row with this label. */
const row = (label: string): HTMLElement =>
  [...container.querySelectorAll<HTMLElement>('div.flex')].find(
    (el) => el.firstElementChild?.firstElementChild?.textContent === label,
  )!
async function show(machineId: string): Promise<void> {
  await showHostSettings(root, machineId, 'web-access')
  await settle()
}
const patches = (): unknown[] =>
  invoke.mock.calls.filter(([channel]) => channel === 'hosts:settingsPatch').map((c) => c[2])

it('shows which keys This Mac has, by name, and reveals the raw file only on request', async () => {
  await show('local')
  expect(row('Tavily').textContent).toContain('configured')
  expect(row('Brave Search').textContent).toContain('not configured')
  expect(button('Edit raw JSON…')).toBeDefined()
  expect(container.textContent).not.toContain('tvly-')
})

it('sets and clears a Host key by name through the webAccess.key change', async () => {
  await show(machine.id)
  expect(invoke).not.toHaveBeenCalledWith('pi:webSearchConfig')
  expect(button('Edit raw JSON…')).toBeUndefined()
  expect(row('Brave Search').textContent).toContain('configured')
  await act(async () => row('Brave Search').querySelectorAll('button')[1]!.click())
  await settle()
  await act(async () => row('Tavily').querySelector('button')!.click())
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Tavily key"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'tvly-123',
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => button('Save')!.click())
  await settle()
  expect(patches()).toEqual([
    expect.objectContaining({
      section: 'resources',
      change: { type: 'webAccess.key', key: 'braveApiKey', value: null },
    }),
    expect.objectContaining({
      section: 'resources',
      change: { type: 'webAccess.key', key: 'tavilyApiKey', value: 'tvly-123' },
    }),
  ])
})

it('asks to update a Host whose read does not report its keys', async () => {
  oldHost = true
  await show(machine.id)
  expect(container.textContent).toContain('Update this Host to configure Web access')
  expect(container.textContent).not.toContain('Search providers')
})
