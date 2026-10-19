// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import {
  COMPACT_PLATFORM,
  DESKTOP_PLATFORM,
  PlatformProvider,
  type Platform,
} from '@/platform/Platform'
import { NavigationProvider } from '@/navigation/Navigation'
import { MachinesPage } from '@/features/machines/MachinesPage'
import { ArtifactsPage } from '@/features/artifacts/ArtifactsPage'
import { SkillsPage } from '@/features/skills/SkillsPage'
import { RoutinesPage } from '@/features/routines/RoutinesPage'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useMachinePagesStore } from '@/stores/machinePages'
import { useMachineCataloguesStore } from '@/stores/machineCatalogues'
import { useRoutinesStore } from '@/stores/routines'
import { useSkillsStore } from '@/stores/skills'
import { useSessionsStore } from '@/stores/sessions'
import { MACHINE } from '@/features/machines/__fixtures__/control'

vi.hoisted(() =>
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {} }),
  }),
)
vi.mock('@/components/markdown/Markdown', () => ({ Markdown: () => null }))
vi.mock('@/features/artifacts/ArtifactsPane', () => ({ ArtifactWorkspace: () => null }))
let root: Root
let container: HTMLDivElement
let fake: ReturnType<typeof createFakePhosphor>
let restore: () => void
let artifactAttempts: number
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  artifactAttempts = 0
  fake = createFakePhosphor({
    'account:get': () => ({
      account: {
        status: 'signed-in',
        user: { login: 'test', name: null, email: null },
        remembered: false,
      },
    }),
    'pi:health': () => ({ ok: true, version: 'test', minVersion: 'test' }),
    'pi:subscriptionAuth': () => [],
    'artifacts:list': () => {
      if (++artifactAttempts === 1) throw new Error('Disconnected')
      return []
    },
    'routines:list': () => ({ routines: [], runs: [], error: null, background: false }),
    'hosts:skills': () => ({ skills: [], probe: 'rpc', userRoot: '' }),
    'hosts:models': () => [],
    'hosts:providers': () => [],
  })
  restore = installFakePhosphor(fake)
  useSessionsStore.setState({ live: {}, disk: {} })
  useMachinesStore.setState({
    machines: [MACHINE],
    view: { kind: 'list' },
    remoteEnabled: true,
    loading: false,
    error: null,
  })
  useRemoteLanesStore.setState({
    filter: MACHINE.id,
    hosts: {
      [MACHINE.id]: {
        state: 'ready',
        connectionToken: 'test',
        capabilities: ['skills.read', 'artifacts.read', 'routines'],
        repositories: [],
        lanes: [],
      },
    },
  })
  useMachinePagesStore.setState({ artifactsMachine: '', skillsMachine: '', routinesMachine: '' })
  useMachineCataloguesStore.setState({ catalogues: {} })
  useSkillsStore.setState({ byWorkspace: {}, selectedDir: null, tab: 'yours' })
  useRoutinesStore.setState({ snapshot: null, error: null, machines: [], remote: {}, draft: null })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  restore()
  fake.dispose()
  useMachinesStore.getState().enableRemote(false)
  vi.unstubAllGlobals()
})
async function render(platform: Platform, children: ReactNode): Promise<void> {
  await act(async () =>
    root.render(
      <PlatformProvider value={platform}>
        <NavigationProvider
          value={{
            location: { to: 'page', page: 'machines', machine: MACHINE.id },
            navigate: vi.fn(),
          }}
        >
          {children}
        </NavigationProvider>
      </PlatformProvider>,
    ),
  )
}

it.each([DESKTOP_PLATFORM, COMPACT_PLATFORM])(
  'shares the full Machines inventory in $formFactor, with native capabilities gated',
  async (platform) => {
    await render(platform, <MachinesPage />)
    expect(container.querySelector('[data-testid="enrolled-machine-row"]')?.textContent).toContain(
      'bee1',
    )
    expect(!!container.querySelector('[data-testid="local-machine-row"]')).toBe(platform.localLanes)
    expect(container.querySelector('[aria-label="Debug log"]')).not.toBeNull()
    expect(container.textContent).toContain('Add a machine')
  },
)

it.each([DESKTOP_PLATFORM, COMPACT_PLATFORM])(
  'recovers the shared artifact library after a failed first read in $formFactor',
  async (platform) => {
    await render(platform, <ArtifactsPage />)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not read the artifact library',
    )
    const retry = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Retry',
    )
    expect(retry).toBeDefined()
    await act(async () => retry?.click())
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.textContent).toContain('No artifacts yet')
    expect(artifactAttempts).toBe(2)
  },
)

it.each([DESKTOP_PLATFORM, COMPACT_PLATFORM])(
  'shares remote Skills inventory and routine actions in $formFactor',
  async (platform) => {
    await render(platform, <SkillsPage workspacePath="" />)
    expect(container.textContent).toContain('Read-only')
    expect(container.querySelector('[placeholder="Search skills"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Upload')
    await render(platform, <RoutinesPage workspacePath="" />)
    expect(container.textContent).toContain('New routine')
    expect(container.textContent).toContain('Import')
    expect(container.querySelector('[aria-label="Search routines"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Keep Phosphor running after closing')
  },
)
