// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_APP_PREFS, DEFAULT_MAINTENANCE_PREFS } from '@shared/models'
import { HOST_SETTINGS_PLATFORM } from './__fixtures__/hostSettingsSurface'
import { PlatformProvider } from '@/platform/Platform'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { SettingsSurface } from './SettingsSurface'
import { useSettingsUiStore } from './settingsUiStore'

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
vi.mock('@/features/files/MonacoEditor', () => ({
  MonacoEditor: ({ value }: { value: string }) => <pre data-testid="editor">{value}</pre>,
}))

/** Whether the Maintenance section throws on render. */
const crash = vi.hoisted(() => ({ on: false }))
vi.mock('./sections/advanced/MaintenanceSection', async (load) => {
  const real = await load<{ MaintenanceSection: () => React.JSX.Element }>()
  return {
    ...real,
    MaintenanceSection: (): React.JSX.Element => {
      if (crash.on) throw new Error('section exploded')
      return <real.MaintenanceSection />
    },
  }
})

const answers: Record<string, unknown> = {
  'pi:health': { ok: true, version: '0.9.0', minVersion: '0.8.0', binaryPath: '/usr/bin/pi' },
  'pi:listResources': { extensions: [], prompts: [], themes: [] },
  'app:getPrefs': { ...DEFAULT_APP_PREFS, maintenance: DEFAULT_MAINTENANCE_PREFS },
  'maintenance:scan': [],
  'packages:list': [],
}
const invoke = vi.fn(async (channel: string): Promise<unknown> => answers[channel])
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke, platform: 'darwin', onUpdateEvent: () => () => {} })
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: () => undefined,
  })
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  crash.on = false
  useRemoteLanesStore.setState({ filter: 'local', hosts: {} })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function showAdvanced(): Promise<void> {
  useSettingsUiStore.setState({ tab: 'advanced', machine: 'local', query: '', listing: false })
  await act(async () =>
    root.render(
      <PlatformProvider value={HOST_SETTINGS_PLATFORM}>
        <SettingsSurface />
      </PlatformProvider>,
    ),
  )
}
const card = (): Element | null => container.querySelector('[data-testid=settings-section-error]')
const button = (scope: ParentNode | null, label: string): HTMLButtonElement | undefined =>
  [...(scope?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.includes(label))

it('a throwing section shows an error card in place and Settings stays usable', async () => {
  crash.on = true
  await showAdvanced()
  expect(card()?.textContent).toContain('This section couldn’t load.')
  expect(card()?.textContent).not.toContain('section exploded')
  expect(container.querySelector('nav[aria-label="Settings sections"]')).not.toBeNull()

  crash.on = false
  await act(async () => button(card(), 'Retry')?.click())
  expect(card()).toBeNull()
  expect(container.textContent).toContain('0 of 0 worktrees reclaimable')
})

it('the error card clears when another section opens', async () => {
  crash.on = true
  await showAdvanced()
  expect(card()).not.toBeNull()
  const nav = container.querySelector('nav[aria-label="Settings sections"]')
  await act(async () => button(nav, 'Appearance')?.click())
  expect(useSettingsUiStore.getState().tab).toBe('appearance')
  expect(card()).toBeNull()
})

it('Maintenance falls back to its defaults when prefs lack the field', async () => {
  const { maintenance: _omitted, ...withoutMaintenance } = {
    ...DEFAULT_APP_PREFS,
    maintenance: DEFAULT_MAINTENANCE_PREFS,
  }
  answers['app:getPrefs'] = withoutMaintenance
  await showAdvanced()
  expect(card()).toBeNull()
  expect(container.textContent).toContain('0 of 0 worktrees reclaimable')
})
