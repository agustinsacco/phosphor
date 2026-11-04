// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CommandPalette, usePaletteStore } from './CommandPalette'
import { useSessionsStore } from '@/stores/sessions'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useLayoutStore } from '@/stores/layout'
import { useMachinePagesStore } from '@/stores/machinePages'
import { useRemoteComposer } from '@/features/home/remoteComposer'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import type { HostCapability } from '@shared/remote-host'

/** The palette on a Host offers what it offers on This Mac, for that Host. */

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {} }),
  })
})
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('@/features/files/MonacoEditor', () => ({ releaseFileModel: vi.fn() }))

let root: Root
let el: HTMLDivElement
let invoke: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  invoke = vi.fn(async () => ({ path: '', entries: [] }))
  vi.stubGlobal('phosphor', { invoke })
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})

afterEach(() => {
  act(() => root.unmount())
  el.remove()
  document.body.innerHTML = ''
  usePaletteStore.setState({ open: false })
  useRemoteLanesStore.setState({ hosts: {}, filter: 'local' })
  useLayoutStore.getState().setPage(null)
  vi.unstubAllGlobals()
})

async function openOnHost(capabilities: HostCapability[] = []): Promise<void> {
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  host.capabilities.push(...capabilities)
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host }, filter: MOCK_HOST_ID })
  useSessionsStore.setState({ activeSessionId: null, live: {} })
  usePaletteStore.setState({ open: true })
  await act(async () => root.render(<CommandPalette workspacePath="/mac" />))
}

async function run(label: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('input[placeholder="Type a command…"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, label)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const row = [...document.querySelectorAll<HTMLElement>('button, [role="menuitem"]')].find((r) =>
    r.textContent?.includes(label),
  )
  expect(row?.textContent ?? '').toContain(label)
  await act(async () => row!.click())
}

it.each([
  ['Open skills page', 'skills'],
  ['Open artifacts page', 'artifacts'],
] as const)('%s opens that page for the Host', async (label, page) => {
  await openOnHost()
  await run(label)
  expect(useLayoutStore.getState().page).toBe(page)
  const pages = useMachinePagesStore.getState()
  expect(page === 'skills' ? pages.skillsMachine : pages.artifactsMachine).toBe(MOCK_HOST_ID)
})

it("starts a new lane in one of the Host's repositories", async () => {
  await openOnHost()
  const repository = mockRemoteHosts[MOCK_HOST_ID]!.repositories[0]!
  await run(`New lane in ${repository.name}`)
  expect(useRemoteComposer.getState().target).toEqual({
    hostId: MOCK_HOST_ID,
    repositoryId: repository.id,
  })
})

it('adds a folder on a Host that lets this device add one', async () => {
  await openOnHost(['workspaces.write'])
  await run(`Add folder on ${MOCK_HOST_ID}…`)
  expect(document.body.textContent).toContain(
    "Choose a folder under this machine's home directory.",
  )
})

it.each([
  ['Open skills page', 'skills'],
  ['Open artifacts page', 'artifacts'],
] as const)('%s from a This Mac lane drops the Host an earlier run chose', async (label, page) => {
  await openOnHost()
  await run(label)
  useSessionsStore.setState({
    activeSessionId: 'mac',
    live: { mac: { phosphorId: 'mac', sessionId: 'mac', workspacePath: '/mac' } } as never,
  })
  usePaletteStore.setState({ open: true })
  await act(async () => root.render(<CommandPalette workspacePath="/mac" />))
  await run(label)
  expect(useLayoutStore.getState().page).toBe(page)
  const pages = useMachinePagesStore.getState()
  expect(page === 'skills' ? pages.skillsMachine : pages.artifactsMachine).toBeFalsy()
})
