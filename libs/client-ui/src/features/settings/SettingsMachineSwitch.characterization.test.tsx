// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MachineView } from '@shared/control-api'
import { SettingsModal } from './SettingsModal'
import { useSettingsUiStore, type SettingsTab } from './settingsUiStore'
import { useLayoutStore } from '@/stores/layout'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useMachinesStore } from '@/stores/machines'
import { useFeedbackStore } from '@/features/feedback/feedbackStore'
import { mixedRemoteHosts } from '@/dev/mockRemoteLanes'
import { mockSettingsRead } from '@/dev/mockMachineSettings'

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
vi.mock('./sections/agent', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  LocalAgent: () => <p>Local agent controls</p>,
}))
vi.mock('./tabs/AccountsTab', () => ({ AccountsTab: () => <p>Local account controls</p> }))
vi.mock('./sections/extensions', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  LocalExtensions: () => <p>Local extension controls</p>,
}))
vi.mock('./sections/connectors', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  LocalConnectors: () => <p>Local connector controls</p>,
}))
vi.mock('./sections/advanced', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  LocalAdvanced: () => <p>Local advanced controls</p>,
}))
vi.mock('./tabs/AboutTab', () => ({ AboutTab: () => null }))

const invoke = vi.fn(async (channel: string, ...args: unknown[]): Promise<unknown> => {
  if (channel === 'packages:list') return []
  if (channel === 'hosts:settingsRead')
    return mockSettingsRead(args[0] as string, args[1] as never, args[2] as string | undefined)
  if (channel === 'hosts:models') return []
  return undefined
})
/** The ready Host among the mixed demo Hosts. */
const HOST = '11111111-1111-4111-8111-111111111111'
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: () => undefined,
  })
  invoke.mockClear()
  useRemoteLanesStore.setState({ filter: 'local', hosts: mixedRemoteHosts() })
  useSessionsStore.setState({ activeSessionId: null, live: {} })
  useMachinesStore.setState({
    machines: [{ id: HOST, label: 'Studio' } as MachineView],
    view: { kind: 'list' },
  })
  useLayoutStore.setState({ page: null })
  vi.stubGlobal('phosphor', { invoke, platform: 'darwin', onAccountChanged: () => () => {} })
  useSettingsUiStore.setState({ open: true, tab: 'appearance', machine: null, reveal: null })
  useFeedbackStore.setState({ open: false, state: null })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function configure(machine: string): Promise<void> {
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="Configure"]')
  expect(select).not.toBeNull()
  await act(async () => {
    select!.value = machine
    select!.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
/** The Host section the open panel read, whatever the navigation calls it. */
const hostSectionRead = (): unknown =>
  invoke.mock.calls.filter(([channel]) => channel === 'hosts:settingsRead').at(-1)?.[2]
async function clickSelectedSection(): Promise<void> {
  const selected = document.querySelector<HTMLButtonElement>(
    'nav[aria-label="Settings sections"] button[aria-current="page"]',
  )
  expect(selected).not.toBeNull()
  await act(async () => selected!.click())
}

it.each([
  ['agent', 'agent', 'Local agent controls'],
  ['accounts', 'providers', 'Local account controls'],
  ['extensions', 'resources', 'Local extension controls'],
  ['connectors', 'connectors', 'Local connector controls'],
  ['advanced', 'advanced', 'Local advanced controls'],
] as const)(
  'keeps %s open when switching from This Mac to a Host and back',
  async (tab, hostSection, local) => {
    useSettingsUiStore.setState({ tab: tab as SettingsTab })
    await act(async () => root.render(<SettingsModal />))
    await configure('local')
    expect(document.body.textContent).toContain(local)
    await configure(HOST)
    expect(document.body.textContent).toContain('Configuring Studio')
    expect(hostSectionRead()).toBe(hostSection)
    expect(document.body.textContent).not.toContain(local)
    // Picking the Host's entry for the concern, then This Mac, returns to the same concern.
    await clickSelectedSection()
    expect(hostSectionRead()).toBe(hostSection)
    await configure('local')
    expect(document.body.textContent).toContain('Configuring This Mac')
    expect(document.body.textContent).toContain(local)
  },
)
