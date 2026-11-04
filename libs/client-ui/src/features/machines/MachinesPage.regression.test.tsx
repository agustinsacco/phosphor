// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MachineView } from '@shared/control-api'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useSettingsUiStore } from '@/features/settings/settingsUiStore'
import { DESKTOP_PLATFORM, PlatformProvider } from '@/platform/Platform'
import { MachinesPage } from './MachinesPage'
import { OnlineAndProviders } from './onboarding/OnlineAndProviders'
import { CLAUDE_PROVIDER, MACHINE } from './__fixtures__/control'

// B6: the Machines page drew This Mac and a Host with two rows and two details,
// and they drifted apart. Each case failed on the two-copy page.
const originalRefresh = useMachinesStore.getState().refresh
const HOST: MachineView = {
  ...MACHINE,
  lastSeenAt: new Date().toISOString(),
  state: 'running',
  readiness: { pi: 'ok', claude: 'ok', tailscale: 'ok' },
}
const CONNECTED = {
  connectionToken: 'test',
  state: 'ready' as const,
  capabilities: ['skills.read' as const],
  configurationSupported: true,
  repositories: [],
  lanes: [],
}
let claudeStatus = { binary: { found: true }, auth: { loggedIn: true } }
let hostClaude = { provider: 'ok', cli: 'ok', auth: 'ok' }
let tailscale = 'ready'
let root: Root
let container: HTMLDivElement
const invoke = vi.fn(async (channel: string): Promise<unknown> => {
  if (channel === 'account:get')
    return { account: { status: 'signed-in', user: { login: 'octo' }, remembered: false } }
  if (channel === 'control:machines')
    return {
      ok: true,
      machines: useMachinesStore.getState().machines,
      serverTime: new Date().toISOString(),
    }
  if (channel === 'pi:health') return { ok: true, version: '1.2.0' }
  if (channel === 'packages:claudeStatus') return claudeStatus
  if (channel === 'pi:subscriptionAuth' || channel === 'hosts:providers')
    return [
      { id: 'anthropic', name: 'Claude Pro/Max', status: 'ready' },
      { id: 'openai-codex', name: 'ChatGPT', status: 'not_ready' },
    ]
  if (channel === 'hosts:claude') return hostClaude
  if (channel === 'packages:list') return [CLAUDE_PROVIDER]
  if (channel === 'hosts:tailscaleStatus') return { code: tailscale }
  if (channel === 'app:about') return { appVersion: '1.4.0', platform: 'darwin', arch: 'arm64' }
  if (channel === 'hosts:settingsRead') return { advanced: { pi: { version: '0.70.1' } } }
  return null
})

beforeEach(() => {
  claudeStatus = { binary: { found: true }, auth: { loggedIn: true } }
  hostClaude = { provider: 'ok', cli: 'ok', auth: 'ok' }
  tailscale = 'ready'
  invoke.mockClear()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke, platform: 'darwin', onAccountChanged: () => () => {} })
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => undefined) } })
  useSettingsUiStore.setState({ open: false, tab: 'appearance', machine: null })
  useMachinesStore.setState({
    refresh: originalRefresh,
    remoteEnabled: true,
    machines: [HOST],
    nowMs: Date.now(),
    clockOffsetMs: 0,
    view: { kind: 'list' },
    loading: false,
    error: null,
  })
  useRemoteLanesStore.setState({ hosts: { [HOST.id]: CONNECTED } })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useRemoteLanesStore.setState({ hosts: {} })
  useMachinesStore.getState().enableRemote(false)
  vi.unstubAllGlobals()
})

const render = async (node: React.ReactNode = <MachinesPage />): Promise<void> => {
  await act(async () => root.render(node))
}
const button = (text: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)
const click = async (element: HTMLElement | null | undefined): Promise<void> => {
  expect(element).toBeTruthy()
  await act(async () => element?.click())
}
const openThisMac = async (): Promise<void> => {
  await render()
  await click(container.querySelector<HTMLElement>('[data-testid=local-machine-row]'))
}
const claudeCheck = (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-check^="Claude"]')

it("B6a: This Mac's detail adds no second <h1> under the page title", async () => {
  await openThisMac()
  expect(container.querySelectorAll('h1')).toHaveLength(1)
})

it("B6b: This Mac's status comes from its checks, not a hard-coded Online", async () => {
  claudeStatus = { binary: { found: true }, auth: { loggedIn: false } }
  await openThisMac()
  const pill = container.querySelector('[data-testid=machine-detail] header [data-tone]')
  expect(pill?.textContent).not.toBe('Online')
  expect(pill?.getAttribute('data-tone')).toBe('warn')
})

it('B6c: This Mac has Check again, which re-reads its checks and providers', async () => {
  await openThisMac()
  invoke.mockClear()
  await click(container.querySelector<HTMLElement>('[aria-label="Machine actions"]'))
  await click(button('Check again'))
  const channels = invoke.mock.calls.map(([channel]) => channel)
  expect(channels).toEqual(
    expect.arrayContaining(['pi:health', 'packages:claudeStatus', 'pi:subscriptionAuth']),
  )
})

it('B6d: the fleet summary names This Mac alongside the Hosts', async () => {
  await render()
  const summary = container.querySelector('[data-testid=machines-page] p')?.textContent
  expect(summary).toContain('This Mac')
  expect(summary).toContain('1 Host')
})

it('B6e: every missing Claude Code gets the one remedy, Settings → Extensions → Claude Code', async () => {
  const remedies: string[] = []
  const readRemedy = (): void => {
    expect(claudeCheck()?.querySelector('code')).toBeNull()
    remedies.push(claudeCheck()?.querySelector('p')?.textContent ?? '')
  }
  claudeStatus = { binary: { found: false }, auth: { loggedIn: false } }
  await openThisMac()
  readRemedy()
  for (const claude of [
    { provider: 'missing', cli: 'ok', auth: 'ok' },
    { provider: 'ok', cli: 'missing', auth: 'ok' },
  ]) {
    hostClaude = claude
    act(() => root.unmount())
    root = createRoot(container)
    useMachinesStore.setState({ view: { kind: 'machine', id: HOST.id } })
    await render()
    readRemedy()
  }
  // An unconnected Host has only its heartbeat report, and no Settings to open (R-M2).
  await act(async () => {
    useRemoteLanesStore.setState({ hosts: {} })
    useMachinesStore.setState({
      machines: [{ ...HOST, readiness: { pi: 'ok', claude: 'missing', tailscale: 'ok' } }],
    })
  })
  expect(claudeCheck()?.querySelector('code')?.textContent).toBe('phosphor setup')
  for (const remedy of remedies) expect(remedy).toContain('Settings → Extensions → Claude Code')
  expect(new Set(remedies.map((r) => r.slice(r.indexOf('Settings'))))).toHaveLength(1)
})

it("B6f: onboarding's Providers step points at Settings → Accounts, not a Readiness section", async () => {
  const open = vi.fn()
  await render(<OnlineAndProviders added={HOST} providers onOpen={open} onProviders={() => {}} />)
  expect(container.textContent).not.toContain('Readiness')
  await click(button('Provider settings'))
  expect(useSettingsUiStore.getState()).toMatchObject({ tab: 'accounts', machine: HOST.id })
})

it("B6g: This Mac's detail is selected by the local machine id, 'local'", async () => {
  await openThisMac()
  expect(useMachinesStore.getState().view).toEqual({ kind: 'machine', id: 'local' })
})

it("onboarding's Providers step uses Settings' sign-in words", async () => {
  await render(
    <OnlineAndProviders added={HOST} providers onOpen={() => {}} onProviders={() => {}} />,
  )
  const row = (id: string): string | null | undefined =>
    container.querySelector(`[data-provider="${id}"] [data-sign-in]`)?.textContent
  expect(row('anthropic')).toBe('Signed in')
  expect(row('openai-codex')).toBe('Not signed in')
})

it("R-M7: This Mac's live lanes count only its own lanes, not Host lanes open here", async () => {
  useSessionsStore.setState({
    live: {
      mine: { phosphorId: 'mine', workspacePath: '/work/app' },
      remote: {
        phosphorId: 'remote',
        workspacePath: `host:${HOST.id}/lane:lane-1`,
        target: { kind: 'remote', hostId: HOST.id },
        laneId: 'lane-1',
      },
    } as never,
  })
  try {
    await openThisMac()
    const detail = container.querySelector('[data-testid=machine-detail]')?.textContent
    expect(detail).toContain('1 live lane')
    expect(detail).not.toContain('2 live lanes')
  } finally {
    useSessionsStore.setState({ live: {} })
  }
})

const tailscaleRow = (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-check="Tailscale"]')
const localPill = (): string | null | undefined =>
  container.querySelector('[data-testid=machine-detail] header [data-tone]')?.textContent

it('C5a: with no Hosts, a missing Tailscale on This Mac is optional and leaves it Ready', async () => {
  tailscale = 'not-installed'
  useMachinesStore.setState({ machines: [] })
  await openThisMac()
  expect(tailscaleRow()?.getAttribute('data-ok')).toBe('false')
  expect(tailscaleRow()?.querySelector('[aria-label="Needs attention"]')).toBeNull()
  expect(tailscaleRow()?.querySelector('[data-tooltip]')?.getAttribute('data-tooltip')).toContain(
    'Needed only to reach your Hosts',
  )
  expect(localPill()).toBe('Ready')
})

it('C5b: with Hosts enrolled, a stopped Tailscale on This Mac needs attention', async () => {
  tailscale = 'not-running'
  await openThisMac()
  expect(tailscaleRow()?.querySelector('[aria-label="Needs attention"]')).not.toBeNull()
  expect(tailscaleRow()?.textContent).toContain('Open Tailscale and connect to your tailnet')
  expect(localPill()).not.toBe('Ready')
})

it('C5c: signed out, This Mac reaches no Hosts, so its Tailscale is optional', async () => {
  tailscale = 'signed-out'
  useMachinesStore.getState().enableRemote(false)
  await openThisMac()
  expect(tailscaleRow()?.querySelector('[aria-label="Needs attention"]')).toBeNull()
  expect(localPill()).toBe('Ready')
})

it("C5d: a Host's own Tailscale row is never muted", async () => {
  useMachinesStore.setState({
    machines: [{ ...HOST, readiness: { pi: 'ok', claude: 'ok', tailscale: 'stopped' } }],
    view: { kind: 'machine', id: HOST.id },
  })
  await render()
  expect(tailscaleRow()?.querySelector('[aria-label="Needs attention"]')).not.toBeNull()
})

it("C8: This Mac's actions menu updates Phosphor through Settings → About, where the app can", async () => {
  await openThisMac()
  await click(container.querySelector<HTMLElement>('[aria-label="Machine actions"]'))
  expect(button('Update Host…')).toBeUndefined()
  await click(button('Update Phosphor…'))
  expect(useSettingsUiStore.getState()).toMatchObject({ tab: 'about' })
  act(() => root.unmount())
  root = createRoot(container)
  await render(
    <PlatformProvider value={{ ...DESKTOP_PLATFORM, appInfo: false }}>
      <MachinesPage />
    </PlatformProvider>,
  )
  await click(container.querySelector<HTMLElement>('[aria-label="Machine actions"]'))
  expect(button('Check again')).toBeDefined()
  expect(button('Update Phosphor…')).toBeUndefined()
})

const fact = (label: string): string | undefined =>
  [...container.querySelectorAll('.machine-facts dt')].find((dt) => dt.textContent === label)
    ?.nextElementSibling?.textContent ?? undefined

it("C9a: This Mac's Details add its architecture and Phosphor version", async () => {
  await openThisMac()
  expect(fact('Platform')).toBe('macOS arm64')
  expect(fact('Phosphor version')).toBe('1.4.0')
  expect(fact('pi')).toBe('1.2.0')
})

it("C9b: a Host's Details show its pi version where this device may read its settings", async () => {
  useRemoteLanesStore.setState({
    hosts: { [HOST.id]: { ...CONNECTED, capabilities: ['skills.read', 'machine.configure'] } },
  })
  useMachinesStore.setState({ view: { kind: 'machine', id: HOST.id } })
  await render()
  expect(invoke).toHaveBeenCalledWith('hosts:settingsRead', HOST.id, 'advanced')
  expect(fact('pi')).toBe('0.70.1')
})

it("C9c: without configuration access, a Host's Details neither read nor show its pi", async () => {
  useMachinesStore.setState({ view: { kind: 'machine', id: HOST.id } })
  await render()
  expect(invoke).not.toHaveBeenCalledWith('hosts:settingsRead', HOST.id, 'advanced')
  expect(fact('pi')).toBeUndefined()
  expect(fact('Host version')).toBeDefined()
})
