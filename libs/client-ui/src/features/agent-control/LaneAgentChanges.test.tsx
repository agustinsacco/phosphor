// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { OpsChangedEvent } from '@phosphor/shared/ipc'
import { COMPACT_PLATFORM, PlatformProvider } from '@/platform/Platform'
import { SessionMenu } from '@/features/chat/SessionMenu'
import { ContextMenuHost } from '@/components/ContextMenu'
import { ExtensionDialogHost } from '@/features/extension-ui/ExtensionUiHosts'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
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
let listener: ((event: OpsChangedEvent) => void) | undefined
const emit = () =>
  act(async () =>
    listener?.({ machine: `host:${MOCK_HOST_ID}`, laneRef: lane, kind: 'lane', fields: ['model'] }),
  )
function setup() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const invoke = vi.fn(async () => ({ status: 'ok', data: [row], applies: 'now', text: 'Done' }))
  vi.stubGlobal('phosphor', {
    invoke,
    onOpsChanged: (cb: typeof listener) => {
      listener = cb
      return () => {
        listener = undefined
      }
    },
  })
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
