// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useWorkspacesStore } from '@/stores/workspaces'
import { useSettingsUiStore } from './settingsUiStore'
import { useLocalPackages } from './sections/extensions/useLocalPackages'
import { useExtensionTabs } from './sections/extensions/useExtensionTabs'
import { useLocalWebAccess } from './sections/web-access/useLocalWebAccess'
import { useLocalClaudeAccounts } from './sections/claude-provider/useLocalClaudeAccounts'
import { useLocalProviders } from './sections/accounts/useLocalProviders'
import { useLocalFolders } from './sections/folders/useLocalFolders'
import { OptimizationTab } from './tabs/OptimizationTab'

// This Mac's readers make their first read on mount and one more on each
// scope-line Refresh (`reread`); This Mac's Agent is pinned in SettingsScope.test.tsx.

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  })
})
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))

const invoke = vi.fn()
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', {
    invoke,
    platform: 'darwin',
    onAccountChanged: () => () => {},
    onPiLoginState: () => () => {},
    onClaudeLoginState: () => () => {},
  })
  useSettingsUiStore.setState({ folder: null, rereads: 0 })
  invoke.mockReset().mockImplementation(async (channel: string) => {
    if (channel === 'packages:list' || channel === 'pi:subscriptionAuth') return []
    if (channel === 'packages:checkUpdates' || channel === 'claude:accountSessions') return {}
    if (channel === 'packages:detect') return { claude: false }
    return null
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

const calls = (channel: string): number =>
  invoke.mock.calls.filter(([name]) => name === channel).length

async function mountAndRefresh(probe: () => React.JSX.Element): Promise<() => Promise<void>> {
  const Probe = probe
  await act(async () => root.render(<Probe />))
  return async () => {
    await act(async () => useSettingsUiStore.getState().reread())
  }
}

it.each([
  ['useLocalPackages', 'packages:list', () => void useLocalPackages(null, { versions: false })],
  ['useLocalWebAccess', 'pi:webSearchConfig', () => void useLocalWebAccess()],
  ['useLocalClaudeAccounts', 'claude:accounts', () => void useLocalClaudeAccounts()],
  ['useLocalProviders', 'pi:subscriptionAuth', () => void useLocalProviders()],
  ['useExtensionTabs', 'packages:list', () => void useExtensionTabs('local')],
])('%s reads %s on mount and once more per Refresh', async (_name, channel, hook) => {
  const refresh = await mountAndRefresh(() => {
    hook()
    return <div />
  })
  expect(calls(channel)).toBe(1)
  await refresh()
  expect(calls(channel)).toBe(2)
  await refresh()
  expect(calls(channel)).toBe(3)
})

it('OptimizationTab reads headroom:status on mount and once more per Refresh', async () => {
  const refresh = await mountAndRefresh(() => <OptimizationTab />)
  expect(calls('headroom:status')).toBe(1)
  await refresh()
  expect(calls('headroom:status')).toBe(2)
})

it('useLocalFolders reads the sandboxes on mount and once more per Refresh', async () => {
  const refreshSandboxes = vi.fn(async () => undefined)
  useWorkspacesStore.setState({ refreshSandboxes })
  const refresh = await mountAndRefresh(() => {
    useLocalFolders()
    return <div />
  })
  expect(refreshSandboxes).toHaveBeenCalledTimes(1)
  await refresh()
  await refresh()
  expect(refreshSandboxes).toHaveBeenCalledTimes(3)
})
