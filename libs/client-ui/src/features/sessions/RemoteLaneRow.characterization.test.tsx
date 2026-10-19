// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RemoteLaneRow } from './RemoteLaneRow'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'

let root: Root, el: HTMLDivElement
let fake: ReturnType<typeof createFakePhosphor>, restore: () => void
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-10T12:00:00.000Z'))
  fake = createFakePhosphor({})
  restore = installFakePhosphor(fake)
  useSessionsStore.setState({ live: {}, pinned: [], laneMarkers: {} })
  useRemoteLanesStore.setState({ hosts: structuredClone(mockRemoteHosts) })
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
it.each(['stopped', 'working', 'needs-input', 'failed'] as const)(
  'characterizes Desktop title, time, worktree, branch and attention for %s',
  (activity) => {
    const lane = {
      ...mockRemoteHosts[MOCK_HOST_ID]!.lanes[0]!,
      title: '  Canonical title  ',
      updatedAt: '2026-09-10T11:00:00.000Z',
      worktree: true,
      branch: 'feature/parity',
      activity,
    }
    act(() => root.render(<RemoteLaneRow hostId={MOCK_HOST_ID} lane={lane} ready active={false} />))
    expect(el.querySelector('[data-testid=remote-session-row]')?.textContent).toBe(
      `•Canonical title${activity === 'working' ? 'Working' : '1h ago'}·wt·⎇ feature/parity${activity === 'needs-input' || activity === 'failed' ? 'needs you' : ''}`,
    )
    expect(el.querySelector('[data-testid=session-indicator]')?.getAttribute('data-state')).toBe(
      activity === 'working' ? 'streaming' : 'unseen',
    )
    expect(el.textContent).not.toContain('Needs attention')
  },
)
