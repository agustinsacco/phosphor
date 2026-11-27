// @vitest-environment jsdom
import type * as ReactDomClient from 'react-dom/client'
import { createRequire } from 'node:module'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// Vite dedupes React for the app; here main.tsx would otherwise render with Desktop's own copy.
const roots = vi.hoisted(() => new Set<ReactDomClient.Root>())
vi.mock('react-dom/client', () => {
  const react = createRequire(import.meta.url)(
    '../../../node_modules/react-dom/client.js',
  ) as typeof ReactDomClient
  return {
    default: {
      createRoot: (...args: Parameters<typeof react.createRoot>) => {
        const root = react.createRoot(...args)
        roots.add(root)
        return root
      },
    },
  }
})
vi.mock('@/lib/fonts', () => ({ loadBundledFonts: () => Promise.resolve() }))
vi.mock('@/stores/settings', () => ({
  useSettingsStore: { getState: () => ({ hydrate: () => Promise.resolve(), brainPreview: false }) },
}))

const invoke = vi.fn()

beforeEach(() => {
  vi.resetModules()
  // Registered per test so the App reads the Platform context of this test's fresh main.tsx.
  vi.doMock('@phosphor/client-ui/desktop', async () => {
    const { usePlatform } = await import('@/platform/Platform')
    return {
      App: () => <div data-testid="app">localBrain={String(usePlatform().localBrain)}</div>,
    }
  })
  invoke.mockReset()
  document.body.innerHTML = '<div id="root"></div>'
  ;(window as unknown as { phosphor: unknown }).phosphor = {
    platform: 'darwin',
    invoke,
    onLocalMachineChanged: () => () => {},
  }
})

afterEach(async () => {
  await act(async () => {
    for (const root of roots) root.unmount()
    roots.clear()
  })
  document.body.innerHTML = ''
})

const appText = (): string | null =>
  document.querySelector('[data-testid="app"]')?.textContent ?? null

it('renders the app before brain:status resolves', async () => {
  invoke.mockImplementation((channel: string) =>
    channel === 'brain:status'
      ? new Promise(() => {})
      : Promise.resolve({ mode: 'in-app', migration: 'not-needed', brainOwner: 'desktop' }),
  )
  await import('./main')
  await vi.waitFor(() => expect(appText()).toBe('localBrain=false'))
})

const brainStatus = (enabled: boolean) => ({ supported: true, prefs: { enabled } })

it('shows Brain once its first status reports it enabled, and keeps it for the launch', async () => {
  let answer: (status: unknown) => void = () => {}
  const status = new Promise((resolve) => (answer = resolve))
  invoke.mockImplementation((channel: string) =>
    channel === 'brain:status'
      ? status
      : Promise.resolve({ mode: 'in-app', migration: 'not-needed', brainOwner: 'desktop' }),
  )
  await import('./main')
  await vi.waitFor(() => expect(appText()).toBe('localBrain=false'))
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('brain:status'))
  answer(brainStatus(true))
  await vi.waitFor(() => expect(appText()).toBe('localBrain=true'))
  const { useBrain } = await import('@/features/brain/useBrain')
  useBrain.setState({ status: brainStatus(false) as never })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(appText()).toBe('localBrain=true')
})

it('keeps Brain hidden without blocking when its status fails', async () => {
  invoke.mockImplementation((channel: string) =>
    channel === 'brain:status'
      ? Promise.reject(new Error('stalled'))
      : Promise.resolve({ mode: 'in-app', migration: 'not-needed', brainOwner: 'desktop' }),
  )
  await import('./main')
  await vi.waitFor(() => expect(appText()).toBe('localBrain=false'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(appText()).toBe('localBrain=false')
})

it('does not probe the legacy Brain when This Mac uses the daemon', async () => {
  invoke.mockResolvedValue({
    mode: 'daemon',
    migration: 'committed',
    brainOwner: 'host',
    service: 'down',
  })
  await import('./main')
  await vi.waitFor(() => expect(appText()).toBe('localBrain=false'))
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('app:localMachine'))
  expect(invoke).not.toHaveBeenCalledWith('brain:status')
})

it.each(['ready', 'down'] as const)(
  'keeps the proven legacy owner when a qualified service is %s',
  async (state) => {
    const { useRemoteLanesStore } = await import('@/stores/remoteLanes')
    useRemoteLanesStore.setState({
      hosts: {
        harbor: {
          local: true,
          state,
          connectionToken: 'harbor-fixture',
          brain: true,
          capabilities: [],
          lanes: [],
          repositories: [],
        },
      },
      snapshotStatus: 'ready',
    })
    invoke.mockImplementation((channel: string) =>
      Promise.resolve(
        channel === 'brain:status'
          ? brainStatus(true)
          : { mode: 'daemon', migration: 'committed', brainOwner: 'desktop' },
      ),
    )
    await import('./main')
    await vi.waitFor(() => expect(appText()).toBe('localBrain=true'))
  },
)
