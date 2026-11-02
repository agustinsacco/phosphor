// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PiPackageEntry } from '@shared/models'
import { mockSettingsRead } from '@/dev/mockMachineSettings'
import { mixedRemoteHosts } from '@/dev/mockRemoteLanes'
import { promptChoice } from '@/stores/prompt'
import { useLayoutStore } from '@/stores/layout'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { prepareHostSettings, showHostSettings } from './__fixtures__/hostSettingsSurface'
import { useSettingsUiStore } from './settingsUiStore'

vi.mock('@/stores/prompt', () => ({ promptChoice: vi.fn(), promptText: vi.fn() }))
vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  })
})
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))

const machine = { id: '11111111-1111-4111-8111-111111111111', label: 'bee1' }
const entry = (name: string, extra: Partial<PiPackageEntry> = {}): PiPackageEntry => ({
  spec: `npm:${name}`,
  scope: 'global',
  kind: 'npm',
  filtered: false,
  name,
  version: '1.0.0',
  installed: true,
  resources: { extensions: [], skills: [], prompts: [], themes: [] },
  ...extra,
})
const LOCAL_PACKAGES = [
  entry('demo-pack', { resources: { extensions: [], skills: ['lint'], prompts: [], themes: [] } }),
  entry('steady-pack'),
  entry('pi-subagents'),
]
const HOST_PACKAGES = [
  { spec: 'npm:host-pack', name: 'host-pack', version: '1.0.0', installed: true, scope: 'global' },
  { spec: 'npm:lost-pack', name: 'lost-pack', installed: false, scope: 'global' },
]

const invoke = vi.fn()
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', {
    invoke,
    platform: 'darwin',
    onAccountChanged: () => () => {},
    onPackagesJobOutput: () => () => {},
    onPackagesJobExit: () => () => {},
  })
  useRemoteLanesStore.setState({ hosts: mixedRemoteHosts(), filter: 'local' })
  prepareHostSettings(machine)
  invoke.mockReset().mockImplementation(async (channel, hostId, section, repositoryId) => {
    if (channel === 'packages:list') return LOCAL_PACKAGES
    if (channel === 'packages:detect') return { claude: false }
    if (channel === 'packages:checkUpdates') return { 'npm:demo-pack': '2.0.0' }
    if (channel === 'packages:run') return { jobId: 'job-1' }
    // The private terminal is not under test: its start fails after the call.
    if (channel === 'hosts:machineTask') throw new Error('No terminal here')
    if (channel === 'hosts:settingsRead') {
      const read = await mockSettingsRead(hostId, section, repositoryId)
      return section === 'resources'
        ? { ...read, resources: { ...read.resources, packages: HOST_PACKAGES } }
        : read
    }
    return undefined
  })
  vi.mocked(promptChoice).mockReset().mockResolvedValue('run')
  useLayoutStore.setState({ page: null })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const buttons = (text: string): HTMLButtonElement[] =>
  [...container.querySelectorAll('button')].filter((b) => b.textContent?.trim() === text)
/** The first button in the smallest block that shows `title` as its own text. */
function buttonNear(title: string): HTMLButtonElement {
  const label = [...container.querySelectorAll('span, h3, h4, div')].find(
    (el) => el.childElementCount === 0 && el.textContent?.trim() === title,
  )
  let block = label?.parentElement ?? null
  while (block && !block.querySelector('button')) block = block.parentElement
  const found = block?.querySelector('button')
  if (!found) throw new Error(`No button near ${title}`)
  return found
}
const settle = (): Promise<void> => act(async () => new Promise((r) => setTimeout(r, 0)))
const calls = (channel: string): unknown[][] =>
  invoke.mock.calls.filter(([name]) => name === channel).map(([, ...args]) => args)

describe('Extensions on This Mac', () => {
  async function render(): Promise<void> {
    await showHostSettings(root, 'local', 'extensions')
    await settle()
  }

  it('lists each package by name, version and spec, with what it contributes', async () => {
    await render()
    expect(container.textContent).toContain('demo-pack')
    expect(container.textContent).toContain('v1.0.0')
    expect(container.textContent).toContain('npm:steady-pack')
    expect(container.textContent).toContain('lint')
  })

  it('offers Update only where the registry has a newer version, and runs it through pi', async () => {
    await render()
    expect(buttons('Update')).toHaveLength(1)
    await act(async () => buttons('Update')[0]!.click())
    expect(calls('packages:run')).toEqual([['update', 'npm:demo-pack', 'global', undefined]])
  })

  it('installs a package by spec through pi', async () => {
    await render()
    const input = container.querySelector<HTMLInputElement>('input[placeholder^="npm:pkg"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'npm:new-pack',
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => buttons('Install')[0]!.click())
    expect(calls('packages:run')).toEqual([['install', 'npm:new-pack', 'global', undefined]])
  })

  it('updates every package through pi', async () => {
    await render()
    await act(async () => buttons('Update all')[0]!.click())
    expect(calls('packages:run')).toEqual([['update', undefined, 'global', undefined]])
  })

  it('adds a recommended package, and says when the Claude CLI is missing', async () => {
    await render()
    expect(container.textContent).toContain('Needs the `claude` CLI on your PATH')
    await act(async () => buttonNear('Web access').click())
    expect(calls('packages:run')).toEqual([['install', 'npm:pi-web-access', 'global', undefined]])
  })

  it('jumps from a package’s skills to the Skills page and closes Settings', async () => {
    useSettingsUiStore.getState().setOpen(true)
    await render()
    await act(async () => buttons('View in Skills')[0]!.click())
    expect(useSettingsUiStore.getState().open).toBe(false)
    expect(useLayoutStore.getState().page).toBe('skills')
  })
})

describe('Extensions on a Host', () => {
  async function render(): Promise<void> {
    await showHostSettings(root, machine.id, 'extensions')
    await settle()
  }

  it('lists the packages its resources read reports, never This Mac’s', async () => {
    await render()
    expect(calls('hosts:settingsRead')).toContainEqual([machine.id, 'resources', undefined])
    expect(container.textContent).toContain('host-pack')
    expect(container.textContent).toContain('lost-pack')
    expect(invoke.mock.calls.some(([channel]) => String(channel).startsWith('packages:'))).toBe(
      false,
    )
  })

  it.each([
    ['Update', 'package.update', 'npm:host-pack'],
    ['Repair installation', 'package.install', 'npm:lost-pack'],
    ['Remove', 'package.remove', 'npm:host-pack'],
  ])('runs %s as a reviewed Host task', async (label, task, name) => {
    await render()
    await act(async () => buttons(label)[0]!.click())
    await settle()
    expect(promptChoice).toHaveBeenCalledOnce()
    expect(calls('hosts:machineTask')).toEqual([[machine.id, { type: 'machine.task', task, name }]])
  })
})
