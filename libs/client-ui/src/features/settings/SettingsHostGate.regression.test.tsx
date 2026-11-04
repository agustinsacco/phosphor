// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MachineView } from '@shared/control-api'
import type { HostConnectionView } from '@shared/ipc'
import { SettingsModal } from './SettingsModal'
import { useSettingsUiStore } from './settingsUiStore'
import { useLayoutStore } from '@/stores/layout'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useMachinesStore } from '@/stores/machines'
import { MOCK_HOST_ID, mockRemoteHosts } from '@/dev/mockRemoteLanes'
import { promptChoice } from '@/stores/prompt'

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
vi.mock('@/stores/prompt', () => ({
  promptChoice: vi.fn(async () => undefined),
  promptText: vi.fn(),
}))

const invoke = vi.fn(async (channel: string): Promise<unknown> =>
  channel === 'packages:list'
    ? []
    : channel === 'hosts:snapshot'
      ? useRemoteLanesStore.getState().hosts
      : undefined,
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

describe('Folders on a Host (B2)', () => {
  beforeEach(() => {
    vi.mocked(promptChoice).mockClear()
    useSettingsUiStore.setState({ tab: 'folders' })
  })

  it('lists the folders once the link is ready, without configuration access or a settings read', async () => {
    const text = await renderHost({})
    expect(text).toContain('Demo repository')
    expect(text).toContain('/remote/demo')
    expect(text).not.toContain('Configuration access is not enabled')
    expect(text).not.toContain('Update this Host to use machine settings')
    expect(invoke).not.toHaveBeenCalledWith('hosts:settingsRead', MOCK_HOST_ID, 'advanced')
  })

  it('asks for configuration access only to review project trust', async () => {
    await renderHost({
      configurationSupported: true,
      capabilities: ['sessions.read', 'sessions.control', 'terminal', 'workspaces.write'],
    })
    await act(async () => button('Review project trust')?.click())
    expect(vi.mocked(promptChoice).mock.calls[0]?.[0].title).toBe(
      'Enable settings access for Studio?',
    )
  })

  it('reads the folders again on Refresh', async () => {
    await renderHost({})
    await act(async () => button('Refresh')?.click())
    expect(invoke).toHaveBeenCalledWith('hosts:snapshot')
  })
})
