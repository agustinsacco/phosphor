// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

/* Settings → MCP Connectors scope rules and Host reviews, through the shared Settings surface. */

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
vi.mock('@/features/terminal/TerminalView', () => ({ TerminalView: () => null }))

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
  useSettingsUiStore.setState({ folder: null })
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
const has = (text: string, within: ParentNode = container) =>
  [...within.querySelectorAll('button')].some((b) => b.textContent?.trim() === text)
const click = (target: HTMLElement) => act(async () => target.click())
const settle = () => act(async () => {})

describe('This Mac in a folder', () => {
  beforeEach(() => install(localConnectorsInvoke(() => [])))

  it('adds catalogue connectors to the folder, and sends a secret-bearing one to Machine scope', async () => {
    await showHostSettings(root, 'local', 'connectors')
    act(() => useSettingsUiStore.getState().setFolder('/work'))
    await settle()
    const drive = row('google-drive')
    expect(drive.querySelector('input[type="password"]')).toBeNull()
    expect(button('Add', drive).disabled).toBe(true)
    expect(button('Add', drive).getAttribute('aria-description')).toBe(
      'Switch to Machine scope to add it.',
    )
    expect(drive.textContent).toContain('Switch to Machine scope to add it.')
    await click(button('Add', row('linear')))
    expect(calls('mcp:upsertServer')).toEqual([
      ['mcp:upsertServer', 'project', '/work', 'linear', { url: 'https://mcp.linear.app/mcp' }],
    ])
  })
})

describe('This Mac at machine scope', () => {
  beforeEach(() =>
    install(
      localConnectorsInvoke(() => [globalServer('linear', { url: 'https://mcp.linear.app/mcp' })]),
    ),
  )

  it('says when it last checked every connector, as a Host does', async () => {
    await showHostSettings(root, 'local', 'connectors')
    await settle()
    expect(row('linear').textContent).toContain('Up · 1 tool')
    expect(container.textContent).toMatch(/Checked \d/)
  })
})

describe('a Host', () => {
  let read: MachineSettings
  beforeEach(() => {
    read = hostConnectors([
      {
        name: 'docs',
        scope: 'global',
        transport: 'https',
        enabled: true,
        exposure: 'codemode',
        oauth: true,
      },
    ])
    install(
      vi.fn(async (channel: string) => {
        if (channel === 'hosts:settingsRead' || channel === 'hosts:settingsPatch') return read
        if (channel === 'hosts:machineTask') return { ptyId: 'pty-1' }
        return undefined
      }),
    )
  })
  const show = () => showHostSettings(root, machine.id, 'connectors')
  const changes = () => calls('hosts:settingsPatch').map(([, , patch]) => patch.change)

  it('never checks on its own (M15)', async () => {
    await show()
    expect(calls('hosts:settingsCheck')).toEqual([])
    expect(row('docs').textContent).toContain('Not checked')
  })

  it('keeps an OAuth connector whose sign-out was closed before it finished (M6)', async () => {
    await show()
    vi.mocked(promptChoice).mockResolvedValue('remove')
    await click(button('Remove', row('docs')))
    await click(button('Cancel and close', document.body))
    ptyExit(0)
    await settle()
    expect(changes()).toEqual([])
    expect(container.textContent).toContain('docs was not removed')
  })

  it('saves a command connector only with its code approved (M15)', async () => {
    await show()
    await click(button('Add custom server…'))
    type('Server name', 'tools')
    act(() => button('Local command').click())
    type('Command', 'npx')
    type('Arguments', 'tools-mcp')
    await click(button('Save'))
    expect(promptChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        choices: [expect.objectContaining({ label: 'I trust this code: add server' })],
      }),
    )
    expect(changes()).toEqual([])
    vi.mocked(promptChoice).mockResolvedValueOnce('save')
    await click(button('Save'))
    expect(changes()).toEqual([
      {
        type: 'mcp.upsert',
        name: 'tools',
        config: { command: 'npx', args: ['tools-mcp'] },
        approveCode: true,
      },
    ])
  })

  it('reads "Checking…" only while a check is in flight, not during a Refresh', async () => {
    await show()
    let answer!: (value: MachineSettings) => void
    install(
      vi.fn(async (channel: string) =>
        channel === 'hosts:settingsRead' || channel === 'hosts:settingsCheck'
          ? new Promise<MachineSettings>((resolve) => (answer = resolve))
          : undefined,
      ),
    )
    await click(button('Refresh'))
    expect(has('Checking…')).toBe(false)
    expect(has('Refresh & test all')).toBe(true)
    await act(async () => answer(read))
    vi.mocked(promptChoice).mockResolvedValue('check')
    await click(button('Refresh & test all'))
    expect(button('Checking…').disabled).toBe(true)
    await act(async () => answer(read))
    expect(has('Refresh & test all')).toBe(true)
  })

  it('starts the sign-in after a confirmed catalogue Add, as This Mac does', async () => {
    await show()
    vi.mocked(promptChoice).mockResolvedValueOnce('save').mockResolvedValueOnce('run')
    await click(button('Add', row('linear')))
    expect(changes()).toEqual([
      { type: 'mcp.upsert', name: 'linear', config: { url: 'https://mcp.linear.app/mcp' } },
    ])
    expect(calls('hosts:machineTask')).toEqual([
      [
        'hosts:machineTask',
        machine.id,
        { type: 'machine.task', task: 'mcp.login', name: 'linear' },
      ],
    ])
  })

  it('starts no sign-in when the Host did not confirm the catalogue Add', async () => {
    await show()
    install(
      vi.fn(async (channel: string) => {
        if (channel === 'hosts:settingsRead') return read
        if (channel === 'hosts:settingsPatch') throw new Error('stale')
        return undefined
      }),
    )
    vi.mocked(promptChoice).mockResolvedValue('save')
    await click(button('Add', row('linear')))
    expect(calls('hosts:machineTask')).toEqual([])
  })

  it('refuses an Authorization header in a folder before it reaches the Host', async () => {
    await show()
    act(() => useSettingsUiStore.getState().setFolder('0000000000000001'))
    await settle()
    await click(button('Add custom server…'))
    expect(container.querySelector('[aria-label="Authorization header"]')).toBeNull()
    expect(control<HTMLButtonElement>('Enabled in this folder', row('docs')).disabled).toBe(false)
    expect(button('Remove', row('docs')).disabled).toBe(true)
  })
})
