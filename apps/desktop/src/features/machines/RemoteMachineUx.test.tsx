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
import { MachineChip } from './RemoteLaneControls'
import { NewRemoteLane } from '@/features/sessions/RemoteLanes'
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
it('remote creation uses the selected configured repository and failure never starts local', async () => {
  invoke.mockRejectedValue(new Error('unavailable'))
  await act(async () =>
    root.render(<NewRemoteLane hostId={MOCK_HOST_ID} onMachine={() => {}} onClose={() => {}} />),
  )
  await act(async () => button('Create lane').click())
  expect(invoke).toHaveBeenCalledExactlyOnceWith('hosts:createLane', MOCK_HOST_ID, {
    repositoryId: '0000000000000001',
    provider: 'test',
    model: 'test-model',
    thinkingLevel: 'off',
  })
  expect(document.body.textContent).toContain('could not confirm creation')
  expect(useSessionsStore.getState().activeSessionId).toBe(mockRemoteInfo.sessionId)
})
it('creation disables on capability loss and down state without falling back', async () => {
  act(() =>
    root.render(<NewRemoteLane hostId={MOCK_HOST_ID} onMachine={() => {}} onClose={() => {}} />),
  )
  const host = mockRemoteHosts[MOCK_HOST_ID]
  if (!host) throw new Error('Missing host')
  for (const state of ['ready', 'down'] as const) {
    act(() =>
      useRemoteLanesStore.setState({
        hosts: {
          [MOCK_HOST_ID]: {
            ...host,
            state,
            capabilities: state === 'ready' ? [] : host.capabilities,
          },
        },
      }),
    )
    expect(button('Create lane').disabled).toBe(true)
    await act(async () =>
      document.body
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    )
    await act(async () => button('Create lane').click())
  }
  expect(invoke).not.toHaveBeenCalled()
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
  expect(container.textContent).toContain('1 lanes')
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

it('ignores creation replies after switching the machine dialog', async () => {
  const remote = await import('@/stores/remoteLanes')
  const adopt = vi.spyOn(remote, 'adoptRemoteLane').mockResolvedValue(undefined)
  let finish: ((value: unknown) => void) | undefined
  invoke.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  await act(async () =>
    root.render(<NewRemoteLane hostId={MOCK_HOST_ID} onMachine={() => {}} onClose={() => {}} />),
  )
  await act(async () => button('Create lane').click())
  await act(async () => root.render(null))
  useSessionsStore.setState({ live: {}, activeSessionId: null })
  await act(async () => finish?.(mockRemoteInfo))
  expect(adopt).not.toHaveBeenCalled()
  expect(useSessionsStore.getState().live).toEqual({})
  expect(useSessionsStore.getState().activeSessionId).toBeNull()
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
  expect(button('Skills').textContent).toContain('Unavailable')
})

it('cancels navigation and does not close a replacement dialog if adoption was already in progress', async () => {
  const remote = await import('@/stores/remoteLanes')
  let complete: (() => void) | undefined
  vi.spyOn(remote, 'adoptRemoteLane').mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  const close = vi.fn()
  invoke.mockResolvedValue(mockRemoteInfo)
  await act(async () =>
    root.render(<NewRemoteLane hostId={MOCK_HOST_ID} onMachine={() => {}} onClose={close} />),
  )
  await act(async () => button('Create lane').click())
  const navigation = useSessionsStore.getState().navSeq
  await act(async () => root.render(null))
  expect(useSessionsStore.getState().navSeq).toBeGreaterThan(navigation)
  await act(async () => complete?.())
  expect(close).not.toHaveBeenCalled()
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
  expect(button('Skills').textContent).toContain('Unavailable')
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
  expect(button('Skills').textContent).toContain('Unavailable')
  expect(invoke).toHaveBeenCalledTimes(1)
})
it('choosing This Mac in the remote dialog explicitly updates the composer target', () => {
  const onMachine = vi.fn()
  const onClose = vi.fn()
  act(() =>
    root.render(<NewRemoteLane hostId={MOCK_HOST_ID} onMachine={onMachine} onClose={onClose} />),
  )
  act(() => document.querySelector<HTMLButtonElement>('[aria-label=Machine]')!.click())
  act(() => button('This Mac').click())
  expect(onMachine).toHaveBeenCalledWith(null)
  expect(onClose).toHaveBeenCalledExactlyOnceWith()
  expect(invoke.mock.calls.some(([channel]) => channel === 'hosts:createLane')).toBe(false)
})

it('machine and repository menu actions never submit the remote creation form', async () => {
  invoke.mockRejectedValue(new Error('unavailable'))
  act(() =>
    root.render(<NewRemoteLane hostId={MOCK_HOST_ID} onMachine={() => {}} onClose={() => {}} />),
  )
  for (const label of ['Machine', 'Repository']) {
    act(() => document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click())
    const selected = document.querySelector<HTMLButtonElement>('[role=option][aria-selected=true]')!
    act(() => selected.click())
  }
  expect(invoke).not.toHaveBeenCalled()
  const form = document.querySelector<HTMLFormElement>('form')!
  expect(
    [...form.querySelectorAll('button')]
      .filter((button) => button.type === 'submit')
      .map((button) => button.textContent),
  ).toEqual(['Create lane'])
  // requestSubmit models the browser's implicit Enter submission, which jsdom does not synthesize.
  await act(async () => form.requestSubmit())
  expect(invoke).toHaveBeenCalledExactlyOnceWith('hosts:createLane', MOCK_HOST_ID, {
    repositoryId: '0000000000000001',
    provider: 'test',
    model: 'test-model',
    thinkingLevel: 'off',
  })
})
