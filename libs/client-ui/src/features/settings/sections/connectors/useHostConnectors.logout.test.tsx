// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { prepareHostSettings, showHostSettings } from '../../__fixtures__/hostSettingsSurface'
import { hostConnectors } from '../../__fixtures__/connectorsSettings'
import { useSettingsUiStore } from '../../settingsUiStore'
import { useConnectorsStore } from '@/stores/connectors'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { mixedRemoteHosts } from '@/dev/mockRemoteLanes'
import { promptChoice } from '@/stores/prompt'

/* A Host connector's Remove signs out first; an exit host-client only inferred (-1) is no success. */

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
vi.mock('@/lib/monaco', () => ({}))
vi.mock('@/features/terminal/TerminalView', () => ({ TerminalView: () => null }))

const machine = { id: '11111111-1111-4111-8111-111111111111', label: 'bee1' }
const read = hostConnectors([
  {
    name: 'docs',
    scope: 'global',
    transport: 'https',
    enabled: true,
    exposure: 'codemode',
    oauth: true,
  },
])
let root: Root, container: HTMLDivElement
let exits: ((code: number) => void)[] = []
const invoke = vi.fn(async (channel: string) => {
  if (channel === 'hosts:settingsRead' || channel === 'hosts:settingsCheck') return read
  if (channel === 'hosts:settingsPatch') return read
  if (channel === 'hosts:machineTask') return { ptyId: 'pty-1' }
  return undefined
})

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', {
    invoke,
    platform: 'darwin',
    onPtyExit: (_id: string, listener: (code: number) => void) => {
      exits.push(listener)
      return () => {
        exits = exits.filter((entry) => entry !== listener)
      }
    },
  })
  invoke.mockClear()
  exits = []
  useRemoteLanesStore.setState({ hosts: mixedRemoteHosts() })
  useConnectorsStore.setState({ flows: {} })
  useSettingsUiStore.setState({ folder: null })
  prepareHostSettings(machine)
  vi.mocked(promptChoice).mockReset().mockResolvedValue('remove')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function button(text: string, within: ParentNode): HTMLButtonElement {
  const found = [...within.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  if (!found) throw new Error(`Missing button ${text}`)
  return found
}

it('keeps the server when the sign-out program ends with an unknown exit (-1)', async () => {
  await showHostSettings(root, machine.id, 'connectors')
  const row = container.querySelector<HTMLElement>('[data-testid="connector-docs"]')!
  await act(async () => button('Remove', row).click())
  expect(invoke.mock.calls.filter(([c]) => c === 'hosts:machineTask')).toHaveLength(1)
  await act(async () => exits.splice(0).forEach((listener) => listener(-1)))
  const patches = invoke.mock.calls.filter(([c]) => c === 'hosts:settingsPatch')
  expect(patches).toEqual([])
  expect(document.body.textContent).toContain('code -1')
  await act(async () => button('Done', document.body).click())
  expect(container.textContent).toContain('docs was not removed')
})
