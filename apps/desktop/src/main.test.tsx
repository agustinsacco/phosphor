// @vitest-environment jsdom
import { createRequire } from 'node:module'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// Vite dedupes React for the app; here main.tsx would otherwise render with Desktop's own copy.
vi.mock('react-dom/client', () => ({
  default: createRequire(import.meta.url)('../../../node_modules/react-dom/client.js') as object,
}))
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
  ;(window as unknown as { phosphor: unknown }).phosphor = { platform: 'darwin', invoke }
})

afterEach(() => {
  document.body.innerHTML = ''
})

const appText = (): string | null =>
  document.querySelector('[data-testid="app"]')?.textContent ?? null

it('renders the app before brain:status resolves', async () => {
  invoke.mockImplementation((channel: string) =>
    channel === 'brain:status' ? new Promise(() => {}) : Promise.resolve(undefined),
  )
  await import('./main')
  await vi.waitFor(() => expect(appText()).toBe('localBrain=false'))
})

const brainStatus = (enabled: boolean) => ({ supported: true, prefs: { enabled } })

it('shows Brain once its first status reports it enabled, and keeps it for the launch', async () => {
  let answer: (status: unknown) => void = () => {}
  invoke.mockImplementation((channel: string) =>
    channel === 'brain:status'
      ? new Promise((resolve) => (answer = resolve))
      : Promise.resolve(undefined),
  )
  await import('./main')
  await vi.waitFor(() => expect(appText()).toBe('localBrain=false'))
  answer(brainStatus(true))
  await vi.waitFor(() => expect(appText()).toBe('localBrain=true'))
  const { useBrain } = await import('@/features/brain/useBrain')
  useBrain.setState({ status: brainStatus(false) as never })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(appText()).toBe('localBrain=true')
})

it('keeps Brain hidden without blocking when its status fails', async () => {
  invoke.mockImplementation((channel: string) =>
    channel === 'brain:status' ? Promise.reject(new Error('stalled')) : Promise.resolve(undefined),
  )
  await import('./main')
  await vi.waitFor(() => expect(appText()).toBe('localBrain=false'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(appText()).toBe('localBrain=false')
})
