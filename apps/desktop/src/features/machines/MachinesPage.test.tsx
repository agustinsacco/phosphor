// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AccountView } from '@shared/account'
import { MachinesPage } from './MachinesPage'
import { useMachinesStore } from '@/stores/machines'
import { MACHINE, LOOKUP } from './__fixtures__/control'

let root: Root
let container: HTMLDivElement
let account: AccountView
const invoke = vi.fn(async (channel: string): Promise<unknown> => {
  if (channel === 'account:get') return account
  if (channel === 'control:machines')
    return { ok: true, machines: [MACHINE], serverTime: new Date().toISOString() }
  if (channel === 'control:lookupEnrollment') return { ok: true, ...LOOKUP }
  if (channel === 'control:approveEnrollment' || channel === 'control:renameMachine')
    return { ok: true, machine: MACHINE }
  if (channel === 'control:removeMachine') return { ok: true }
  if (channel === 'pi:subscriptionAuth') return []
  return null
})
beforeEach(() => {
  invoke.mockClear()
  account = {
    account: {
      status: 'signed-in',
      user: { login: 'octo', name: null, email: null },
      remembered: false,
    },
  }
  vi.stubGlobal('phosphor', { invoke, platform: 'darwin', onAccountChanged: () => () => undefined })
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => undefined) } })
  useMachinesStore.setState({
    remoteEnabled: true,
    machines: [MACHINE],
    nowMs: Date.now(),
    view: { kind: 'list' },
    loading: false,
    error: null,
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useMachinesStore.getState().enableRemote(false)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const render = async (): Promise<void> => {
  await act(async () => root.render(<MachinesPage />))
}
const click = async (text: string): Promise<void> => {
  const button = Array.from(document.querySelectorAll('button')).find(
    (entry) => entry.textContent === text,
  )
  expect(button, text).toBeDefined()
  await act(async () => button?.click())
}
const input = async (label: string, value: string): Promise<void> => {
  const element = Array.from(document.querySelectorAll('input')).find(
    (entry) =>
      entry.closest('label')?.textContent?.includes(label) ||
      entry.getAttribute('aria-label') === label,
  )
  expect(element).toBeDefined()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value)
    element?.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
it('lists this computer first and only enrolled machines, then opens stable detail', async () => {
  await render()
  expect(document.querySelector('[data-testid=local-machine-row]')).not.toBeNull()
  expect(document.querySelectorAll('[data-testid=enrolled-machine-row]')).toHaveLength(1)
  expect(container.textContent).toContain('Waiting for first connection')
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[data-testid=enrolled-machine-row]')?.click(),
  )
  expect(container.textContent).toContain('Finish setting up bee1')
  expect(container.textContent).toContain('phosphor service install')
  await act(async () => useMachinesStore.setState({ nowMs: Date.now() + 5000 }))
  expect(document.querySelector('[data-testid=machine-detail]')).not.toBeNull()
})
it('shows only local status and optional sign-in when signed out', async () => {
  account = { account: { status: 'signed-out' } }
  await render()
  expect(document.querySelectorAll('[data-testid=enrolled-machine-row]')).toHaveLength(0)
  expect(container.textContent).toContain('Sign in with GitHub to add other machines')
  expect(
    Array.from(document.querySelectorAll('button')).find(
      (entry) => entry.textContent === 'Add a machine',
    )?.disabled,
  ).toBe(true)
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[data-testid=local-machine-row]')?.click(),
  )
  expect(container.textContent).toContain('Provider sign-ins')
})
it('shows empty guidance, list loading and offline errors explicitly', async () => {
  useMachinesStore.setState({ machines: [] })
  await render()
  expect(container.textContent).toContain('Bring another machine online')
  expect(container.textContent).toContain('phosphor setup')
  await act(async () => useMachinesStore.setState({ loading: true, error: 'offline' }))
  expect(container.textContent).toContain('Updating machines')
  expect(document.querySelector('[role=alert]')?.textContent).toContain('Cannot reach')
})
it('walks all four enrollment steps, formats code, submits Enter, and shows done', async () => {
  await render()
  await click('Add a machine')
  await click('Continue to Install')
  expect(document.querySelector('[role=dialog]')?.textContent).toContain(
    'Install on the other machine',
  )
  await click('I have a code')
  await input('Code', 'bcdfghjk')
  expect(document.querySelector('input')?.value).toBe('BCDF-GHJK')
  await act(async () =>
    document
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
  expect(invoke).toHaveBeenCalledWith('control:lookupEnrollment', 'BCDFGHJK')
  expect(document.querySelector('[role=dialog]')?.textContent).toContain(LOOKUP.keyFingerprint)
  await input('Machine label', 'bee1')
  await click('Approve machine')
  expect(document.querySelector('[role=dialog]')?.textContent).toContain('bee1 added')
  await click('View machine')
  expect(useMachinesStore.getState().view).toEqual({ kind: 'machine', id: MACHINE.id })
})
it.each(['not-found', 'too-many-requests', 'offline', 'signed-out'])(
  'shows code failure %s without advancing',
  async (code) => {
    await render()
    await click('Add a machine')
    await click('Continue to Install')
    await click('I have a code')
    await input('Code', 'BCDFGHJK')
    invoke.mockResolvedValueOnce({ ok: false, error: { code } })
    await click('Look up code')
    expect(document.querySelector('[role=dialog] [role=alert]')).not.toBeNull()
    expect(document.querySelector('input')?.value).toBe('BCDF-GHJK')
  },
)
it('confirms removal before invoking main, and Cancel is inert', async () => {
  useMachinesStore.setState({ view: { kind: 'machine', id: MACHINE.id } })
  await render()
  expect(container.textContent).toContain('Lanes, routines and files stay on the machine')
  expect(container.textContent).toContain('return when you add it again')
  await click('Remove machine')
  const confirmation = document.querySelector('[role=dialog]')?.textContent
  expect(confirmation).toContain('next heartbeat')
  expect(confirmation).toContain('Lanes, routines and files stay on the machine')
  expect(confirmation).toContain('return when you add it again')
  expect(confirmation).toContain('phosphor setup')
  expect(invoke).not.toHaveBeenCalledWith('control:removeMachine', MACHINE.id)
  await click('Cancel')
  expect(document.querySelector('[role=dialog]')).toBeNull()
  await click('Remove machine')
  await act(async () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role=dialog] button'))
      .find((entry) => entry.textContent === 'Remove machine')
      ?.click(),
  )
  expect(invoke).toHaveBeenCalledWith('control:removeMachine', MACHINE.id)
})
it('shows readiness on a row only while it is current, and names this Mac once', async () => {
  const at = Date.now()
  const online = {
    ...MACHINE,
    id: '22222222-2222-4222-8222-222222222222',
    label: 'online',
    hostname: 'host-online',
    lastSeenAt: new Date(at).toISOString(),
    state: 'running' as const,
  }
  const offline = {
    ...online,
    id: '33333333-3333-4333-8333-333333333333',
    label: 'offline',
    hostname: 'host-offline',
    lastSeenAt: new Date(at - 3 * 3600_000).toISOString(),
  }
  useMachinesStore.setState({ machines: [MACHINE, online, offline], nowMs: at, clockOffsetMs: 0 })
  await render()
  const local = document.querySelector('[data-testid=local-machine-row]')?.textContent ?? ''
  expect(local).toContain('This Mac')
  expect(local).not.toContain('This computer')
  const rows = Array.from(document.querySelectorAll('[data-testid=enrolled-machine-row]'))
  const text = (label: string): string =>
    rows.find((row) => row.textContent?.includes(label))?.textContent ?? ''
  expect(text('online')).toContain('Claude signed out')
  expect(text('bee1')).toContain('Finish setup')
  expect(text('bee1')).not.toContain('Claude signed out')
  expect(text('offline')).toContain('Offline · last seen 3 h ago')
  expect(text('offline')).not.toContain('Claude signed out')
  expect(text('offline')).not.toContain('Ready')
  await act(async () => useMachinesStore.getState().show({ kind: 'machine', id: offline.id }))
  expect(container.textContent).toContain('As last reported, 3 h ago')
  await act(async () => useMachinesStore.getState().show({ kind: 'machine', id: MACHINE.id }))
  expect(container.textContent).toContain('reports pi, Claude and Tailscale once it first connects')
  expect(container.textContent).not.toContain('Sign in to Claude on this machine')
})
it('refreshes the list when an approval lands after the dialog closed', async () => {
  const refresh = vi.fn(async () => undefined)
  useMachinesStore.setState({ refresh } as never)
  let finish: ((value: unknown) => void) | undefined
  await render()
  await click('Add a machine')
  await click('Continue to Install')
  await click('I have a code')
  await input('Code', 'BCDFGHJK')
  await click('Look up code')
  await input('Machine label', 'bee1')
  invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  await click('Approve machine')
  await act(async () =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  )
  expect(document.querySelector('[role=dialog]')).toBeNull()
  await act(async () => finish?.({ ok: true, machine: MACHINE }))
  expect(refresh).toHaveBeenCalledOnce()
})
