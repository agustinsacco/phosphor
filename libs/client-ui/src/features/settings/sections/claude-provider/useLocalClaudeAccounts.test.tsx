// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ClaudeAccountsResult } from '@shared/models'
import { useSessionsStore } from '@/stores/sessions'
import { LocalClaudeProvider } from '.'

const ACCOUNTS: ClaudeAccountsResult = {
  prefs: { accounts: [], mode: 'ordered', cursor: 0, cooldowns: {}, bindings: {} },
  views: [
    {
      account: { id: 'a', label: 'Work', credentialDir: null, addedAt: 1 },
      auth: { ok: true, loggedIn: true },
      usage: null,
      cooldownUntil: null,
    },
    {
      account: { id: 'b', label: 'Personal', credentialDir: null, addedAt: 2 },
      auth: { ok: true, loggedIn: true, email: 'me@example.com' },
      usage: null,
      cooldownUntil: null,
    },
  ],
}

const invoke = vi.fn(async (channel: string): Promise<unknown> => {
  switch (channel) {
    case 'packages:list':
      return []
    case 'packages:claudeStatus':
      return { binary: { found: true, path: '/bin/claude', version: '2.1.1' }, auth: { ok: true } }
    case 'claude:accounts':
      return ACCOUNTS
    case 'claude:accountSessions':
      return { a: ['lane'] }
    case 'packages:checkUpdates':
      return {}
    default:
      return null
  }
})

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', {
    invoke,
    platform: 'darwin',
    onClaudeLoginState: () => () => {},
    onPackagesJobOutput: () => () => {},
    onPackagesJobExit: () => () => {},
  })
  useSessionsStore.setState({
    live: { lane: { phosphorId: 'lane', workspacePath: '/work/app', diskPath: '/s.jsonl' } },
  } as never)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useSessionsStore.setState({ live: {} })
  vi.unstubAllGlobals()
})

it("names This Mac's move targets as the composer does, by sign-in email first", async () => {
  await act(async () => root.render(<LocalClaudeProvider />))
  const row = (): HTMLButtonElement | null =>
    document.querySelector('[data-account-id="a"] button[aria-expanded]')
  await vi.waitFor(() => expect(row()?.textContent).toContain('1'))
  await act(async () => row()!.click())
  const moves = [...document.querySelectorAll('button')]
    .map((button) => button.textContent ?? '')
    .filter((text) => text.startsWith('Move to'))
  expect(moves).toEqual(['Move to me@example.com'])
})

const openAccountA = async (): Promise<void> => {
  await act(async () => root.render(<LocalClaudeProvider />))
  const row = (): HTMLButtonElement | null =>
    document.querySelector('[data-account-id="a"] button[aria-expanded]')
  await vi.waitFor(() => expect(row()?.textContent).toContain('1'))
  await act(async () => row()!.click())
}
const buttonNamed = (text: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll('button')].find((button) => button.textContent === text)

it("forces a new reading of This Mac's account usage on Check again", async () => {
  await openAccountA()
  await vi.waitFor(() => expect(buttonNamed('Check again')).toBeDefined())
  invoke.mockClear()
  await act(async () => buttonNamed('Check again')!.click())
  expect(invoke).toHaveBeenCalledWith('claude:usageSnapshot', 'a', true)
})

it("opens a lane from This Mac's account lane list", async () => {
  useSessionsStore.setState({ activeSessionId: null })
  await openAccountA()
  await vi.waitFor(() => expect(buttonNamed('Open lane')).toBeDefined())
  await act(async () => buttonNamed('Open lane')!.click())
  await vi.waitFor(() => expect(useSessionsStore.getState().activeSessionId).toBe('lane'))
})
