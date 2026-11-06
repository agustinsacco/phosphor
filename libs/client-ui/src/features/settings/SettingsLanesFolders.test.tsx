// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_LANE_PREFS } from '@shared/models'
import { COMPACT_PLATFORM, PlatformProvider, type Platform } from '@/platform/Platform'
import { promptChoice } from '@/stores/prompt'
import { useLanePrefsStore } from '@/stores/lanePrefs'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useWorkspacesStore } from '@/stores/workspaces'
import { useWorktreesStore } from '@/stores/worktrees'
import { HOST_SETTINGS_PLATFORM } from './__fixtures__/hostSettingsSurface'
import { SettingsSurface } from './SettingsSurface'
import { useSettingsUiStore, type SettingsTab } from './settingsUiStore'

vi.mock('@/lib/monaco', () => ({}))
vi.mock('@/stores/prompt', () => ({
  promptChoice: vi.fn(async () => undefined),
  promptText: vi.fn(),
}))
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

const recent = { path: '/src/api', name: 'api', lastOpenedAt: 1 }
const sandbox = { path: '/data/sandboxes/calm-otter', name: 'calm-otter', itemCount: 0 }
const invoke = vi.fn(async (channel: string): Promise<unknown> => {
  if (channel === 'app:listSandboxes') return [{ ...sandbox, lastUsedAt: Date.now() }]
  if (channel === 'app:selectFolder') return '/src/web'
  return undefined
})
let root: Root, container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke, platform: 'darwin' })
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: () => undefined,
  })
  invoke.mockClear()
  vi.mocked(promptChoice).mockReset().mockResolvedValue(undefined)
  useRemoteLanesStore.setState({ filter: 'local', hosts: {} })
  useWorkspacesStore.setState({
    homePath: null,
    recents: [recent, { ...sandbox, lastOpenedAt: 2 }],
  })
  useLanePrefsStore.setState({ lanes: DEFAULT_LANE_PREFS })
  useWorktreesStore.setState({ preferWorktree: true, branchPrefix: 'phosphor/' })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function show(tab: SettingsTab, platform: Platform, machine: string | null): Promise<void> {
  useSettingsUiStore.setState({ tab, machine, query: '', listing: false, reveal: null })
  await act(async () =>
    root.render(
      <PlatformProvider value={platform}>
        <SettingsSurface />
      </PlatformProvider>,
    ),
  )
}
function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  )
  if (!found) throw new Error(`Missing ${text}`)
  return found
}
const rowTitles = (): string[] =>
  [...container.querySelectorAll('[data-setting-row] .text-lg')].map((n) => n.textContent ?? '')

it("lists This Mac's folders apart from its sandboxes, and adds one with the native picker", async () => {
  await show('folders', HOST_SETTINGS_PLATFORM, 'local')
  expect(container.textContent).toContain('/src/api')
  expect(container.textContent).toContain('Sandboxes')
  expect(
    [...container.querySelectorAll('button')].filter((b) => b.textContent === 'Remove'),
  ).toHaveLength(1)
  expect(container.textContent).not.toContain('Reset layout')
  expect(container.textContent).not.toContain('Review project trust')
  await act(async () => button('Add folder').click())
  expect(invoke).toHaveBeenCalledWith('app:selectFolder')
  expect(useWorkspacesStore.getState().recents.map((w) => w.path)).toContain('/src/web')
})

it('forgets a folder on This Mac only after asking', async () => {
  await show('folders', HOST_SETTINGS_PLATFORM, 'local')
  await act(async () => button('Remove').click())
  expect(vi.mocked(promptChoice).mock.calls[0]?.[0].title).toBe('Remove api from This Mac?')
  expect(invoke).not.toHaveBeenCalledWith('app:setRecentWorkspaces', expect.anything())
  vi.mocked(promptChoice).mockResolvedValue('remove')
  await act(async () => button('Remove').click())
  expect(useWorkspacesStore.getState().recents.map((w) => w.path)).not.toContain('/src/api')
  expect(invoke).toHaveBeenCalledWith('app:setRecentWorkspaces', expect.any(Array))
})

it('shows Lanes in the browser, without the switch only This Mac’s lanes have', async () => {
  await show('lanes', COMPACT_PLATFORM, null)
  expect(rowTitles()).toEqual([
    'Lane markers',
    'PR status on lanes',
    'Branch prefix',
    'Branch name length',
  ])
  const off = [...container.querySelectorAll<HTMLButtonElement>('[role=radio]')].find(
    (radio) => radio.textContent === 'Off',
  )
  await act(async () => off?.click())
  expect(invoke).toHaveBeenCalledWith(
    'app:setLanePrefs',
    expect.objectContaining({ markers: 'off' }),
  )
})

it("offers This Mac's worktree switch on Desktop, whichever machine is chosen", async () => {
  await show('lanes', HOST_SETTINGS_PLATFORM, 'local')
  expect(rowTitles()).toContain('Give each chat its own branch')
})
