// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MachineView } from '@shared/control-api'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSettingsUiStore } from '@/features/settings/settingsUiStore'
import { MachinesPage } from './MachinesPage'
import { LOOKUP, MACHINE } from './__fixtures__/control'

// This Mac and a Host, row and detail, onboarding's Providers step and the
// fleet summary: what the page does on both machines, whichever component draws it.
const originalRefresh = useMachinesStore.getState().refresh
const HOST: MachineView = {
  ...MACHINE,
  lastSeenAt: new Date().toISOString(),
  state: 'running',
  endpoint: 'https://bee1.example:47615',
  readiness: { pi: 'ok', claude: 'ok', tailscale: 'ok' },
}
const PROVIDERS = [
  { id: 'anthropic', name: 'Claude Pro/Max', status: 'ready' },
  { id: 'openai-codex', name: 'ChatGPT', status: 'not_ready' },
]
let claude = { provider: 'ok', cli: 'ok', auth: 'ok' }
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
  if (channel === 'control:lookupEnrollment') return { ok: true, ...LOOKUP }
  if (channel === 'control:approveEnrollment') return { ok: true, machine: HOST }
  if (channel === 'pi:health') return { ok: true, version: '1.2.0' }
  if (channel === 'packages:claudeStatus')
    return { binary: { found: true }, auth: { loggedIn: true } }
  if (channel === 'pi:subscriptionAuth' || channel === 'hosts:providers') return PROVIDERS
  if (channel === 'hosts:claude') return claude
  return null
})

beforeEach(() => {
  claude = { provider: 'ok', cli: 'ok', auth: 'ok' }
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
  useRemoteLanesStore.setState({
    hosts: {
      [HOST.id]: {
        connectionToken: 'test',
        state: 'ready',
        capabilities: ['skills.read'],
        configurationSupported: true,
        repositories: [],
        lanes: [],
      },
    },
  })
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

const render = async (): Promise<void> => {
  await act(async () => root.render(<MachinesPage />))
}
const button = (text: string, scope: ParentNode = document): HTMLButtonElement | undefined =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)
const click = async (element: HTMLElement | null | undefined): Promise<void> => {
  expect(element).toBeTruthy()
  await act(async () => element?.click())
}
const region = (name: string): HTMLElement | null =>
  container.querySelector<HTMLElement>(`[data-testid=machine-detail] [aria-label="${name}"]`)
const okChecks = (scope: ParentNode | null | undefined, attribute: string): string[] =>
  [...(scope?.querySelectorAll(`[${attribute}]`) ?? [])].map((e) => e.getAttribute('data-ok')!)

it("This Mac's row reads its checks, and its detail shows readiness, providers and a terminal", async () => {
  await render()
  const row = container.querySelector<HTMLElement>('[data-testid=local-machine-row]')
  expect(row?.textContent).toContain('This Mac')
  expect(row?.textContent).toContain('macOS')
  expect(row?.textContent).toContain('pi 1.2.0')
  expect(okChecks(row, 'data-check-chip')).toEqual(['true', 'true'])
  expect(row?.querySelector('[data-tone]')?.textContent).toBe('Ready')
  await click(row)
  expect(container.querySelector('[data-testid=machine-detail]')).not.toBeNull()
  expect(okChecks(region('Readiness'), 'data-check')).toEqual(['true', 'true'])
  const providers = region('Providers')
  expect(providers?.textContent).toContain('Claude Pro/Max')
  expect(providers?.textContent).toContain('ChatGPT')
  expect(providers?.textContent).toContain('Not signed in')
  await click(providers?.querySelector('button'))
  expect(useSettingsUiStore.getState()).toMatchObject({ tab: 'accounts', machine: 'local' })
  expect(region('Terminal')).not.toBeNull()
  expect(button('Remove machine')).toBeUndefined()
  expect(container.querySelector('[aria-label="Machine views"]')).toBeNull()
})

it("a Host's row and detail show its status, readiness, providers, actions and removal", async () => {
  await render()
  const row = container.querySelector<HTMLElement>('[data-testid=enrolled-machine-row]')
  expect(row?.getAttribute('data-status')).toBe('up')
  expect(row?.textContent).toContain('bee1')
  expect(row?.textContent).toContain('Linux x64')
  expect(row?.querySelector('[data-tone]')?.textContent).toBe('Connected')
  expect(okChecks(row, 'data-check-chip')).toEqual(['true', 'true', 'true'])
  await click(row)
  const detail = container.querySelector('[data-testid=machine-detail]')
  expect(detail?.querySelector('h2')?.textContent).toBe('bee1')
  expect(detail?.querySelector('header [data-tone]')?.textContent).toBe('Connected')
  const names = [...(region('Readiness')?.querySelectorAll('[data-check]') ?? [])].map((e) =>
    e.getAttribute('data-check'),
  )
  expect(names).toEqual(['Connection', 'pi', 'Claude Code', 'Tailscale'])
  expect(okChecks(region('Readiness'), 'data-check')).toEqual(['true', 'true', 'true', 'true'])
  expect(region('Readiness')?.textContent).toContain('Signed in and ready')
  expect(invoke).toHaveBeenCalledWith('hosts:claude', HOST.id)
  expect(region('Providers')?.textContent).toContain('Claude Pro/Max')
  await click(button('Provider settings'))
  expect(useSettingsUiStore.getState()).toMatchObject({ tab: 'accounts', machine: HOST.id })
  expect(container.querySelector('[aria-label="Machine views"]')).not.toBeNull()
  expect(button('Remove machine')).toBeDefined()
  await click(container.querySelector<HTMLElement>('[aria-label="Machine actions"]'))
  const menu = ['Reconnect', 'Check again', 'Update Host…'].map((text) => !!button(text))
  expect(menu).toEqual([true, true, true])
  invoke.mockClear()
  await click(button('Check again'))
  expect(invoke).toHaveBeenCalledWith('control:machines')
  expect(invoke).toHaveBeenCalledWith('hosts:claude', HOST.id)
  expect(invoke).toHaveBeenCalledWith('hosts:providers', HOST.id)
})

it('sums the fleet under the title in words', async () => {
  const offline = {
    ...HOST,
    id: '33333333-3333-4333-8333-333333333333',
    label: 'bee3',
    hostname: 'bee3',
    lastSeenAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
  }
  useMachinesStore.setState({ machines: [HOST, offline] })
  await render()
  const summary = container.querySelector('[data-testid=machines-page] p')?.textContent
  expect(summary).toContain('2 Hosts')
  expect(summary).toContain('1 connected')
  expect(summary).toContain('1 offline')
})

it("onboarding's Providers step reads the new Host's Claude Code and providers, and re-reads them", async () => {
  claude = { provider: 'missing', cli: 'ok', auth: 'ok' }
  useMachinesStore.setState({ machines: [] })
  await render()
  await click(button('Add a machine'))
  await click(button('Continue to Install'))
  await click(button('I have a code'))
  const code = document.querySelector<HTMLInputElement>('[role=dialog] input')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      code,
      'BCDFGHJK',
    )
    code?.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click(button('Look up code'))
  await click(button('Approve machine'))
  await act(async () => useMachinesStore.setState({ machines: [HOST], nowMs: Date.now() }))
  await click(button('Continue to Providers'))
  const step = document.querySelector<HTMLElement>('[role=dialog] [aria-label=Providers]')
  expect(step?.textContent).toContain('Choose how the Host runs models')
  expect(step?.textContent).toContain('Provider credentials stay on bee1')
  expect(step?.textContent).toContain('Claude Code provider missing')
  expect(step?.textContent).toContain('Claude Pro/Max')
  expect(step?.textContent).toContain('ChatGPT')
  invoke.mockClear()
  await click(button('Check readiness again'))
  expect(invoke).toHaveBeenCalledWith('hosts:providers', HOST.id)
  expect(invoke).toHaveBeenCalledWith('hosts:claude', HOST.id)
})
