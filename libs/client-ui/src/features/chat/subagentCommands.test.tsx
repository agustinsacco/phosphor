// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MOCK_HOST_ID, mockRemoteHosts, mockRemoteInfo } from '@/dev/mockRemoteLanes'
import { useChatStore } from '@/stores/chat'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { SNAPSHOT_COMMAND } from '@phosphor/pi-extensions/subagent-snapshot'
import type { SubagentInspection } from './subagentInspect'
import { SubagentActions } from './SubagentActions'
import { SubagentStop } from './SubagentStopControl'

const HANDLE = mockRemoteInfo.sessionId
let root: Root
let container: HTMLDivElement

function session(id: string, remote: boolean): void {
  useSessionsStore.setState({
    live: {
      [id]: remote
        ? { ...mockRemoteInfo, phosphorId: id }
        : { phosphorId: id, workspacePath: '/repo' },
    },
  })
  useChatStore.getState().ensure(id)
  useChatStore.getState().setMeta(id, { sessionId: id } as never)
  useChatStore.getState().setCommands(
    id,
    ['subagents-stop', 'subagents-steer', SNAPSHOT_COMMAND].map((name) => ({
      name,
      source: 'extension' as const,
    })),
  )
}
function controlledBy(self: boolean): void {
  const hosts = structuredClone(mockRemoteHosts)
  hosts[MOCK_HOST_ID]!.lanes[0]!.control.controller = self
    ? { label: 'This Desktop', connected: true, self: true }
    : { label: 'Another Desktop', connected: true, self: false }
  useRemoteLanesStore.setState({ hosts })
}
function render(id: string): void {
  act(() =>
    root.render(
      <>
        <SubagentActions
          sessionId={id}
          target={{ runId: 'run-a' }}
          inspection={{ label: 'worker' } as SubagentInspection}
          readAt="2026-11-02T00:00:00.000Z"
          active
        />
        <SubagentStop sessionId={id} runId="run-a" />
      </>,
    ),
  )
}
const button = (name: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent === name)
  if (!found) throw new Error(`No ${name} button`)
  return found
}
const actions = ['Save snapshot', 'Steer…', 'Stop run…']

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useRemoteLanesStore.setState({ hosts: {} })
  useSessionsStore.setState({ live: {} })
  vi.unstubAllGlobals()
})

it("offers a run's actions on This Mac without any lane control", () => {
  session('local', false)
  render('local')
  for (const name of actions) expect(button(name).disabled).toBe(false)
})

it("leaves a Host lane's run actions to its controller, as the composer does", () => {
  session(HANDLE, true)
  act(() => controlledBy(false))
  render(HANDLE)
  for (const name of actions) {
    expect(button(name).disabled).toBe(true)
    expect(button(name).dataset.tooltip).toBe('Take control first.')
  }
  act(() => controlledBy(true))
  for (const name of actions) expect(button(name).disabled).toBe(false)
})

it('says the Host is not connected rather than asking for control it cannot give', () => {
  session(HANDLE, true)
  const hosts = structuredClone(mockRemoteHosts)
  hosts[MOCK_HOST_ID]!.state = 'down'
  act(() => useRemoteLanesStore.setState({ hosts }))
  render(HANDLE)
  for (const name of actions) {
    expect(button(name).disabled).toBe(true)
    expect(button(name).dataset.tooltip).not.toBe('Take control first.')
  }
})
