// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AccountView } from '@shared/account'
import { MachinesPage } from './MachinesPage'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useMachinesStore } from '@/stores/machines'
import { MACHINE, LOOKUP } from './__fixtures__/control'

const originalRefresh = useMachinesStore.getState().refresh
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
  // Reset, not clear: a test that swaps the implementation must not leak it.
  invoke.mockReset()
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
    refresh: originalRefresh,
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
const codes = (text: string): Element[] =>
  Array.from(container.querySelectorAll('code')).filter((c) => c.textContent === text)
const check = (name: string): HTMLElement | null =>
  container.querySelector<HTMLElement>(`[data-check="${name}"]`)
const headerPill = (): Element | null =>
  container.querySelector('[data-testid=machine-detail] header [data-tone]')

it('keeps enrollment actions on the list and maintenance in the selected machine menu', async () => {
  useMachinesStore.setState({ view: { kind: 'machine', id: MACHINE.id } })
  await render()
  expect(
    [...container.querySelectorAll('button')].some(
      (button) => button.textContent === 'Add a machine',
    ),
  ).toBe(false)
  expect(container.querySelector('[aria-label="Debug log"]')).toBeNull()
  expect(container.querySelector('[aria-label="Machine actions"]')).not.toBeNull()
  expect(
    [...container.querySelectorAll('button')].some(
      (button) => button.textContent === 'Check again',
    ),
  ).toBe(false)
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Machine actions"]')?.click(),
  )
  expect(
    [...document.querySelectorAll('button')].some((button) => button.textContent === 'Check again'),
  ).toBe(true)
})

it('lists this computer first and only enrolled machines, then opens stable detail', async () => {
  await render()
  expect(document.querySelector('[data-testid=local-machine-row]')).not.toBeNull()
  const rows = document.querySelectorAll('[data-testid=enrolled-machine-row]')
  expect(rows).toHaveLength(1)
  expect(rows[0]?.querySelector('[data-tone]')?.textContent).toBe('Waiting for setup')
  // Never connected: no lane counts or readiness from a Host that has not reported.
  expect(rows[0]?.textContent).not.toContain('running')
  expect(rows[0]?.querySelector('[data-check-chip]')).toBeNull()
  await act(async () => (rows[0] as HTMLButtonElement).click())
  expect(container.textContent).toContain('Waiting for bee1 to finish setup')
  // Setup in progress is not a failure: one command, and the Connection row only waits.
  expect(codes('phosphor setup')).toHaveLength(1)
  expect(check('Connection')?.textContent).toContain('Waiting for setup')
  expect(container.textContent).toContain('phosphor service install')
  await act(async () => useMachinesStore.setState({ nowMs: Date.now() + 5000 }))
  expect(document.querySelector('[data-testid=machine-detail]')).not.toBeNull()
})
it('shows loading rows for local checks until each read settles, then the verdict', async () => {
  const pending: ((value: unknown) => void)[] = []
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'account:get') return account
    if (channel === 'pi:health')
      return new Promise((resolve) => {
        pending.push(resolve)
      })
    if (channel === 'packages:claudeStatus')
      return { binary: { found: true }, auth: { loggedIn: false } }
    return null
  })
  await render()
  const local = (): string =>
    document.querySelector('[data-testid=local-machine-row]')?.textContent ?? ''
  expect(local()).toContain('Checking…')
  await act(async () => pending[0]?.({ ok: true, version: '1.2.0' }))
  expect(local()).toContain('pi 1.2.0')
  expect(local()).toContain('Claude signed out')
  expect(local()).not.toContain('Checking…')
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
  expect(document.querySelector('[aria-label="Loading machines"]')).not.toBeNull()
  expect(document.querySelector('[role=alert]')?.textContent).toContain('Cannot reach')
  expect(container.textContent).toContain('Retrying…')
  // A later refresh with machines already listed says so without hiding them.
  await act(async () => useMachinesStore.setState({ machines: [MACHINE], error: null }))
  expect(document.querySelector('[aria-label="Loading machines"]')).toBeNull()
  expect(container.textContent).toContain('Updating')
  expect(document.querySelectorAll('[data-testid=enrolled-machine-row]')).toHaveLength(1)
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
  const chip = (label: string): Element | null | undefined =>
    rows
      .find((row) => row.textContent?.includes(label))
      ?.querySelector('[data-check-chip="Claude Code"]')
  expect(chip('online')?.getAttribute('data-ok')).toBe('false')
  expect(text('online')).toContain('Not reachable')
  expect(text('online')).toContain('2 running · 1 waiting')
  expect(text('bee1')).toContain('Waiting for setup')
  expect(chip('bee1')).toBeNull()
  expect(text('offline')).toContain('Offline')
  expect(text('offline')).toContain('last seen 3 h ago')
  expect(chip('offline')).toBeNull()
  expect(text('offline')).not.toContain('running')
  expect(text('offline')).not.toContain('Connected')
  // Up machines sort first.
  expect(rows[0]?.textContent).toContain('online')
  await act(async () => useMachinesStore.getState().show({ kind: 'machine', id: offline.id }))
  expect(container.textContent).toContain('As last reported, 3 h ago')
  // Offline, not "publish your address": nothing is checking in to publish one.
  expect(headerPill()?.textContent).toBe('Offline')
  expect(check('Connection')?.textContent).toContain('has not checked in since 3 h ago')
  expect(codes('sudo tailscale set --operator=$USER && phosphor setup')).toHaveLength(0)
  await act(async () => useMachinesStore.getState().show({ kind: 'machine', id: MACHINE.id }))
  expect(container.textContent).toContain('reports pi, Claude and Tailscale once it first connects')
  expect(container.textContent).not.toContain('Sign in to Claude Code on this machine')
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
it('bee2 reports an unreachable address despite green readiness and Check again refreshes control', async () => {
  useMachinesStore.setState({
    machines: [
      {
        ...MACHINE,
        lastSeenAt: new Date().toISOString(),
        state: 'running',
        readiness: { pi: 'ok', claude: 'ok', tailscale: 'ok' },
      },
    ],
    view: { kind: 'machine', id: MACHINE.id },
  })
  await render()
  expect(check('Connection')?.getAttribute('data-ok')).toBe('false')
  expect(check('Connection')?.textContent).toContain('bee1 is enrolled but not reachable')
  expect(container.textContent).toContain('Reported just now')
  // One status for the machine, never "Online · Not reachable yet".
  expect(headerPill()?.textContent).toBe('Not reachable')
  expect(headerPill()?.getAttribute('data-tone')).toBe('warn')
  expect(container.textContent).not.toContain('Online')
  expect(check('Tailscale')?.getAttribute('data-ok')).toBe('false')
  expect(check('Tailscale')?.textContent).toContain('Address not published')
  expect(check('Tailscale')?.textContent).toContain('Running, but its address is not published')
  expect(check('pi')?.textContent).toContain('Ready to run lanes')
  expect(container.textContent).not.toContain('Connected with HTTPS available')
  expect(codes('sudo tailscale set --operator=$USER && phosphor setup')).toHaveLength(1)
  const address = Array.from(container.querySelectorAll('dt')).find(
    (dt) => dt.textContent === 'Address',
  )
  expect(address?.nextElementSibling?.textContent).toBe('Not published')
  invoke.mockClear()
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Machine actions"]')?.click(),
  )
  const refreshButton = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Check again',
  )
  await act(async () => refreshButton?.click())
  expect(invoke).toHaveBeenCalledWith('control:machines')
  // The re-read replaced the machine with control's answer; the card says when it asked.
  expect(container.querySelector('[role=status]')?.textContent).toContain('checked just now')
})
it('a Mac Host without an address gets setup alone, not the Linux operator command', async () => {
  useMachinesStore.setState({
    machines: [
      { ...MACHINE, platform: 'darwin', lastSeenAt: new Date().toISOString(), state: 'running' },
    ],
    view: { kind: 'machine', id: MACHINE.id },
  })
  await render()
  expect(check('Connection')?.textContent).toContain('phosphor setup')
  expect(codes('sudo tailscale set --operator=$USER && phosphor setup')).toHaveLength(0)
})

it.each([
  ['connecting', 'Connecting…', 'pending'],
  ['reconnecting', 'Connecting…', 'pending'],
  ['ready', 'Connected', 'ok'],
] as const)(
  'a published Host that is %s says %s and offers no fix',
  async (connection, label, tone) => {
    useMachinesStore.setState({
      machines: [
        {
          ...MACHINE,
          endpoint: 'https://host.example:47615',
          lastSeenAt: new Date().toISOString(),
          state: 'running',
        },
      ],
      view: { kind: 'machine', id: MACHINE.id },
    })
    useRemoteLanesStore.setState({
      hosts: {
        [MACHINE.id]: {
          connectionToken: 'test',
          state: connection,
          capabilities: [],
          lanes: [],
          repositories: [],
        },
      },
    })
    try {
      await render()
      expect(headerPill()?.textContent).toBe(label)
      expect(headerPill()?.getAttribute('data-tone')).toBe(tone)
      expect(check('Connection')?.textContent).toContain(
        connection === 'ready' ? 'bee1 is reachable' : label,
      )
      expect(check('Connection')?.querySelector('code')).toBeNull()
      expect(container.textContent).not.toContain('Not reachable')
      expect(container.textContent).not.toContain('phosphor service restart')
    } finally {
      useRemoteLanesStore.setState({ hosts: {} })
    }
  },
)
