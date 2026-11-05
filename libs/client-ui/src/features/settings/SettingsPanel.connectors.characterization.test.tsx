// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpResolvedServer } from '@shared/mcp'
import type { MachineSettings } from '@shared/machine-settings'
import { prepareHostSettings, showHostSettings } from './__fixtures__/hostSettingsSurface'
import {
  globalServer,
  hostConnectors,
  localConnectorsInvoke,
} from './__fixtures__/connectorsSettings'
import { useConnectorsStore } from '@/stores/connectors'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { mixedRemoteHosts } from '@/dev/mockRemoteLanes'
import { promptChoice } from '@/stores/prompt'

/*
 * Settings → MCP Connectors through the shared Settings surface, on This Mac at
 * machine scope and on a Host. Pins only what both machines keep.
 */

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
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))

const machine = { id: '11111111-1111-4111-8111-111111111111', label: 'bee1' }
let root: Root, container: HTMLDivElement
let invoke: ReturnType<typeof vi.fn>

function install(fn: ReturnType<typeof vi.fn>): void {
  invoke = fn
  vi.stubGlobal('phosphor', { invoke, platform: 'darwin', onPtyExit: () => () => {} })
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useRemoteLanesStore.setState({ hosts: mixedRemoteHosts() })
  useConnectorsStore.setState({ flows: {} })
  prepareHostSettings(machine)
  vi.mocked(promptChoice).mockReset().mockResolvedValue(undefined)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const calls = (channel: string) => invoke.mock.calls.filter(([c]) => c === channel)
const row = (id: string) => container.querySelector<HTMLElement>(`[data-testid="connector-${id}"]`)
function button(text: string | RegExp, within: ParentNode = container): HTMLButtonElement {
  const found = [...within.querySelectorAll('button')].find((b) =>
    typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent ?? ''),
  )
  if (!found) throw new Error(`Missing button ${String(text)}`)
  return found
}
function type(placeholder: string, value: string): void {
  const field = container.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const click = (target: HTMLElement) => act(async () => target.click())

describe('This Mac at machine scope', () => {
  let servers: McpResolvedServer[]
  beforeEach(() => {
    servers = []
    install(localConnectorsInvoke(() => servers))
  })

  it("lists pi's global servers with their endpoint and a checked status", async () => {
    servers = [globalServer('linear', { url: 'https://mcp.linear.app/mcp' })]
    await showHostSettings(root, 'local', 'connectors')
    await act(async () => {})
    expect(calls('mcp:readConfigs')[0]).toEqual(['mcp:readConfigs', undefined])
    expect(row('linear')?.textContent).toContain('https://mcp.linear.app/mcp')
    expect(row('linear')?.textContent).toContain('Up · 1 tool')
  })

  it('adds a catalogue connector to the global file, then starts its sign-in', async () => {
    await showHostSettings(root, 'local', 'connectors')
    await click(button('Add', row('linear')!))
    expect(calls('mcp:upsertServer')).toEqual([
      ['mcp:upsertServer', 'global', undefined, 'linear', { url: 'https://mcp.linear.app/mcp' }],
    ])
    expect(calls('mcp:authorize')).toEqual([['mcp:authorize', 'linear', undefined]])
  })

  it('adds a custom remote server to the global file', async () => {
    await showHostSettings(root, 'local', 'connectors')
    await click(button('Add custom server…'))
    type('server name (e.g. linear)', 'docs')
    type('https://mcp.example.com/mcp', 'https://docs.example/mcp')
    await click(button('Save'))
    expect(calls('mcp:upsertServer')).toEqual([
      ['mcp:upsertServer', 'global', undefined, 'docs', { url: 'https://docs.example/mcp' }],
    ])
  })
})

describe('a Host', () => {
  let read: MachineSettings
  beforeEach(() => {
    read = hostConnectors([
      { name: 'tools', scope: 'global', transport: 'stdio', enabled: true, exposure: 'codemode' },
    ])
    install(
      vi.fn(async (channel: string) => {
        if (channel === 'hosts:settingsRead' || channel === 'hosts:settingsCheck') return read
        if (channel === 'hosts:settingsPatch') return read
        return undefined
      }),
    )
  })

  it('lists the Host servers and checks them only once the user confirms', async () => {
    await showHostSettings(root, machine.id, 'connectors')
    expect(container.textContent).toContain('tools')
    const check = button(/Check status|test all/)
    await click(check)
    expect(promptChoice).toHaveBeenCalledTimes(1)
    expect(calls('hosts:settingsCheck')).toEqual([])
    vi.mocked(promptChoice).mockResolvedValueOnce('check')
    await click(check)
    expect(calls('hosts:settingsCheck')).toEqual([['hosts:settingsCheck', machine.id, undefined]])
  })

  it('removes a command server only once the user confirms', async () => {
    await showHostSettings(root, machine.id, 'connectors')
    await click(button('Remove'))
    expect(calls('hosts:settingsPatch')).toEqual([])
    vi.mocked(promptChoice).mockResolvedValueOnce('remove')
    await click(button('Remove'))
    expect(calls('hosts:settingsPatch').map(([, , patch]) => patch.change)).toEqual([
      { type: 'mcp.remove', name: 'tools' },
    ])
  })
})
