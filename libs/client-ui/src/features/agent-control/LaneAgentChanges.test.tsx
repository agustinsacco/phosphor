// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { COMPACT_PLATFORM, PlatformProvider } from '@/platform/Platform'
import { SessionMenu } from '@/features/chat/SessionMenu'
import { ContextMenuHost } from '@/components/ContextMenu'
import { ExtensionDialogHost } from '@/features/extension-ui/ExtensionUiHosts'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import type { RpcSessionState } from '@phosphor/shared/rpc'
import { useChatStore } from '@/stores/chat'
import { useSessionsStore } from '@/stores/sessions'
import { mockRemoteHosts, MOCK_HOST_ID, mockRemoteInfo } from '@/dev/mockRemoteLanes'
import { useAgentHints } from './useAgentHints'
const lane = mockRemoteInfo.workspacePath,
  sid = mockRemoteInfo.sessionId
const row = {
  id: 'row-1',
  at: 123,
  op: 'model.set',
  laneRef: lane,
  principal: 'agent:own',
  tier: 'lane',
  scope: 'self',
  argsSummary: '{}',
  reason: 'Need vision',
  decision: 'allowed',
  result: 'Done',
  undo: false,
}
const el = document.createElement('div')
let root: ReturnType<typeof createRoot>
let fake: ReturnType<typeof createFakePhosphor>
let restore: () => void
const emit = () =>
  act(async () =>
    fake.events.onOpsChanged.emit({
      machine: `host:${MOCK_HOST_ID}`,
      laneRef: lane,
      kind: 'lane',
      fields: ['model'],
    }),
  )
function setup() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const invoke = vi.fn(async (_ch: string, _target: unknown, _req: unknown) => ({
    status: 'ok' as const,
    data: [row],
    applies: 'now' as const,
    text: 'Done',
  }))
  fake = createFakePhosphor({ 'ops:run': (t, r) => invoke('ops:run', t, r) })
  restore = installFakePhosphor(fake)
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  useSessionsStore.setState({ live: { [sid]: { ...mockRemoteInfo, phosphorId: sid } } })
  useRemoteLanesStore.setState({
    hosts: { [MOCK_HOST_ID]: { ...mockRemoteHosts[MOCK_HOST_ID]!, ops: true } },
  })
  document.body.append(el)
  root = createRoot(el)
  return invoke
}
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  restore()
  fake.dispose()
  vi.unstubAllGlobals()
})
it('opens read-only lane-scoped changes from Session options on a browser', async () => {
  const invoke = setup()
  await act(async () =>
    root.render(
      <PlatformProvider value={COMPACT_PLATFORM}>
        <SessionMenu sessionId={sid} />
        <ContextMenuHost />
        <ExtensionDialogHost />
      </PlatformProvider>,
    ),
  )
  await act(async () =>
    el.querySelector<HTMLButtonElement>('[aria-label="Session options"]')!.click(),
  )
  const btn = [...document.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Agent changes…'),
  )
  await act(async () => btn!.click())
  expect(invoke).toHaveBeenCalledWith(
    'ops:run',
    { kind: 'remote', hostId: MOCK_HOST_ID },
    { op: 'audit.list', args: { lane } },
  )
  expect(document.body.textContent).toContain('Need vision')
})
it('attaches the changed field’s reason and clears it after a user pick', async () => {
  setup()
  function Hints() {
    const hints = useAgentHints(sid)
    return <button onClick={() => hints.clear('model')}>{hints.model}</button>
  }
  await act(async () => root.render(<Hints />))
  await emit()
  expect(el.textContent).toContain('Changed by the agent: Need vision')
  await act(async () => el.querySelector('button')!.click())
  expect(el.textContent).not.toContain('Need vision')
})

it('keeps the observed reason when returning to the same live lane', async () => {
  setup()
  function Hint() {
    const hints = useAgentHints(sid)
    return <span>{hints.model}</span>
  }
  await act(async () => root.render(<Hint />))
  await emit()
  await act(async () => root.render(null))
  await act(async () => root.render(<Hint />))
  expect(el.textContent).toContain('Need vision')
})

it('refreshes only the matching lane, recovers after failure and never overlaps get_state', async () => {
  setup()
  const chat = useChatStore.getState()
  chat.ensure(sid)
  chat.setMeta(sid, { sessionId: 'pi-id', thinkingLevel: 'off' } as RpcSessionState)
  const command = vi.spyOn(fake.api, 'piCommand')
  const waiting = Promise.withResolvers<void>()
  command.mockRejectedValueOnce(new Error('not ready')).mockImplementation(async () => {
    await waiting.promise
    return { command: 'get_state', type: 'response', success: true, data: { sessionId: 'pi-id', thinkingLevel: 'high' } as RpcSessionState }
  })
  function Hint() { useAgentHints(sid); return null }
  await act(async () => root.render(<Hint />))
  await act(async () => { for (const patch of [{ laneRef: 'other' }, { fields: ['pinned'] }, { machine: 'local' }]) fake.events.onOpsChanged.emit({ machine: `host:${MOCK_HOST_ID}`, laneRef: lane, kind: 'lane', fields: ['model'], ...patch }) })
  expect(command).not.toHaveBeenCalled()
  await emit()
  expect(command).toHaveBeenCalledWith(sid, { type: 'get_state' })
  expect(useChatStore.getState().sessions[sid]?.meta?.thinkingLevel).toBe('off')
  await emit()
  await emit()
  expect(command).toHaveBeenCalledTimes(2)
  await act(async () => waiting.resolve())
  expect(useChatStore.getState().sessions[sid]?.meta?.thinkingLevel).toBe('high')
})
