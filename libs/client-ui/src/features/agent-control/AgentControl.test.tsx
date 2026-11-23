// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AGENT_POLICY_DEFAULT, CONFIRM_TITLE_PREFIX } from '@phosphor/shared/ops'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import type { OpsRunRequest } from '@phosphor/shared/host-protocol-ops'

window.matchMedia = vi
  .fn()
  .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })
const { AgentControl } = await import('./AgentControl')
const { ExtensionDialogHost, ToastHost } = await import('@/features/extension-ui/ExtensionUiHosts')
const { useExtensionUiStore } = await import('@/stores/extensionUi')
const { useRemoteLanesStore } = await import('@/stores/remoteLanes')
const { mockRemoteHosts, MOCK_HOST_ID } = await import('@/dev/mockRemoteLanes')
const policy = { policy: AGENT_POLICY_DEFAULT, changedOutside: true }
const title = `${CONFIRM_TITLE_PREFIX}Purge archives`
const message = 'Remove archive abc?\nReason written by the agent: no longer needed.'
const confirmId = '00000000-0000-4000-8000-000000000001'
const info = {
  confirmId,
  digest: 'ab'.repeat(32),
  state: 'pending',
  expiresAt: Date.now() + 600000,
  op: 'archive.purge',
  title,
  message,
  dialogId: 'dlg',
  origin: { kind: 'agent', label: 'Lane A' },
  items: [
    {
      hostId: MOCK_HOST_ID,
      op: 'archive.purge',
      ids: ['abc'],
      labels: ['old lane'],
      confirmId,
      digest: 'ab'.repeat(32),
    },
  ],
}
const ok = (data: unknown) => ({ status: 'ok', applies: 'now', text: 'Done', data })
const invoke = vi.fn()
let fake: ReturnType<typeof createFakePhosphor>
let restore: () => void
let root: Root
const mount = (node: React.ReactNode) => act(async () => root.render(node))
const button = (text: string) =>
  [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
const click = (text: string) => act(async () => button(text)!.click())
const focus = () =>
  act(async () => {
    window.dispatchEvent(new Event('focus'))
  })
const count = (op: string) => invoke.mock.calls.filter(([, , req]) => req?.op === op).length
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  fake = createFakePhosphor({
    'ops:run': (target, req) => invoke('ops:run', target, req),
    'pi:extensionUiResponse': (session, res) => invoke('pi:extensionUiResponse', session, res),
  })
  restore = installFakePhosphor(fake)
  root = createRoot(document.body.appendChild(document.createElement('div')))
  useExtensionUiStore.setState({ dialogs: [], toasts: [] })
  useRemoteLanesStore.setState({ hosts: structuredClone(mockRemoteHosts) })
  invoke
    .mockReset()
    .mockImplementation(async (_ch, _target, req: OpsRunRequest) =>
      ok(req.op === 'policy.show' ? policy : []),
    )
})
afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  restore()
  fake.dispose()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('makes no ops calls for an old Host; reads on connect, focus and every 30s only while open', async () => {
  vi.useFakeTimers()
  await mount(<AgentControl machine={MOCK_HOST_ID} />)
  expect(invoke).not.toHaveBeenCalled()
  await act(async () =>
    useRemoteLanesStore.setState({
      hosts: { [MOCK_HOST_ID]: { ...mockRemoteHosts[MOCK_HOST_ID]!, ops: true } },
    }),
  )
  expect(count('confirm.list')).toBe(1)
  await focus()
  expect(count('confirm.list')).toBe(2)
  await act(async () => vi.advanceTimersByTimeAsync(30000))
  expect(count('confirm.list')).toBe(3)
  await mount(null)
  await focus()
  await act(async () => vi.advanceTimersByTimeAsync(30000))
  expect(count('confirm.list')).toBe(3)
})
it('recovers from a failed first local read and edits the policy it received', async () => {
  invoke.mockRejectedValueOnce(new Error('Not connected yet'))
  await mount(<AgentControl machine="local" />)
  expect(document.body.textContent).toContain('Not connected yet')
  await focus()
  expect(document.body.textContent).toContain('Pending approvals')
  const level = document.querySelector<HTMLSelectElement>(
    'select[aria-label="Other machines’ agents"]',
  )!
  await act(async () => {
    level.value = 'read'
    level.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(invoke).toHaveBeenCalledWith(
    'ops:run',
    { kind: 'local' },
    { op: 'policy.set', args: { policy: { ...AGENT_POLICY_DEFAULT, machineOps: 'read' } } },
  )
})
async function dialog() {
  act(() =>
    useExtensionUiStore.getState().handleRequest('sid', {
      type: 'extension_ui_request',
      method: 'confirm',
      id: 'dlg',
      title,
      message,
    }),
  )
  await mount(<ExtensionDialogHost />)
}
it('keeps an unbound prefixed confirmation an ordinary pi dialog', async () => {
  invoke.mockResolvedValue({
    status: 'denied',
    code: 'confirm-expired',
    text: 'No pending confirmation',
  })
  await dialog()
  expect(count('confirm.info')).toBe(1)
  expect(button('Yes')).toBeTruthy()
  expect(button('Approve')).toBeUndefined()
})
it('shows a failed relay on that machine before answering; only approval of every target can answer Yes', async () => {
  useRemoteLanesStore.setState({
    hosts: { [MOCK_HOST_ID]: { ...mockRemoteHosts[MOCK_HOST_ID]!, ops: true } },
  })
  invoke.mockImplementation(async (_ch, target, req) =>
    req.op === 'confirm.info'
      ? ok(info)
      : req.op === 'confirm.approve' && target.kind === 'remote'
        ? { status: 'denied', code: 'unavailable', text: 'Connection lost' }
        : ok({}),
  )
  await dialog()
  await click('Approve')
  expect(document.body.textContent).toContain('Connection lost')
  expect(document.body.textContent).toContain(MOCK_HOST_ID)
  expect(invoke.mock.calls.some(([ch]) => ch === 'pi:extensionUiResponse')).toBe(false)
  await click('Deny')
  expect(invoke).toHaveBeenCalledWith('pi:extensionUiResponse', 'sid', {
    type: 'extension_ui_response',
    id: 'dlg',
    confirmed: false,
  })
})
it('renders just the owner notify toast with its reason, not a second one for the audit change', async () => {
  await mount(
    <>
      <AgentControl machine="local" />
      <ToastHost />
    </>,
  )
  await act(async () => {
    useExtensionUiStore.getState().handleRequest('sid', {
      type: 'extension_ui_request',
      method: 'notify',
      id: 'n',
      message: 'Agent changed model: the task needs vision.',
      notifyType: 'info',
    })
    fake.events.onOpsChanged.emit({ kind: 'audit', machine: 'local' })
  })
  expect(document.querySelector('[data-testid="toast-stack"]')?.children.length).toBe(1)
  expect(document.body.textContent).toContain('the task needs vision')
})

it('only undoes the chosen machine’s audit id and reads it again after success', async () => {
  const row = {
    id: 'row-3',
    at: 123,
    principal: 'machine:bee',
    tier: 'lane',
    scope: 'self',
    op: 'lane.pin',
    argsSummary: '{}',
    reason: 'Keep this visible',
    decision: 'allowed',
    result: 'Pinned',
    undo: true,
  }
  invoke.mockImplementation(async (_ch, _target, req) =>
    ok(req.op === 'audit.list' ? [row] : req.op === 'policy.show' ? policy : []),
  )
  await mount(<AgentControl machine="local" />)
  expect(document.body.textContent).toContain('Keep this visible')
  await click('Undo')
  expect(invoke).toHaveBeenCalledWith(
    'ops:run',
    { kind: 'local' },
    { op: 'audit.undo', args: { auditId: 'row-3' } },
  )
  expect(count('audit.list')).toBe(2)
})
it('reviews CLI asks by exact id, without answering a pi dialog', async () => {
  const pending = {
    ...info,
    origin: { kind: 'local', label: 'Command line' },
    items: [{ hostId: null, op: info.op, ids: ['abc'], labels: ['old lane'] }],
  }
  invoke.mockImplementation(async (_ch, _target, req) =>
    ok(req.op === 'confirm.list' ? [pending] : req.op === 'policy.show' ? policy : []),
  )
  await mount(<AgentControl machine="local" />)
  await click('Review')
  expect(document.body.textContent).toContain(message)
  await click('Approve')
  expect(invoke).toHaveBeenCalledWith(
    'ops:run',
    { kind: 'local' },
    { op: 'confirm.approve', args: { confirmId } },
  )
  expect(count('confirm.list')).toBe(2)
})
it('does not trust another machine’s proposed target digest', async () => {
  useRemoteLanesStore.setState({
    hosts: { [MOCK_HOST_ID]: { ...mockRemoteHosts[MOCK_HOST_ID]!, ops: true } },
  })
  invoke.mockImplementation(async (_ch, t) =>
    ok(t.kind === 'local' ? info : { ...info, digest: 'ef'.repeat(32) }),
  )
  await dialog()
  expect(document.body.textContent).toContain('no longer matches')
  expect(button('Approve')!.disabled).toBe(true)
  expect(count('confirm.approve')).toBe(0)
})
