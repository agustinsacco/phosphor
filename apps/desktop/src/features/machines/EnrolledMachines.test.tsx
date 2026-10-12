// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AccountView } from '@shared/account'
import { MachinesPage } from './MachinesPage'
import { AddMachineDialog } from './AddMachineDialog'
import { useMachinesStore } from '@/stores/machines'
import { MACHINE, LOOKUP } from './__fixtures__/control'
import { CONTROL_ERROR_STATUS } from '@shared/control-api'
import { controlMessage } from './controlMessages'

vi.mock('@/features/settings/tabs/AccountsTab', () => ({ AccountsTab: () => null }))
let root: Root
let container: HTMLDivElement
let push: (view: AccountView) => void
let account: AccountView
let answer: unknown
const NOW = Date.parse('2026-01-01T00:00:00Z')
const invoke = vi.fn(async (channel: string): Promise<unknown> => {
  if (channel === 'account:get') return account
  if (channel === 'control:machines') return answer
  if (channel === 'control:lookupEnrollment') return { ok: true, ...LOOKUP }
  if (channel === 'control:approveEnrollment') return { ok: true, machine: MACHINE }
  if (channel === 'control:removeMachine') {
    answer = { ok: true, machines: [], serverTime: new Date(NOW).toISOString() }
    return { ok: true }
  }
  if (channel === 'packages:list' || channel === 'pi:subscriptionAuth') return []
  return null
})

beforeEach(() => {
  invoke.mockClear()
  account = {
    preview: true,
    account: {
      status: 'signed-in',
      user: { login: 'octo', name: null, email: null },
      remembered: false,
    },
  }
  answer = { ok: true, machines: [MACHINE], serverTime: new Date(NOW).toISOString() }
  vi.spyOn(Date, 'now').mockReturnValue(NOW - 600_000)
  vi.stubGlobal('phosphor', {
    platform: 'darwin',
    invoke,
    onAccountChanged: (listener: typeof push) => {
      push = listener
      return () => undefined
    },
  })
  useMachinesStore.getState().applyPreview(true)
  useMachinesStore.getState().show({ kind: 'list' })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useMachinesStore.getState().applyPreview(false)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const button = (name: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === name)
const click = async (name: string) => {
  const b = button(name)
  expect(b).toBeDefined()
  await act(async () => b?.click())
}
async function input(label: string, value: string) {
  const field = [...document.querySelectorAll('label')]
    .find((l) => l.textContent === label)
    ?.querySelector('input')
  if (!field) throw new Error('missing field')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const render = async (node: React.ReactNode) => {
  await act(async () => root.render(node))
}

it('renders fresh, 91-second-old, stopping and never-seen beats with server clock offset', async () => {
  answer = {
    ok: true,
    serverTime: new Date(NOW).toISOString(),
    machines: [
      {
        ...MACHINE,
        id: 'fresh',
        state: 'running',
        lastSeenAt: new Date(NOW - 12_000).toISOString(),
      },
      { ...MACHINE, id: 'old', state: 'running', lastSeenAt: new Date(NOW - 91_000).toISOString() },
      { ...MACHINE, id: 'stopping', state: 'stopping', lastSeenAt: new Date(NOW).toISOString() },
      MACHINE,
    ],
  }
  await render(<MachinesPage />)
  const rows = [...container.querySelectorAll('[data-testid="enrolled-machine-row"]')]
  expect(rows.map((r) => r.getAttribute('data-status'))).toEqual([
    'up',
    'down',
    'down',
    'never-seen',
  ])
  expect(rows[0]?.textContent).toContain('seen 12 s ago')
  expect(rows[3]?.textContent).toContain('never connected')
  expect(container.textContent).toContain('linux/x64 · Host 0.2.0')
  expect(container.textContent).toContain('pi: ok · Claude: signed-out · Tailscale: ok')
  expect(container.textContent).toContain('2 running · 1 waiting')
  expect(container.textContent).not.toContain('Sample machines')
})
it('normalizes a code, looks up first, shows the fingerprint and approves only a valid label', async () => {
  await render(<MachinesPage />)
  await click('Add a machine')
  expect(button('Look up code')?.disabled).toBe(true)
  await input('Code', 'bcdf ghjk')
  await click('Look up code')
  expect(invoke).toHaveBeenCalledWith('control:lookupEnrollment', 'BCDFGHJK')
  expect(document.body.textContent).toContain(LOOKUP.keyFingerprint)
  expect(document.body.textContent).toContain(
    'Check that the machine printed the same fingerprint.',
  )
  expect(document.querySelector('label input')?.getAttribute('value')).toBe('bee1')
  await input('Label', ' ')
  expect(button('Approve')?.disabled).toBe(true)
  await input('Label', 'a'.repeat(81))
  expect(button('Approve')?.disabled).toBe(true)
  await input('Label', 'a\u202eb')
  expect(button('Approve')?.disabled).toBe(true)
  expect(document.body.textContent).toContain('The label has characters that cannot be shown.')
  await input('Label', 'a'.repeat(80))
  expect(button('Approve')?.disabled).toBe(false)
  await input('Label', ' bee new ')
  await click('Approve')
  expect(invoke).toHaveBeenCalledWith('control:approveEnrollment', 'BCDFGHJK', 'bee new')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(invoke.mock.calls.filter(([channel]) => channel === 'control:machines')).toHaveLength(2)
})
it('confirms removal, explains re-login and removes the row after refresh', async () => {
  await render(<MachinesPage />)
  await click('Remove')
  expect(invoke).not.toHaveBeenCalledWith('control:removeMachine', MACHINE.id)
  expect(document.body.textContent).toContain(
    'The machine stays installed. It must re-run phosphor login to come back.',
  )
  await click('Remove machine')
  expect(invoke).toHaveBeenCalledWith('control:removeMachine', MACHINE.id)
  expect(container.querySelector('[data-testid="enrolled-machine-row"]')).toBeNull()
})
it('treats already removed as a notice, not a failure, and refreshes', async () => {
  await render(<MachinesPage />)
  await click('Remove')
  answer = { ok: true, machines: [], serverTime: new Date(NOW).toISOString() }
  invoke.mockResolvedValueOnce({ ok: false, error: { code: 'not-found', message: '' } })
  await click('Remove machine')
  expect(container.textContent).toContain('That machine was already removed.')
  expect(container.querySelector('[data-testid="enrolled-machine-row"]')).toBeNull()
})
it('signed out keeps samples, makes no control call and clears real data on sign-out', async () => {
  account = { preview: true, account: { status: 'signed-out' } }
  await render(<MachinesPage />)
  expect(container.textContent).toContain('Sample machines. Sign in under Settings')
  expect(invoke.mock.calls.some(([channel]) => channel.startsWith('control:'))).toBe(false)
  await act(async () =>
    push({
      preview: true,
      account: {
        status: 'signed-in',
        user: { login: 'octo', name: null, email: null },
        remembered: false,
      },
    }),
  )
  expect(container.querySelector('[data-testid="enrolled-machine-row"]')).not.toBeNull()
  await act(async () => push(account))
  expect(useMachinesStore.getState().machines).toEqual([])
  expect(container.textContent).toContain('Sample machines')
})
it('polls only while visible and stops when the page closes', async () => {
  vi.useFakeTimers()
  await render(<MachinesPage />)
  await act(async () => vi.advanceTimersByTimeAsync(30_000))
  expect(invoke.mock.calls.filter(([c]) => c === 'control:machines')).toHaveLength(2)
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  await act(async () => vi.advanceTimersByTimeAsync(30_000))
  expect(invoke.mock.calls.filter(([c]) => c === 'control:machines')).toHaveLength(2)
  await render(null)
  await act(async () => vi.advanceTimersByTimeAsync(30_000))
  expect(invoke.mock.calls.filter(([c]) => c === 'control:machines')).toHaveLength(2)
  vi.useRealTimers()
})
it.each([...Object.keys(CONTROL_ERROR_STATUS), 'signed-out', 'offline'])(
  'shows a plain error for %s in lookup and approval',
  async (code) => {
    const close = vi.fn()
    await render(<AddMachineDialog onClose={close} />)
    await input('Code', 'BCDF-GHJK')
    invoke.mockResolvedValueOnce({ ok: false, error: { code, message: 'not displayed' } })
    await click('Look up code')
    const lookupError = document.querySelector('[role="alert"]')?.textContent
    expect(lookupError).toBeTruthy()
    expect(lookupError).not.toContain('not displayed')
    await click('Look up code')
    invoke.mockResolvedValueOnce({ ok: false, error: { code, message: 'not displayed' } })
    await click('Approve')
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(lookupError)
    expect(close).not.toHaveBeenCalled()
  },
)
it('keeps lookup and approval transport failures local and does not apply late dialog state', async () => {
  const close = vi.fn()
  await render(<AddMachineDialog onClose={close} />)
  await input('Code', 'BCDF-GHJK')
  invoke.mockRejectedValueOnce(new Error('not displayed'))
  await click('Look up code')
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(controlMessage('offline'))
  await click('Look up code')
  invoke.mockRejectedValueOnce(new Error('not displayed'))
  await click('Approve')
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(controlMessage('offline'))
  let finish: ((answer: unknown) => void) | undefined
  invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  await click('Approve')
  await render(null)
  await act(async () => finish?.({ ok: true, machine: MACHINE }))
  expect(close).not.toHaveBeenCalled()
})
it('refreshes after approval even if the dialog was closed while waiting', async () => {
  await render(<MachinesPage />)
  await click('Add a machine')
  await input('Code', 'BCDF-GHJK')
  await click('Look up code')
  let finish: ((answer: unknown) => void) | undefined
  invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  await click('Approve')
  await click('Cancel')
  await act(async () => finish?.({ ok: true, machine: MACHINE }))
  expect(invoke.mock.calls.filter(([channel]) => channel === 'control:machines')).toHaveLength(2)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})
it('shows removal failure without hiding the row or the confirmation', async () => {
  await render(<MachinesPage />)
  await click('Remove')
  invoke.mockResolvedValueOnce({
    ok: false,
    error: { code: 'forbidden', message: 'not displayed' },
  })
  await click('Remove machine')
  // The failure is announced inside the open dialog, not behind its backdrop.
  const alert = () => document.querySelector('[role="dialog"] [role="alert"]')
  expect(alert()?.textContent).toBe(controlMessage('forbidden'))
  expect(container.textContent).not.toContain(controlMessage('forbidden'))
  expect(container.querySelector('[data-testid="enrolled-machine-row"]')).not.toBeNull()
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  invoke.mockRejectedValueOnce(new Error('not displayed'))
  await click('Remove machine')
  expect(alert()?.textContent).toBe(controlMessage('offline'))
})
it('uses the required plain wording for enrollment errors', () => {
  expect(controlMessage('not-found')).toContain('wrong or expired')
  expect(controlMessage('too-many-requests')).toContain('Wait 15 minutes')
  expect(controlMessage('conflict')).toContain(
    'machine limit is reached, or this machine is already on an account',
  )
  expect(controlMessage('offline')).toContain("Cannot reach Phosphor's servers")
})
