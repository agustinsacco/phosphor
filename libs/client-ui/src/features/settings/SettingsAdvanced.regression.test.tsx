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

/** Channels that fail once, then answer. */
let failing = new Set<string>()
const answers: Record<string, unknown> = {
  'pi:health': { ok: true, version: '0.9.0', minVersion: '0.8.0', binaryPath: '/usr/bin/pi' },
  'pi:listResources': { extensions: [], prompts: [], themes: [] },
  'app:getPrefs': { ...DEFAULT_APP_PREFS, maintenance: DEFAULT_MAINTENANCE_PREFS },
  'maintenance:scan': [],
  'pi:readConfigFile': { path: '/home/me/.pi/agent/settings.json', content: '{"theme":"dark"}' },
  'packages:list': [],
}
const invoke = vi.fn(async (channel: string): Promise<unknown> => {
  if (failing.delete(channel)) throw new Error(`${channel} failed`)
  return answers[channel]
})
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke, platform: 'darwin', onUpdateEvent: () => () => {} })
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: () => undefined,
  })
  invoke.mockClear()
  failing = new Set()
  useRemoteLanesStore.setState({ filter: 'local', hosts: {} })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
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
const alerts = (): string[] =>
  [...document.querySelectorAll('[role=alert]')].map((node) => node.textContent ?? '')
const calls = (channel: string): number => invoke.mock.calls.filter(([c]) => c === channel).length
function retryIn(text: string): HTMLButtonElement {
  const alert = [...document.querySelectorAll('[role=alert]')].find((node) =>
    node.textContent?.includes(text),
  )
  const button = [...(alert?.querySelectorAll('button') ?? [])].find(
    (b) => b.textContent === 'Retry',
  )
  if (!button) throw new Error(`No Retry in the alert about ${text}`)
  return button
}

it('Advanced says pi health could not be read and retries it (regression D2)', async () => {
  failing.add('pi:health')
  await showAdvanced()
  expect(alerts().join()).toContain('pi:health failed')
  await act(async () => retryIn('pi:health failed').click())
  expect(calls('pi:health')).toBe(2)
  expect(container.textContent).toContain('v0.9.0')
  expect(alerts()).toEqual([])
})

it('Maintenance says the scan failed and retries it (regression D2)', async () => {
  failing = new Set(['app:getPrefs', 'maintenance:scan'])
  await showAdvanced()
  expect(alerts().join()).toContain('maintenance:scan failed')
  await act(async () => retryIn('maintenance:scan failed').click())
  expect(calls('maintenance:scan')).toBe(2)
  expect(calls('app:getPrefs')).toBe(2)
  expect(container.textContent).toContain('0 of 0 worktrees reclaimable')
  expect(alerts()).toEqual([])
})

it('the raw config editor says the file could not be read and retries it (regression D2)', async () => {
  failing.add('pi:readConfigFile')
  await showAdvanced()
  const edit = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Edit…')
  await act(async () => edit?.click())
  expect(alerts().join()).toContain('pi:readConfigFile failed')
  await act(async () => retryIn('pi:readConfigFile failed').click())
  expect(calls('pi:readConfigFile')).toBe(2)
  expect(document.querySelector('[data-testid=editor]')?.textContent).toBe('{"theme":"dark"}')
  expect(alerts()).toEqual([])
})
