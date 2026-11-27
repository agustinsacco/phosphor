// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MOCK_HOST_ID, mockRemoteHosts, mockRemoteInfo } from '@/dev/mockRemoteLanes'
import { composerDraftKey, useDraftsStore } from '@/stores/drafts'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import type { HostLaneView } from '@shared/ipc'
import { LaneLock, useTakenBy } from './LaneLock'

const id = mockRemoteInfo.sessionId
const invoke = vi.fn()
let root: Root
let el: HTMLDivElement

function setController(controller: HostLaneView['control']['controller']) {
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  host.lanes[0]!.control.controller = controller
  act(() => useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host } }))
}
function Lock() {
  return <LaneLock sessionId={id} takenBy={useTakenBy(id)} />
}
const button = (name: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent === name)

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(window, 'phosphor', { configurable: true, value: { invoke } })
  invoke.mockReset().mockResolvedValue(undefined)
  const entry = {
    phosphorId: id,
    workspacePath: mockRemoteInfo.workspacePath,
    target: mockRemoteInfo.target,
    laneId: mockRemoteInfo.laneId,
  }
  useSessionsStore.setState({ live: { [id]: entry } } as never)
  useDraftsStore.setState({ drafts: {} })
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  useRemoteLanesStore.setState({ hosts: {} })
})

it('takes from a disconnected holder in one step', async () => {
  setController({ label: 'Web browser', connected: false, self: false })
  act(() => root.render(<Lock />))
  expect(el.textContent).toContain('Web browser has control · disconnected')
  await act(async () => button('Take control')?.click())
  expect(invoke).toHaveBeenCalledWith('hosts:takeControl', MOCK_HOST_ID, mockRemoteInfo.laneId)
})

it('asks before taking from a connected holder, and Escape cancels the question', () => {
  setController({ label: 'iPhone', connected: true, self: false })
  act(() => root.render(<Lock />))
  act(() => button('Take over…')?.click())
  expect(el.textContent).toContain('iPhone becomes read-only.')
  expect(document.activeElement).toBe(button('Take over'))
  act(() => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
  })
  expect(button('Take over…')).toBeDefined()
  expect(invoke).not.toHaveBeenCalled()
})

it('tells the client that lost the lane who took it, keeps its draft and offers it back', () => {
  setController({ label: 'This Desktop', connected: true, self: true })
  act(() => root.render(<Lock />))
  const entry = useSessionsStore.getState().live[id]
  act(() => useDraftsStore.getState().setText(composerDraftKey(entry, id), 'half a thought'))
  setController({ label: 'iPhone', connected: true, self: false })
  expect(el.textContent).toContain('iPhone took control from you. Your draft is kept.')
  expect(button('Take back…')).toBeDefined()
  // Once someone else holds it, the notice is stale and the lock names the new holder.
  setController({ label: 'Desk', connected: false, self: false })
  expect(el.textContent).toContain('Desk has control · disconnected')
})

it('keeps a refused take on the lock, saying why', async () => {
  setController(null)
  invoke.mockRejectedValue(new Error('private detail'))
  act(() => root.render(<Lock />))
  expect(el.textContent).toContain('Nobody has control of this lane.')
  await act(async () => button('Take control')?.click())
  expect(el.querySelector('[role=alert]')?.textContent).toBeTruthy()
  expect(el.textContent).not.toContain('private detail')
})
