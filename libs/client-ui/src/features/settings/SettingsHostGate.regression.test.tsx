// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MachineView } from '@shared/control-api'
import type { HostConnectionView } from '@shared/ipc'
import { SettingsModal } from './SettingsModal'
import { useSettingsUiStore } from './settingsUiStore'
import { useLayoutStore } from '@/stores/layout'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useMachinesStore } from '@/stores/machines'
import { MOCK_HOST_ID, mockRemoteHosts } from '@/dev/mockRemoteLanes'

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

const invoke = vi.fn(async (channel: string): Promise<unknown> =>
  channel === 'packages:list' ? [] : undefined,
)
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  invoke.mockClear()
  const now = Date.now()
  useMachinesStore.setState({
    machines: [
      {
        id: MOCK_HOST_ID,
        label: 'Studio',
        state: 'running',
        lastSeenAt: new Date(now).toISOString(),
        endpoint: 'studio.tailnet.ts.net:7777',
      } as MachineView,
    ],
    nowMs: now,
    clockOffsetMs: 0,
    view: { kind: 'list' },
  })
  useSessionsStore.setState({ activeSessionId: null, live: {} })
  useLayoutStore.setState({ page: null })
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: () => undefined,
  })
  vi.stubGlobal('phosphor', { invoke, platform: 'darwin', onAccountChanged: () => () => {} })
  useSettingsUiStore.setState({ open: true, tab: 'accounts', machine: MOCK_HOST_ID, reveal: null })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function renderHost(connection: Partial<HostConnectionView>): Promise<string> {
  const host = { ...structuredClone(mockRemoteHosts[MOCK_HOST_ID]!), ...connection }
  useRemoteLanesStore.setState({ filter: 'all', hosts: { [MOCK_HOST_ID]: host } })
  await act(async () => root.render(<SettingsModal />))
  return document.body.textContent ?? ''
}
const button = (name: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === name,
  )

it('says a Host is still connecting instead of asking to connect first', async () => {
  const text = await renderHost({ state: 'connecting' })
  expect(text).toContain('Connecting to Studio.')
  expect(text).not.toContain('Connect to Studio first')
  expect(invoke).not.toHaveBeenCalledWith('hosts:settingsRead', expect.anything())
})

it('offers no Reconnect when the machine at the address is not this Host', async () => {
  const text = await renderHost({ state: 'wrong-machine' })
  expect(text).toContain('could not prove it is Studio')
  expect(button('Reconnect')).toBeUndefined()
})

it('shows the last connection error beside Reconnect', async () => {
  const text = await renderHost({ state: 'down', lastError: 'ECONNREFUSED' })
  expect(text).toContain('ECONNREFUSED')
  expect(button('Reconnect')).toBeDefined()
})

it('asks to update a Host whose protocol this client cannot speak', async () => {
  const text = await renderHost({ state: 'unsupported' })
  expect(text).toContain('Update needed')
  expect(text).toContain('phosphor update')
  expect(button('Reconnect')).toBeUndefined()
})
