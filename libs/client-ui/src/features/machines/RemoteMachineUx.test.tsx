// @vitest-environment jsdom
vi.mock('@/features/machines/RemoteModelPicker', () => ({
  useRemoteModel: () => ({ model: { id: 'test-model', provider: 'test' }, thinking: 'off' }),
  RemoteModelPicker: () => null,
}))
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MachinePicker } from './MachinePicker'
import { OnThisMachine } from './OnThisMachine'
import { MachineChip, RemoteLaneControls, STOP_NEEDS_PROMPT } from './RemoteLaneControls'
import { useChatStore } from '@/stores/chat'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useMachinePagesStore } from '@/stores/machinePages'
import { useSessionsStore } from '@/stores/sessions'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'

vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
const invoke = vi.fn()
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  Object.defineProperty(window, 'phosphor', { configurable: true, value: { invoke } })
  useRemoteLanesStore.setState({ hosts: structuredClone(mockRemoteHosts) })
  useSessionsStore.setState({
    live: {
      [mockRemoteInfo.sessionId]: { ...mockRemoteInfo, phosphorId: mockRemoteInfo.sessionId },
    },
    activeSessionId: mockRemoteInfo.sessionId,
  })
  useMachinePagesStore.setState({ skillsMachine: null, routinesMachine: '', artifactsMachine: '' })
  invoke
    .mockReset()
    .mockImplementation(async (method) =>
      method === 'hosts:skills'
        ? { skills: [{ name: 'skill' }] }
        : method === 'routines:list'
          ? { routines: [{ archived: false }] }
          : method === 'artifacts:list'
            ? [{ key: `host:${MOCK_HOST_ID}/lane:id/artifact:a` }, { key: 'local' }]
            : undefined,
    )
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})
function button(text: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(text),
  )
  if (!found) throw new Error(`Missing button ${text}`)
  return found
}
it('picker lists This Mac and only announced machines, preserving unavailable selection', () => {
  act(() =>
    root.render(<MachinePicker value="missing" capability="skills.read" onChange={() => {}} />),
  )
  expect(button('missing').textContent).toContain('unavailable')
  act(() => button('missing').click())
  expect([...container.querySelectorAll('[role=option]')].map((o) => o.textContent)).toEqual([
    'This Mac',
    'missing (unavailable)',
  ])
  expect((container.querySelectorAll('[role=option]')[1] as HTMLButtonElement).disabled).toBe(true)
  act(() =>
    root.render(<MachinePicker value="local" capability="sessions.control" onChange={() => {}} />),
  )
  expect(
    [...container.querySelectorAll('[role=option]')].some((o) =>
      o.textContent?.includes(MOCK_HOST_ID),
    ),
  ).toBe(true)
})
it('chip follows connected, reconnecting and down snapshots and recovers', () => {
  act(() => root.render(<MachineChip sessionId={mockRemoteInfo.sessionId} />))
  const host = mockRemoteHosts[MOCK_HOST_ID]
  if (!host) throw new Error('Missing host')
  for (const [state, label] of [
    ['ready', 'Connected'],
    ['reconnecting', 'Reconnecting'],
    ['down', 'Down'],
    ['ready', 'Connected'],
  ] as const) {
    act(() => useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: { ...host, state } } }))
    expect(container.textContent).toContain(label)
  }
})
it('On this machine gates reads and links, counts only that machine and opens filtered pages', async () => {
  await act(async () => root.render(<OnThisMachine hostId={MOCK_HOST_ID} />))
  expect(container.textContent).toContain('1 lane')
  expect(container.textContent).not.toContain('Skills')
  expect(container.textContent).not.toContain('Routines')
  expect(container.textContent).not.toContain('Artifacts')
  expect(invoke).not.toHaveBeenCalled()
  const host = mockRemoteHosts[MOCK_HOST_ID]
  if (!host) throw new Error('Missing host')
  await act(async () =>
    useRemoteLanesStore.setState({
      hosts: {
        [MOCK_HOST_ID]: {
          ...host,
          capabilities: ['sessions.read', 'skills.read', 'routines', 'artifacts.read'],
        },
      },
    }),
  )
  expect(button('Skills').textContent).toContain('1')
  expect(button('Artifacts').textContent).toContain('1')
  act(() => button('Skills').click())
  expect(useMachinePagesStore.getState().skillsMachine).toBe(MOCK_HOST_ID)
  act(() => button('Routines').click())
  expect(useMachinePagesStore.getState().routinesMachine).toBe(`host:${MOCK_HOST_ID}`)
  act(() => button('Artifacts').click())
  expect(useMachinePagesStore.getState().artifactsMachine).toBe(MOCK_HOST_ID)
  await act(async () =>
    useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: { ...host, state: 'down' } } }),
  )
  expect(container.textContent).toContain('last known')
  expect(button('Remote demo lane').disabled).toBe(true)
})

it('ignores counts from a detail selection that has gone away', async () => {
  let finish: ((value: unknown) => void) | undefined
  invoke.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const host = mockRemoteHosts[MOCK_HOST_ID]
  if (!host) throw new Error('Missing host')
  useRemoteLanesStore.setState({
    hosts: {
      [MOCK_HOST_ID]: { ...host, capabilities: ['skills.read'] },
      other: { ...host, capabilities: ['skills.read'] },
    },
  })
  await act(async () => root.render(<OnThisMachine hostId={MOCK_HOST_ID} />))
  const first = finish
  await act(async () => root.render(<OnThisMachine hostId="other" />))
  await act(async () => first?.({ skills: [{ name: 'old' }] }))
  // The new machine's own read is still pending: loading, never the old machine's count.
  expect(button('Skills').textContent).toContain('Loading')
  expect(button('Skills').textContent).not.toContain('1')
})

it('keeps On this machine counts and pending reads across unchanged snapshots', async () => {
  const host = mockRemoteHosts[MOCK_HOST_ID]!
  useRemoteLanesStore.setState({
    hosts: { [MOCK_HOST_ID]: { ...host, capabilities: ['skills.read'] } },
  })
  let finish!: (value: unknown) => void
  invoke.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  await act(async () => root.render(<OnThisMachine hostId={MOCK_HOST_ID} />))
  const first = finish
  for (let tick = 0; tick < 3; tick++)
    await act(async () => {
      useRemoteLanesStore.setState({ hosts: structuredClone(useRemoteLanesStore.getState().hosts) })
    })
  await act(async () => first({ skills: [{ name: 'skill' }] }))
  expect(button('Skills').textContent).toContain('1')
  await act(async () => {
    useRemoteLanesStore.setState({ hosts: structuredClone(useRemoteLanesStore.getState().hosts) })
  })
  expect(button('Skills').textContent).toContain('1')
  expect(invoke).toHaveBeenCalledTimes(1)
  await act(async () => {
    useRemoteLanesStore.setState({
      hosts: { [MOCK_HOST_ID]: { ...host, state: 'reconnecting', capabilities: ['skills.read'] } },
    })
  })
  await act(async () => {
    useRemoteLanesStore.setState({
      hosts: { [MOCK_HOST_ID]: { ...host, capabilities: ['skills.read'] } },
    })
  })
  await act(async () => first({ skills: [{}, {}] }))
  expect(button('Skills').textContent).toContain('Loading')
  await act(async () => finish({ skills: [{ name: 'new' }] }))
  expect(button('Skills').textContent).toContain('1')
})

it('rejects pending counts immediately on reconnect before effect cleanup', async () => {
  // Hold React notification, not the generation observer, until the pending read settles.
  // This exercises the interval between a snapshot arriving and effect cleanup.
  const useSyncExternalStore = React.useSyncExternalStore
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation(
    (_subscribe, getSnapshot, getServerSnapshot) =>
      useSyncExternalStore(() => () => {}, getSnapshot, getServerSnapshot),
  )
  const host = {
    ...mockRemoteHosts[MOCK_HOST_ID]!,
    capabilities: ['skills.read', 'routines'] as ('skills.read' | 'routines')[],
  }
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host } })
  let finish!: (value: unknown) => void
  invoke.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  await act(async () => root.render(<OnThisMachine hostId={MOCK_HOST_ID} />))
  const first = finish
  await act(async () => {
    useRemoteLanesStore.setState({
      hosts: { [MOCK_HOST_ID]: { ...host, connectionToken: 'reconnected' } },
    })
    // The old promise continues before React commits the new generation's effect.
    first({ skills: [{ name: 'stale' }] })
    await Promise.resolve()
    await Promise.resolve()
    expect(invoke.mock.calls.filter(([channel]) => channel === 'routines:list')).toHaveLength(0)
  })
  expect(button('Skills').textContent).toContain('Loading')
  expect(button('Skills').textContent).not.toContain('1')
  expect(invoke).toHaveBeenCalledTimes(1)
})
it('says Unavailable for a failed count, never zero', async () => {
  const host = mockRemoteHosts[MOCK_HOST_ID]!
  useRemoteLanesStore.setState({
    hosts: { [MOCK_HOST_ID]: { ...host, capabilities: ['skills.read'] } },
  })
  invoke.mockImplementation(async () => {
    throw new Error('busy')
  })
  await act(async () => root.render(<OnThisMachine hostId={MOCK_HOST_ID} />))
  expect(button('Skills').textContent).toContain('Unavailable')
  expect(button('Skills').textContent).not.toContain('0')
})
it('disables Stop until the lane has a first message, with the reason', () => {
  const id = mockRemoteInfo.sessionId
  const items = (list: unknown[]) =>
    act(() =>
      useChatStore.setState({
        sessions: { [id]: { items: list } },
      } as unknown as Partial<ReturnType<typeof useChatStore.getState>>),
    )
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID])
  const lane = host?.lanes[0]
  if (!host || !lane) throw new Error('Missing host')
  lane.control.controller = { self: true, label: 'This Desktop', connected: true }
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host } })
  items([])
  act(() => root.render(<RemoteLaneControls sessionId={id} />))
  const stop = () => button('Stop')
  expect(stop().disabled).toBe(true)
  expect(stop().getAttribute('title') ?? container.innerHTML).toContain(STOP_NEEDS_PROMPT)
  items([{ id: 'u', kind: 'user', text: 'hi' }])
  expect(stop().disabled).toBe(false)
})
