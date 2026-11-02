// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ClaudeAccountsResult } from '@shared/models'
import { mixedRemoteHosts } from '@/dev/mockRemoteLanes'
import { mockSettingsPatch, mockSettingsRead } from '@/dev/mockMachineSettings'
import { promptChoice } from '@/stores/prompt'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { prepareHostSettings, showHostSettings } from './__fixtures__/hostSettingsSurface'

/*
 * Claude Code is listed under Extensions on every machine, installed or not
 * (decision 6), and removing an account asks first and shows the machine's
 * refusal (C4).
 */

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  })
})
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('@/stores/prompt', () => ({ promptChoice: vi.fn(async () => undefined) }))

const HOST = { id: '11111111-1111-4111-8111-111111111111', label: 'bee1' }
const REFUSAL = 'Stop or move this account’s live sessions before removing it.'

const ACCOUNTS: ClaudeAccountsResult = {
  prefs: { accounts: [], mode: 'ordered', cursor: 0, cooldowns: {}, bindings: {} },
  views: [
    {
      account: { id: 'a', label: 'alpha@example.com', credentialDir: null, addedAt: 1 },
      auth: { ok: true, loggedIn: true },
      usage: null,
      cooldownUntil: null,
    },
  ],
}

const invoke = vi.fn(async (channel: string, ...args: unknown[]): Promise<unknown> => {
  switch (channel) {
    case 'packages:list':
      return []
    case 'packages:claudeStatus':
      return { binary: { found: true, path: '/bin/claude', version: '2.1.1' }, auth: { ok: true } }
    case 'claude:accounts':
      return ACCOUNTS
    case 'claude:accountSessions':
    case 'packages:checkUpdates':
      return {}
    case 'claude:removeAccount':
      throw new Error(REFUSAL)
    case 'hosts:settingsRead':
      return mockSettingsRead(args[0] as string, args[1] as never, args[2] as string | undefined)
    case 'hosts:settingsPatch':
      return mockSettingsPatch(args[0] as string, args[1] as never)
    default:
      return null
  }
})

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  invoke.mockClear()
  vi.mocked(promptChoice).mockReset().mockResolvedValue(undefined)
  useRemoteLanesStore.setState({ hosts: mixedRemoteHosts() })
  useSessionsStore.setState({ live: {} })
  prepareHostSettings(HOST)
  vi.stubGlobal('phosphor', {
    invoke,
    platform: 'darwin',
    onAccountChanged: () => () => {},
    onClaudeLoginState: () => () => {},
    onPackagesJobOutput: () => () => {},
    onPackagesJobExit: () => () => {},
    onPtyExit: () => () => {},
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

const nav = (): string[] =>
  [...document.querySelectorAll('nav[aria-label="Settings sections"] button')].map(
    (b) => b.textContent ?? '',
  )
const button = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)
  if (!found) throw new Error(`Missing ${name}`)
  return found
}

it('lists Claude Code on This Mac without pi-claude-cli, and offers Install', async () => {
  await showHostSettings(root, 'local', 'claude-provider')
  await vi.waitFor(() => expect(document.body.textContent).toContain('alpha@example.com'))
  expect(nav()).toContain('Claude Code')
  await act(async () => button('Install provider').click())
  expect(invoke).toHaveBeenCalledWith(
    'packages:run',
    'install',
    'npm:@saccolabs/pi-claude-cli',
    'global',
    undefined,
  )
})

it('lists Claude Code on a Host and installs through a reviewed Host task', async () => {
  await showHostSettings(root, HOST.id, 'claude-provider')
  await vi.waitFor(() => expect(document.body.textContent).toContain('work@bee1.example'))
  expect(nav()).toContain('Claude Code')
  expect(invoke).toHaveBeenCalledWith('hosts:settingsRead', HOST.id, 'providers', undefined)
  // Versions and the end-to-end test wait for a Host contract.
  expect(document.body.textContent).not.toContain('Test provider')
})

it('asks before removing an account and shows the refusal for live sessions (C4)', async () => {
  await showHostSettings(root, 'local', 'claude-provider')
  await vi.waitFor(() => expect(document.body.textContent).toContain('alpha@example.com'))
  await act(async () => button('Remove').click())
  expect(promptChoice).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'Remove alpha@example.com?' }),
  )
  expect(invoke).not.toHaveBeenCalledWith('claude:removeAccount', 'a')
  vi.mocked(promptChoice).mockResolvedValue('remove')
  await act(async () => button('Remove').click())
  expect(invoke).toHaveBeenCalledWith('claude:removeAccount', 'a')
  await vi.waitFor(() => expect(document.body.textContent).toContain(REFUSAL))
})
