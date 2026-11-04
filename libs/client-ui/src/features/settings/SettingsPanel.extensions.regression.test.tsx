// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PiPackageEntry } from '@shared/models'
import { mockSettingsRead } from '@/dev/mockMachineSettings'
import { mixedRemoteHosts } from '@/dev/mockRemoteLanes'
import { useMachinePagesStore } from '@/stores/machinePages'
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
const FOLDER = '0000000000000001'
const entry = (name: string, extra: Partial<PiPackageEntry> = {}): PiPackageEntry => ({
  spec: `npm:${name}`,
  scope: 'global',
  kind: 'npm',
  filtered: false,
  name,
  version: '1.0.0',
  installed: true,
  resources: { extensions: [], skills: ['lint'], prompts: [], themes: [] },
  ...extra,
})
const counts = { extensions: 1, skills: 2, prompts: 0, themes: 0 }
const HOST_PACKAGES = [
  { spec: 'npm:pi-web-access', name: 'pi-web-access', installed: true, scope: 'global' },
  { spec: 'npm:pi-subagents', name: 'pi-subagents', installed: true, scope: 'global' },
  {
    spec: 'npm:@injaneity/pi-computer-use',
    name: '@injaneity/pi-computer-use',
    installed: false,
    scope: 'global',
  },
  {
    spec: 'npm:skill-pack',
    name: 'skill-pack',
    installed: true,
    scope: 'global',
    contents: counts,
  },
]

let localPackages: PiPackageEntry[] = []
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
  localPackages = [entry('demo-pack')]
  invoke.mockReset().mockImplementation(async (channel, hostId, section, repositoryId) => {
    if (channel === 'packages:list') return localPackages
    if (channel === 'packages:detect') return { claude: true }
    if (channel === 'packages:checkUpdates') return {}
    if (channel === 'packages:run') return { jobId: 'job-1' }
    if (channel === 'hosts:settingsRead') {
      const read = await mockSettingsRead(hostId, section, repositoryId)
      return section === 'resources'
        ? { ...read, resources: { ...read.resources, packages: HOST_PACKAGES } }
        : read
    }
    return undefined
  })
  vi.mocked(promptChoice).mockReset().mockResolvedValue(undefined)
  useLayoutStore.setState({ page: null })
  useMachinePagesStore.setState({ skillsMachine: null })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const buttons = (text: string | RegExp): HTMLButtonElement[] =>
  [...container.querySelectorAll('button')].filter((b) =>
    typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent ?? ''),
  )
const settle = (): Promise<void> => act(async () => new Promise((r) => setTimeout(r, 0)))
const calls = (channel: string): unknown[][] =>
  invoke.mock.calls.filter(([name]) => name === channel).map(([, ...args]) => args)
const nested = (): string[] =>
  [...container.querySelectorAll('nav[aria-label="Settings sections"] button[data-nested]')].map(
    (b) => b.textContent ?? '',
  )
async function show(machineId: string, tab: Parameters<typeof showHostSettings>[2]) {
  await showHostSettings(root, machineId, tab)
  await settle()
}

it('test(E3): a Host lists the nested items of the packages it has installed', async () => {
  await show(machine.id, 'extensions')
  // Claude Code is listed on every machine (`always`); the others follow the Host's packages.
  expect(nested()).toEqual(['Claude Code', 'Web access', 'Subagents'])
  await act(async () => buttons('Web access')[0]!.click())
  await settle()
  expect(container.textContent).toContain('Search providers')
  expect(calls('pi:webSearchConfig')).toEqual([])
})

it('test(E4): This Mac’s "View in Skills" opens This Mac’s Skills, whatever was viewed before', async () => {
  useMachinePagesStore.setState({ skillsMachine: machine.id })
  await show('local', 'extensions')
  await act(async () => buttons('View in Skills')[0]!.click())
  expect(useMachinePagesStore.getState().skillsMachine).toBe('local')
})

it('test(E4): a Host’s Skills link closes Settings and opens that Host’s Skills', async () => {
  useSettingsUiStore.getState().setOpen(true)
  await show(machine.id, 'extensions')
  expect(buttons(/^(View in Skills|Open skills)/i).length).toBeGreaterThan(0)
  await act(async () => buttons(/^(View in Skills|Open skills)/i)[0]!.click())
  expect(useSettingsUiStore.getState().open).toBe(false)
  expect(useMachinePagesStore.getState().skillsMachine).toBe(machine.id)
  expect(useLayoutStore.getState().page).toBe('skills')
})

it('test(E5): a recommended package declared but missing on This Mac offers a repair, not "Added"', async () => {
  localPackages = [entry('pi-web-access', { installed: false })]
  await show('local', 'extensions')
  expect(buttons('Added')).toEqual([])
  expect(container.textContent).not.toContain('Added')
  await act(async () => buttons('Repair')[0]?.click())
  expect(calls('packages:run')).toEqual([['install', 'npm:pi-web-access', 'global', undefined]])
})

it('test(E6): a Host’s Extensions read follows the folder scope', async () => {
  useSettingsUiStore.setState({ folder: FOLDER })
  await show(machine.id, 'extensions')
  expect(calls('hosts:settingsRead')).toContainEqual([machine.id, 'resources', FOLDER])
})

it('test(E7): This Mac asks before it removes a package', async () => {
  await show('local', 'extensions')
  await act(async () => buttons('Remove')[0]!.click())
  expect(promptChoice).toHaveBeenCalledOnce()
  expect(calls('packages:run')).toEqual([])
})

it("warns on a Host's Recommended card when its claude CLI is missing, as This Mac's does", async () => {
  const read = invoke.getMockImplementation()!
  invoke.mockImplementation(async (channel: string, ...args: unknown[]) =>
    channel === 'hosts:claude'
      ? { provider: 'missing', cli: 'missing', auth: 'unknown' }
      : read(channel, ...args),
  )
  await show(machine.id, 'extensions')
  expect(container.textContent).toContain('Needs the `claude` CLI on your PATH')
})
