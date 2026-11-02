// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest'
import { loadSubagentView, saveSubagentView } from './subagentView'
beforeEach(() => localStorage.clear())
it('restores only view/target for the durable Pi identity, not a different session or clone', () => {
  saveSubagentView('pi-id', { view: 'history', target: { runId: 'root', childId: 'child' } })
  expect(loadSubagentView('pi-id')).toEqual({
    view: 'history',
    target: { runId: 'root', childId: 'child' },
  })
  expect(loadSubagentView('new-clone')).toEqual({ view: 'live' })
  expect(localStorage.getItem('phosphor-subagent-view-v1')).not.toMatch(
    /running|inspection|open|status/,
  )
})
it('bounds retained preferences and rejects malformed stored targets', () => {
  for (let i = 0; i < 110; i++) saveSubagentView(String(i), { view: 'live' })
  expect(Object.keys(JSON.parse(localStorage.getItem('phosphor-subagent-view-v1')!))).toHaveLength(
    100,
  )
  localStorage.setItem(
    'phosphor-subagent-view-v1',
    JSON.stringify({ bad: { view: 'x', target: { runId: '--flag' } } }),
  )
  expect(loadSubagentView('bad')).toEqual({ view: 'live' })
  localStorage.setItem('phosphor-subagent-view-v1', 'broken')
  expect(loadSubagentView('bad')).toEqual({ view: 'live' })
})
it("keeps a Host lane's view under the lane, since every open gives its window a new handle (regression)", async () => {
  const { useSessionsStore } = await import('@/stores/sessions')
  const { useChatStore } = await import('@/stores/chat')
  const { useLayoutStore } = await import('@/stores/layout')
  const { mockRemoteInfo } = await import('@/dev/mockRemoteLanes')
  const { hostResourceKey } = await import('@shared/remote-host')
  const { openSubagents } = await import('./subagentView')
  const open = (handle: string): void => {
    useSessionsStore.setState({
      live: { [handle]: { ...mockRemoteInfo, phosphorId: handle } },
    })
    // On a Host lane the window's pi state names the handle, never pi's session.
    useChatStore.getState().ensure(handle)
    useChatStore.getState().setMeta(handle, { sessionId: handle } as never)
  }
  open('remote-0000000000000001')
  openSubagents('remote-0000000000000001', 'run-1')
  open('remote-0000000000000002')
  const key = hostResourceKey(mockRemoteInfo.target!, 'session', mockRemoteInfo.laneId!)
  expect(loadSubagentView(key)).toEqual({ view: 'live', target: { runId: 'run-1' } })
  expect(loadSubagentView('remote-0000000000000001')).toEqual({ view: 'live' })
  useLayoutStore.getState().setRightPane(null)
})
