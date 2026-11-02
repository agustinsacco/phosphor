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
import { useSettingsUiStore } from './settingsUiStore'
import { useConnectorsStore } from '@/stores/connectors'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { mixedRemoteHosts } from '@/dev/mockRemoteLanes'
import { promptChoice } from '@/stores/prompt'

/* Settings → MCP Connectors defects, through the shared Settings surface. */

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
let exits: ((code: number) => void)[] = []
const ptyExit = (code: number) => exits.splice(0).forEach((listener) => listener(code))

function install(fn: ReturnType<typeof vi.fn>): void {
  invoke = fn
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
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  exits = []
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
const row = (id: string) => container.querySelector<HTMLElement>(`[data-testid="connector-${id}"]`)!
function button(text: string, within: ParentNode = container): HTMLButtonElement {
  const found = [...within.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  if (!found) throw new Error(`Missing button ${text}`)
  return found
}
const has = (text: string, within: ParentNode = container) =>
  [...within.querySelectorAll('button')].some((b) => b.textContent?.trim() === text)
function control<T extends HTMLElement>(label: string, within: ParentNode = container): T {
  const found = within.querySelector<T>(`[aria-label="${label}"]`)
  if (!found) throw new Error(`Missing control ${label}`)
  return found
}
function type(label: string, value: string): void {
  const field = control<HTMLInputElement | HTMLTextAreaElement>(label)
  const proto =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const click = (target: HTMLElement) => act(async () => target.click())
const settle = () => act(async () => {})

describe('This Mac', () => {
  let servers: McpResolvedServer[]
  beforeEach(() => {
    servers = [globalServer('linear', { url: 'https://mcp.linear.app/mcp' })]
    install(localConnectorsInvoke(() => servers))
  })
  const show = async (folder: string | null = null) => {
    await showHostSettings(root, 'local', 'connectors')
    act(() => useSettingsUiStore.getState().setFolder(folder))
    await settle()
  }

  it('turns a connector off with an Enabled switch (regression M2)', async () => {
    await show()
    const toggle = control('Enabled', row('linear'))
    expect(toggle.getAttribute('role')).toBe('switch')
    await click(toggle)
    expect(calls('mcp:setEnabled')).toEqual([
      ['mcp:setEnabled', 'global', undefined, 'linear', false],
    ])
  })

  it('reads the chosen folder and turns an inherited connector off only there (regression M3)', async () => {
    await show('/work')
    expect(calls('mcp:readConfigs').at(-1)).toEqual(['mcp:readConfigs', '/work'])
    await click(control('Enabled in this folder', row('linear')))
    expect(calls('mcp:setEnabled')).toEqual([
      ['mcp:setEnabled', 'project', '/work', 'linear', false],
    ])
    expect(button('Remove', row('linear')).disabled).toBe(true)
  })

  it('signs an OAuth connector out without removing it (regression M5)', async () => {
    await show()
    await click(button('Sign out', row('linear')))
    expect(calls('mcp:logout')).toEqual([['mcp:logout', 'linear', undefined]])
    expect(calls('mcp:removeServer')).toEqual([])
  })

  it('asks before removing, then signs out and removes (regression M6)', async () => {
    await show()
    await click(button('Remove', row('linear')))
    expect(promptChoice).toHaveBeenCalledTimes(1)
    expect(calls('mcp:removeServer')).toEqual([])
    vi.mocked(promptChoice).mockResolvedValueOnce('remove')
    await click(button('Remove', row('linear')))
    expect(
      invoke.mock.calls.filter(([c]) => c === 'mcp:logout' || c === 'mcp:removeServer'),
    ).toEqual([
      ['mcp:logout', 'linear', undefined],
      ['mcp:removeServer', 'global', undefined, 'linear'],
    ])
  })

  it('keeps each command argument whole, one per line (regression M9)', async () => {
    await show()
    await click(button('Add custom server…'))
    type('Server name', 'local-tools')
    act(() => button('Local command').click())
    type('Command', 'npx')
    type('Arguments', '-y\n@vendor/server\n--root\n/path with space\n')
    await click(button('Save'))
    expect(calls('mcp:upsertServer')).toEqual([
      [
        'mcp:upsertServer',
        'global',
        undefined,
        'local-tools',
        { command: 'npx', args: ['-y', '@vendor/server', '--root', '/path with space'] },
      ],
    ])
  })

  it('takes an Authorization header at machine scope only (regression M10)', async () => {
    await show()
    await click(button('Add custom server…'))
    type('Server name', 'docs')
    type('Server URL', 'https://docs.example/mcp')
    type('Authorization header', 'Bearer local-secret')
    await click(button('Save'))
    expect(calls('mcp:upsertServer')).toEqual([
      [
        'mcp:upsertServer',
        'global',
        undefined,
        'docs',
        { url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer local-secret' } },
      ],
    ])
    act(() => useSettingsUiStore.getState().setFolder('/work'))
    await settle()
    await click(button('Add custom server…'))
    expect(container.querySelector('[aria-label="Authorization header"]')).toBeNull()
  })
})

describe('a Host', () => {
  let read: MachineSettings
  const server = (
    name: string,
    extra: Partial<NonNullable<MachineSettings['connectors']>['servers'][number]> & {
      oauth?: boolean
    } = {},
  ) => ({
    name,
    scope: 'global' as const,
    transport: 'https' as const,
    enabled: true,
    exposure: 'codemode',
    ...extra,
  })
  beforeEach(() => {
    read = hostConnectors([])
    install(
      vi.fn(async (channel: string) => {
        if (channel === 'hosts:settingsRead' || channel === 'hosts:settingsCheck') return read
        if (channel === 'hosts:settingsPatch') return read
        if (channel === 'hosts:machineTask') return { ptyId: 'pty-1' }
        return undefined
      }),
    )
  })
  const show = () => showHostSettings(root, machine.id, 'connectors')
  const changes = () => calls('hosts:settingsPatch').map(([, , patch]) => patch.change)

  it('turns a connector off with an Enabled switch (regression M2)', async () => {
    read = hostConnectors([server('docs', { oauth: false })])
    await show()
    const toggle = control('Enabled', row('docs'))
    expect(toggle.getAttribute('role')).toBe('switch')
    await click(toggle)
    expect(changes()).toEqual([{ type: 'mcp.enabled', name: 'docs', enabled: false }])
  })

  it("says what pi found in This Mac's words (regression M4)", async () => {
    read = hostConnectors([
      server('fresh'),
      server('up', { state: 'connected', tools: 3 }),
      server('down', { state: 'failed' }),
    ])
    await show()
    expect(row('fresh').textContent).toContain('Not checked')
    expect(row('up').textContent).toContain('Up · 3 tools')
    expect(row('down').textContent).toContain('Down')
  })

  it('signs an OAuth connector out first and removes it only once that worked (regression M6)', async () => {
    read = hostConnectors([server('docs', { oauth: true })])
    await show()
    vi.mocked(promptChoice).mockResolvedValue('remove')
    await click(button('Remove', row('docs')))
    expect(calls('hosts:machineTask')).toEqual([
      ['hosts:machineTask', machine.id, { type: 'machine.task', task: 'mcp.logout', name: 'docs' }],
    ])
    expect(changes()).toEqual([])
    await act(async () => ptyExit(1))
    await click(button('Done'))
    expect(changes()).toEqual([])
    expect(container.textContent).toContain('docs was not removed')
    await click(button('Remove', row('docs')))
    await act(async () => ptyExit(0))
    expect(changes()).toEqual([{ type: 'mcp.remove', name: 'docs' }])
  })

  it('offers only catalogue connectors the Host lacks, writable by default (regression M11)', async () => {
    read = hostConnectors([server('linear')])
    await show()
    expect(has('Add', row('linear'))).toBe(false)
    vi.mocked(promptChoice).mockResolvedValue('save')
    await click(button('Add', row('notion')))
    expect(changes()).toEqual([
      { type: 'mcp.upsert', name: 'notion', config: { url: 'https://mcp.notion.com/mcp' } },
    ])
  })

  it('offers Sign in only where pi signs in with OAuth (regression M12)', async () => {
    read = hostConnectors([
      server('header', { oauth: false }),
      server('oauth', { oauth: true }),
      server('older'),
    ])
    await show()
    expect(has('Sign in', row('header'))).toBe(false)
    expect(has('Sign in', row('oauth'))).toBe(true)
    // A Host too old to say still offers it on every https connector.
    expect(has('Sign in', row('older'))).toBe(true)
  })
})
