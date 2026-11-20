// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubscriptionProviderStatus } from '@shared/models'
import { mixedRemoteHosts } from '@/dev/mockRemoteLanes'
import { mockSettingsRead } from '@/dev/mockMachineSettings'
import { promptChoice } from '@/stores/prompt'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { prepareHostSettings, showHostSettings } from './__fixtures__/hostSettingsSurface'

/* Signing pi out of a provider, on This Mac and on a Host. */

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  })
})
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('@/features/terminal/TerminalView', () => ({
  TerminalView: ({ ptyId }: { ptyId: string }) => <p>terminal {ptyId}</p>,
}))
vi.mock('@/stores/prompt', () => ({ promptChoice: vi.fn(async () => undefined) }))

const HOST = { id: '11111111-1111-4111-8111-111111111111', label: 'bee1' }

let providers: SubscriptionProviderStatus[] = []
let logout: (id: string) => Promise<void> = async () => {}

const invoke = vi.fn(async (channel: string, ...args: unknown[]): Promise<unknown> => {
  switch (channel) {
    case 'pi:subscriptionAuth':
      return providers
    case 'pi:logout':
      return logout(args[0] as string)
    case 'hosts:settingsRead':
      return mockSettingsRead(args[0] as string, args[1] as never, args[2] as string | undefined)
    case 'hosts:machineTask':
      return { ptyId: 'pty-task' }
    default:
      return undefined
  }
})

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  invoke.mockClear()
  vi.mocked(promptChoice).mockReset()
  providers = [
    {
      id: 'openai-codex',
      name: 'ChatGPT (Codex)',
      requires: 'ChatGPT Plus or Pro',
      billing: 'subscription',
      status: 'ready',
      account: 'me@example.com',
    },
    { id: 'xai', name: 'xAI', requires: 'an xAI account', billing: 'balance', status: 'not_ready' },
  ]
  logout = async (id) => {
    providers = providers.map((p) => (p.id === id ? { ...p, status: 'not_ready' } : p))
  }
  useRemoteLanesStore.setState({ hosts: mixedRemoteHosts() })
  useSessionsStore.setState({ live: {} })
  prepareHostSettings(HOST)
  vi.stubGlobal('phosphor', {
    invoke,
    platform: 'darwin',
    onAccountChanged: () => () => {},
    onPiLoginState: () => () => {},
    onPtyExit: () => () => {},
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

const text = (): string => document.body.textContent ?? ''
const rowButtons = (id: string, name: string): HTMLButtonElement[] =>
  [...document.querySelectorAll(`[data-provider="${id}"] button`)].filter(
    (b): b is HTMLButtonElement => b.textContent === name,
  )
const calls = (channel: string): unknown[][] =>
  invoke.mock.calls.filter(([name]) => name === channel).map(([, ...args]) => args)

describe('This Mac › Accounts › Sign out', () => {
  const open = async (): Promise<void> => {
    await showHostSettings(root, 'local', 'accounts')
    await vi.waitFor(() => expect(text()).toContain('ChatGPT (Codex)'))
  }

  it('offers Sign out only on a signed-in provider, and asks first', async () => {
    await open()
    expect(rowButtons('openai-codex', 'Sign out')).toHaveLength(1)
    expect(rowButtons('xai', 'Sign out')).toHaveLength(0)
    await act(async () => rowButtons('openai-codex', 'Sign out')[0]!.click())
    expect(promptChoice).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Sign out of ChatGPT (Codex)?' }),
    )
    expect(calls('pi:logout')).toEqual([])
  })

  it('signs out once confirmed and the row reads Not signed in', async () => {
    await open()
    vi.mocked(promptChoice).mockResolvedValue('sign-out')
    await act(async () => rowButtons('openai-codex', 'Sign out')[0]!.click())
    expect(calls('pi:logout')).toEqual([['openai-codex']])
    await vi.waitFor(() => expect(rowButtons('openai-codex', 'Sign in')).toHaveLength(1))
    expect(rowButtons('openai-codex', 'Sign out')).toHaveLength(0)
    expect(text()).not.toContain('me@example.com')
  })

  it('shows why when a key outside the stored sign-in keeps the provider ready', async () => {
    logout = async () => {
      throw new Error('pi still finds a key for ChatGPT (Codex) in an environment variable')
    }
    await open()
    vi.mocked(promptChoice).mockResolvedValue('sign-out')
    await act(async () => rowButtons('openai-codex', 'Sign out')[0]!.click())
    await vi.waitFor(() => expect(text()).toContain('pi still finds a key for ChatGPT (Codex)'))
    expect(calls('pi:subscriptionAuth').length).toBeGreaterThan(1)
  })
})

describe('A Host › Accounts › Sign out', () => {
  it('runs pi auth logout as a reviewed task on the Host', async () => {
    await showHostSettings(root, HOST.id, 'accounts')
    // The Host's sample signs in Claude Pro/Max only.
    await vi.waitFor(() =>
      expect(document.querySelector('[data-provider="anthropic"]')).not.toBeNull(),
    )
    expect(rowButtons('openai-codex', 'Sign out')).toHaveLength(0)
    const signOut = rowButtons('anthropic', 'Sign out')[0]
    if (!signOut) throw new Error('no Sign out on a signed-in Host provider')
    vi.mocked(promptChoice).mockResolvedValue('run')
    await act(async () => signOut.click())
    expect(promptChoice).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('pi auth logout anthropic') }),
    )
    await vi.waitFor(() =>
      expect(calls('hosts:machineTask')).toEqual([
        [HOST.id, { type: 'machine.task', task: 'provider.logout', name: 'anthropic' }],
      ]),
    )
    expect(invoke.mock.calls.every(([channel]) => channel.startsWith('hosts:'))).toBe(true)
  })
})
