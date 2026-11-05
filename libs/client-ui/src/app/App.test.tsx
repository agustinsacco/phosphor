// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { App } from './App'
import { useGlobalShortcuts } from './useGlobalShortcuts'
import { useSessionsStore } from '@/stores/sessions'
import { useLayoutStore } from '@/stores/layout'
import { useWorkspacesStore } from '@/stores/workspaces'
import { useWorktreesStore } from '@/stores/worktrees'
import { useDraftsStore } from '@/stores/drafts'
import { useModelCatalogueStore } from '@/stores/modelCatalogue'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { mockRemoteInfo } from '@/dev/mockRemoteLanes'
vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {} }),
  })
})
vi.mock('./useGlobalShortcuts', async (original) => {
  const actual = await original<{ useGlobalShortcuts: typeof useGlobalShortcuts }>()
  return { useGlobalShortcuts: vi.fn(actual.useGlobalShortcuts) }
})
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('@/features/files/MonacoEditor', () => ({ releaseFileModel: vi.fn() }))
vi.mock('@/stores/remoteLanes', async (original) => ({
  ...(await original<object>()),
  attachRemoteLanesListener: () => () => {},
}))
vi.mock('@/stores/machines', async (original) => ({
  ...(await original<object>()),
  attachMachinesListener: () => () => {},
}))
vi.mock('@/stores/connectors', () => ({ attachConnectorAuthListener: () => () => {} }))
vi.mock('@/features/connectors/migrationNotice', () => ({ noticeMcpMigration: async () => {} }))
vi.mock('@/stores/sessions', async (original) => ({
  ...(await original<object>()),
  attachPiCommandsListener: () => () => {},
}))
vi.mock('./TopBar', () => ({
  TopBar: ({ machineFiles }: { machineFiles: { toggle: () => void } }) => (
    <button onClick={machineFiles.toggle}>Home Files</button>
  ),
}))
vi.mock('@/features/chat/ChatView', () => ({ ChatView: () => null }))
vi.mock('@/features/files/FuzzyFinder', () => ({ FuzzyFinder: () => <div>Finder mounted</div> }))
vi.mock('@/features/palette/CommandPalette', () => ({
  CommandPalette: () => <div>Palette mounted</div>,
}))
vi.mock('@/features/files/RightPane', () => ({ RightPane: () => null }))
vi.mock('@/features/files/MachineFilesPane', () => ({
  MachineFilesPane: ({ hostId }: { hostId: string }) => (
    <div>
      Host repositories {hostId}
      <select aria-label="Repository">
        <option>Host repo</option>
      </select>
    </div>
  ),
}))
vi.mock('@/features/sessions/Sidebar', () => ({ Sidebar: () => null }))
vi.mock('@/features/sessions/BulkDeleteModal', () => ({ BulkDeleteProgressPopover: () => null }))
vi.mock('@/features/skills/SkillsPage', () => ({ SkillsPage: () => null }))
vi.mock('@/features/routines/RoutinesPage', () => ({ RoutinesPage: () => null }))
vi.mock('@/features/artifacts/ArtifactsPage', () => ({ ArtifactsPage: () => null }))
vi.mock('@/features/machines/MachinesPage', () => ({ MachinesPage: () => null }))
vi.mock('@/features/home/WorkspaceHome', () => ({
  WorkspaceHome: ({ localSetup }: { localSetup?: React.ReactNode }) =>
    localSetup ?? <textarea data-composer-input />,
}))
vi.mock('@/features/home/StartingChat', () => ({ StartingChat: () => null }))
vi.mock('@/features/settings/SettingsModal', () => ({ SettingsModal: () => null }))
vi.mock('@/features/feedback/FeedbackModal', () => ({ FeedbackModal: () => null }))
vi.mock('@/features/extension-ui/ExtensionUiHosts', () => ({
  ExtensionDialogHost: () => null,
  ToastHost: () => null,
}))
vi.mock('@/features/writing/TextFieldMenu', () => ({ TextFieldMenu: () => null }))
vi.mock('@/components/ContextMenu', () => ({ ContextMenuHost: () => null }))
vi.mock('@/components/PromptHost', () => ({ PromptHost: () => null }))
vi.mock('./GettingStartedScreen', () => ({
  GettingStartedScreen: ({ onDone }: { onDone: () => void }) => (
    <button onClick={onDone}>Recommendations done</button>
  ),
}))

function stubApi(health: { ok: boolean; reason?: string; message?: string; version?: string }) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.assign(window, {
    phosphor: {
      invoke: vi.fn(async (channel: string) =>
        channel === 'pi:health'
          ? health
          : channel === 'pi:listLiveSessions'
            ? []
            : { kind: 'none' },
      ),
      onPtyStatus: () => () => {},
    },
  })
  vi.spyOn(useWorkspacesStore.getState(), 'hydrate').mockResolvedValue()
  vi.spyOn(useWorktreesStore.getState(), 'hydratePrefs').mockResolvedValue()
  vi.spyOn(useDraftsStore.getState(), 'hydrate').mockResolvedValue()
  vi.spyOn(useModelCatalogueStore.getState(), 'hydrate').mockResolvedValue()
  useSessionsStore.setState({ activeSessionId: null, live: {} })
  useLayoutStore.setState({ sidebarVisible: false })
}

it.each([
  [
    'pi is missing',
    { ok: false, reason: 'missing', message: 'pi was not found.' },
    '/mac',
    'pi is not installed',
  ],
  ['no folder is open', { ok: true, version: '1.2.0' }, null, 'Open Folder…'],
])(
  'mounts the shell when %s, with This Mac’s setup in its home',
  async (_case, health, homePath, setup) => {
    stubApi(health)
    useWorkspacesStore.setState({ homePath })
    const container = document.createElement('div'),
      root = createRoot(container)
    document.body.append(container)
    try {
      await act(async () => root.render(<App />))
      const shell = container.querySelector('[data-testid="app-shell"]')
      expect(shell).not.toBeNull()
      expect(shell?.textContent).toContain(setup)
      expect(shell?.hasAttribute('inert')).toBe(false)
      expect(container.textContent).toContain('Palette mounted')
      expect(useGlobalShortcuts).toHaveBeenLastCalledWith(true)
    } finally {
      act(() => root.unmount())
      container.remove()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    }
  },
)

it.each([true, false])(
  'mounts target-correct global surfaces (lane active: %s)',
  async (laneActive) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    Object.assign(window, {
      phosphor: {
        invoke: vi.fn(async (channel: string) =>
          channel === 'pi:health'
            ? { ok: true, version: '1.2.0' }
            : channel === 'pi:listLiveSessions'
              ? []
              : { kind: 'none' },
        ),
        onPtyStatus: () => () => {},
      },
    })
    vi.spyOn(useWorkspacesStore.getState(), 'hydrate').mockResolvedValue()
    vi.spyOn(useWorktreesStore.getState(), 'hydratePrefs').mockResolvedValue()
    vi.spyOn(useDraftsStore.getState(), 'hydrate').mockResolvedValue()
    vi.spyOn(useModelCatalogueStore.getState(), 'hydrate').mockResolvedValue()
    const id = mockRemoteInfo.sessionId
    useSessionsStore.setState({
      activeSessionId: laneActive ? id : null,
      live: { [id]: { ...mockRemoteInfo, phosphorId: id } },
    })
    useWorkspacesStore.setState({ homePath: '/mac' })
    useRemoteLanesStore.setState({ filter: 'bee1-home' })
    useLayoutStore.setState({ sidebarVisible: false })
    const container = document.createElement('div'),
      root = createRoot(container)
    document.body.append(container)
    try {
      await act(async () => root.render(<App />))
      expect(container.textContent).toContain('Finder mounted')
      expect(container.textContent).toContain('Palette mounted')
      expect(useGlobalShortcuts).toHaveBeenLastCalledWith(true)
      if (!laneActive) {
        await act(async () => container.querySelector('button')?.click())
        expect(container.textContent).toContain('Host repositories bee1-home')
        expect(container.querySelector('[data-testid="right-pane"]')?.textContent).toContain(
          'Host repositories bee1-home',
        )
        const composer = container.querySelector('textarea')!
        composer.focus()
        act(() =>
          composer.dispatchEvent(new KeyboardEvent('keydown', { code: 'F6', bubbles: true })),
        )
        expect(document.activeElement).toBe(container.querySelector('select'))
        await act(async () => useRemoteLanesStore.setState({ filter: 'local' }))
        expect(container.textContent).not.toContain('Host repositories')
      }
    } finally {
      act(() => root.unmount())
      container.remove()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    }
  },
)

/** pi missing at launch, with a one-click install whose exit the test sends. */
function stubInstall(resumeTarget: object = { kind: 'none' }) {
  stubApi({ ok: false })
  let health: object = { ok: false, reason: 'too-old', message: 'pi is too old.', version: '0.1.0' }
  const job: { exit?: (code: number) => void } = {}
  const invoke = vi.fn(async (channel: string) =>
    channel === 'pi:health'
      ? health
      : channel === 'packages:installPi'
        ? { jobId: 'install' }
        : channel === 'pi:listLiveSessions'
          ? []
          : resumeTarget,
  )
  Object.assign(window.phosphor, {
    invoke,
    onPackagesJobOutput: () => () => {},
    onPackagesJobExit: (_id: string, onExit: (code: number) => void) => {
      job.exit = onExit
      return () => (job.exit = undefined)
    },
  })
  useWorkspacesStore.setState({ homePath: '/mac' })
  useRemoteLanesStore.setState({ filter: 'local' })
  return { invoke, job, installed: () => (health = { ok: true, version: '1.2.0' }) }
}

async function renderApp(test: (container: HTMLElement) => Promise<void>) {
  const container = document.createElement('div'),
    root = createRoot(container)
  document.body.append(container)
  try {
    await act(async () => root.render(<App />))
    await test(container)
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
}

const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text))

it('hears a pi install that finishes while This Mac’s home is away', async () => {
  const { invoke, job, installed } = stubInstall()
  await renderApp(async (container) => {
    await act(async () => button(container, 'Update pi')?.click())
    expect(invoke).toHaveBeenCalledWith('packages:installPi')
    const id = mockRemoteInfo.sessionId
    await act(async () =>
      useSessionsStore.setState({
        activeSessionId: id,
        live: { [id]: { ...mockRemoteInfo, phosphorId: id } },
      }),
    )
    expect(container.textContent).not.toContain('pi needs an update')
    installed()
    await act(async () => job.exit?.(0))
    await act(async () => useSessionsStore.setState({ activeSessionId: null }))
    expect(invoke.mock.calls.filter(([channel]) => channel === 'pi:health')).toHaveLength(2)
    expect(button(container, 'Recommendations done')).toBeDefined()
  })
})

it('restores the last session only after the recommendations that follow a pi install', async () => {
  const target = { kind: 'session', workspacePath: '/mac', sessionPath: '/mac/last.jsonl' }
  const { job, installed } = stubInstall(target)
  const createSession = vi
    .spyOn(useSessionsStore.getState(), 'createSession')
    .mockImplementation(async () => {
      useSessionsStore.setState({ activeSessionId: 'restored' })
      return 'restored'
    })
  await renderApp(async (container) => {
    await act(async () => button(container, 'Update pi')?.click())
    installed()
    await act(async () => job.exit?.(0))
    expect(createSession).not.toHaveBeenCalled()
    await act(async () => button(container, 'Recommendations done')?.click())
    expect(createSession).toHaveBeenCalledWith('/mac', { sessionPath: '/mac/last.jsonl' })
  })
})
