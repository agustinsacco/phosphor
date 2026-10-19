// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RemoteLaneRow } from './RemoteLaneRow'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useChatStore } from '@/stores/chat'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'

let root: Root, el: HTMLDivElement
let fake: ReturnType<typeof createFakePhosphor>, restore: () => void
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  fake = createFakePhosphor({})
  restore = installFakePhosphor(fake)
  useSessionsStore.setState({ live: {}, pinned: [], laneMarkers: {} })
  useChatStore.setState({ sessions: {} })
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  restore()
  fake.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
it('projects live names reactively by Host/lane identity rather than stale summary or another Host', () => {
  const lane = mockRemoteHosts[MOCK_HOST_ID]!.lanes[0]!
  useSessionsStore.setState({
    live: {
      other: {
        phosphorId: 'other',
        workspacePath: 'other',
        target: { kind: 'remote', hostId: 'other' },
        laneId: lane.laneId,
      },
      current: {
        phosphorId: 'current',
        workspacePath: 'current',
        target: { kind: 'remote', hostId: MOCK_HOST_ID },
        laneId: lane.laneId,
      },
    },
  })
  for (const sessionId of ['other', 'current']) {
    useChatStore.getState().ensure(sessionId)
    useChatStore.getState().setMeta(sessionId, {
      sessionId,
      thinkingLevel: 'off',
      isStreaming: false,
      isCompacting: false,
      steeringMode: 'all',
      followUpMode: 'all',
      autoCompactionEnabled: true,
      messageCount: 0,
      pendingMessageCount: 0,
    })
  }
  useChatStore.getState().patchMeta('other', { sessionName: 'Wrong Host' })
  act(() => root.render(<RemoteLaneRow lane={lane} hostId={MOCK_HOST_ID} onOpen={vi.fn()} />))
  expect(el.textContent).toContain(lane.title)
  act(() => useChatStore.getState().patchMeta('current', { sessionName: 'Live title' }))
  expect(el.querySelector('button')?.getAttribute('aria-label')).toBe('Live title')
  expect(el.textContent).not.toContain('Wrong Host')
  expect(el.textContent).not.toContain(lane.title)
})
it.each(['stopped', 'failed', 'needs-input', 'working'] as const)(
  'shares indicators and input-request semantics for %s without exposing native curation',
  (activity) => {
    const invoke = vi.spyOn(fake.api, 'invoke')
    const lane = { ...mockRemoteHosts[MOCK_HOST_ID]!.lanes[0]!, activity }
    act(() => root.render(<RemoteLaneRow lane={lane} onOpen={vi.fn()} />))
    const row = el.querySelector('button')!
    act(() => {
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }))
    })
    expect(invoke).not.toHaveBeenCalled()
    expect(useSessionsStore.getState().pinned).toEqual([])
    expect(useSessionsStore.getState().laneMarkers).toEqual({})
    expect(el.querySelector('[aria-label="Change lane marker"]')).toBeNull()
    expect(el.querySelector('[data-testid=session-indicator]')?.getAttribute('data-state')).toBe(
      activity === 'working' ? 'streaming' : 'unseen',
    )
    expect(el.textContent?.includes('needs you')).toBe(
      activity === 'failed' || activity === 'needs-input',
    )
  },
)
it.each([{ disabled: true }, { ready: false }])('disables navigation for %j', (props) => {
  const onOpen = vi.fn()
  const lane = { ...mockRemoteHosts[MOCK_HOST_ID]!.lanes[0]!, attention: 0, read: 0 }
  act(() => root.render(<RemoteLaneRow lane={lane} onOpen={onOpen} {...props} />))
  const row = el.querySelector('button')!
  expect(row.disabled).toBe(true)
  act(() => row.click())
  expect(onOpen).not.toHaveBeenCalled()
  expect(el.querySelector('[data-state=disk]')).not.toBeNull()
})
