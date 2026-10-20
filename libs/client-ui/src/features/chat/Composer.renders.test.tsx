// @vitest-environment jsdom
import { hostResourceKey } from '@shared/remote-host'
import { expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

window.matchMedia = vi.fn().mockReturnValue({
  matches: false,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
}) as unknown as typeof window.matchMedia
Element.prototype.scrollIntoView = vi.fn()
globalThis.ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver

const counts: Record<string, number> = {}
function counted(name: string, mod: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...mod }
  const C = mod[name] as (p: object) => React.JSX.Element
  out[name] = (p: object) => {
    counts[name] = (counts[name] ?? 0) + 1
    return C(p)
  }
  return out
}
vi.mock('./BackgroundWorkIndicator', async (orig) =>
  counted('BackgroundWorkIndicator', await orig()),
)
vi.mock('./WorkingIndicator', async (orig) => counted('WorkingIndicator', await orig()))
vi.mock('./composer/ContextMeter', async (orig) => counted('ContextMeter', await orig()))
vi.mock('./composer/ModelPicker', async (orig) => counted('ModelPicker', await orig()))

const { installMockPhosphor } = await import('@/dev/mockPhosphor')
installMockPhosphor()
const { useChatStore } = await import('@/stores/chat')
const { useDraftsStore, sessionDraftKey } = await import('@/stores/drafts')
const { Composer } = await import('./Composer')

/*
 * A keystroke must re-render the field, not every strip around it. They read
 * the chat store themselves, and while a turn streams, rendering them again on
 * every key competed with the transcript for the same frames.
 */
it('typing re-renders none of the strips and readouts around the field', async () => {
  useChatStore.getState().ensure('s1')
  useChatStore.setState((s) => ({
    sessions: {
      ...s.sessions,
      s1: {
        ...s.sessions.s1!,
        isStreaming: true,
        agentStartedAt: Date.now(),
        items: [
          { id: 'u1', kind: 'user', text: 'hi' },
          {
            id: 'a1',
            kind: 'assistant',
            blocks: [{ type: 'text', text: 'hello' }],
            streaming: true,
          },
        ] as never,
      },
    },
  }))
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  await act(async () => root.render(<Composer sessionId="s1" workspacePath="/tmp/w" />))
  for (const k of Object.keys(counts)) counts[k] = 0
  for (const t of ['a', 'ab', 'abc', 'abc d', 'abc de']) {
    await act(async () => useDraftsStore.getState().setText(sessionDraftKey(undefined, 's1'), t))
  }
  expect(counts).toEqual({
    BackgroundWorkIndicator: 0,
    WorkingIndicator: 0,
    ContextMeter: 0,
    ModelPicker: 0,
  })
  expect((el.querySelector('[data-composer-input]') as HTMLTextAreaElement | null)?.value).toBe(
    'abc de',
  )
  root.unmount()
})

it('disables a disconnected remote composer and restores it from the ready snapshot', async () => {
  const { useSessionsStore } = await import('@/stores/sessions')
  const { useRemoteLanesStore } = await import('@/stores/remoteLanes')
  const { mockRemoteInfo, mockRemoteHosts, MOCK_HOST_ID } = await import('@/dev/mockRemoteLanes')
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID])
  if (!host?.lanes[0]?.control.controller) throw new Error('Missing host')
  host.lanes[0].control.controller.self = true
  useSessionsStore.setState({
    live: {
      [mockRemoteInfo.sessionId]: { ...mockRemoteInfo, phosphorId: mockRemoteInfo.sessionId },
    },
  })
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: { ...host, state: 'down' } } })
  useChatStore.getState().ensure(mockRemoteInfo.sessionId)
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  try {
    await act(async () =>
      root.render(
        <Composer
          sessionId={mockRemoteInfo.sessionId}
          workspacePath={mockRemoteInfo.workspacePath}
        />,
      ),
    )
    expect(el.querySelector('fieldset')?.disabled).toBe(true)
    expect(el.querySelector('textarea')?.matches(':disabled')).toBe(true)
    expect(el.textContent).toContain('Machine not connected. Wait for reconnection.')
    const command = vi.spyOn(window.phosphor, 'piCommand')
    await act(async () =>
      useDraftsStore
        .getState()
        .setText(
          hostResourceKey(
            { kind: 'remote', hostId: MOCK_HOST_ID },
            'session',
            mockRemoteInfo.laneId ?? '',
          ),
          'must not send',
        ),
    )
    const textarea = el.querySelector('textarea')
    await act(async () =>
      textarea?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    )
    expect(command).not.toHaveBeenCalledWith(
      mockRemoteInfo.sessionId,
      expect.objectContaining({ type: 'prompt' }),
    )
    command.mockRestore()

    await act(async () => useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host } }))
    expect(el.querySelector('fieldset')?.disabled).toBe(false)
  } finally {
    act(() => root.unmount())
    el.remove()
    useRemoteLanesStore.setState({ hosts: {} })
    useSessionsStore.setState({ live: {} })
  }
})

/* Nothing typed during a reconnect can be sent yet, so the field waits with the lane and
 * says what it is waiting for. The draft already typed stays on screen. */
it('locks the field while the Host reconnects and says what it is waiting for', async () => {
  const { useSessionsStore } = await import('@/stores/sessions')
  const { useRemoteLanesStore } = await import('@/stores/remoteLanes')
  const { mockRemoteInfo, mockRemoteHosts, MOCK_HOST_ID } = await import('@/dev/mockRemoteLanes')
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID])
  if (!host?.lanes[0]?.control.controller) throw new Error('Missing host')
  host.lanes[0].control.controller.self = true
  useSessionsStore.setState({
    live: {
      [mockRemoteInfo.sessionId]: { ...mockRemoteInfo, phosphorId: mockRemoteInfo.sessionId },
    },
  })
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host } })
  useChatStore.getState().ensure(mockRemoteInfo.sessionId)
  const draftKey = hostResourceKey(
    { kind: 'remote', hostId: MOCK_HOST_ID },
    'session',
    mockRemoteInfo.laneId ?? '',
  )
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  try {
    await act(async () =>
      root.render(
        <Composer
          sessionId={mockRemoteInfo.sessionId}
          workspacePath={mockRemoteInfo.workspacePath}
        />,
      ),
    )
    const textarea = el.querySelector('textarea')!
    await act(async () => useDraftsStore.getState().setText(draftKey, 'half a thou'))
    for (const [state, words] of [
      ['reconnecting', 'Reconnecting to'],
      ['connecting', 'Connecting to'],
    ] as const) {
      await act(async () =>
        useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: { ...host, state } } }),
      )
      expect(el.querySelector('fieldset')?.disabled).toBe(true)
      expect(el.querySelector('fieldset')?.getAttribute('aria-busy')).toBe('true')
      const status = el.querySelector('[role="status"]')
      expect(status?.textContent).toBe(`${words} ${MOCK_HOST_ID}…`)
      expect(status?.querySelector('svg.animate-spin')).not.toBeNull()
      expect(textarea.value).toBe('half a thou')
    }
    await act(async () => useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host } }))
    expect(el.querySelector('fieldset')?.disabled).toBe(false)
    expect(el.querySelector('fieldset')?.hasAttribute('aria-busy')).toBe(false)
    expect(el.querySelector('[role="status"]')).toBeNull()
    expect(el.querySelector('textarea')).toBe(textarea)
    expect(textarea.value).toBe('half a thou')
  } finally {
    act(() => root.unmount())
    el.remove()
    useDraftsStore.getState().setText(draftKey, '')
    useRemoteLanesStore.setState({ hosts: {} })
    useSessionsStore.setState({ live: {} })
  }
})

it.each(['prompt', 'abort'] as const)(
  'reports a rejected remote %s once and preserves the draft',
  async (action) => {
    const { useSessionsStore } = await import('@/stores/sessions')
    const { useRemoteLanesStore } = await import('@/stores/remoteLanes')
    const { mockRemoteInfo, mockRemoteHosts, MOCK_HOST_ID } = await import('@/dev/mockRemoteLanes')
    const hosts = structuredClone(mockRemoteHosts)
    hosts[MOCK_HOST_ID]!.lanes[0]!.control.controller = {
      self: true,
      label: 'You',
      connected: true,
    }
    const sessionId = mockRemoteInfo.sessionId
    const draftKey = hostResourceKey(mockRemoteInfo.target!, 'session', mockRemoteInfo.laneId!)
    useSessionsStore.setState({
      live: { [sessionId]: { ...mockRemoteInfo, phosphorId: sessionId } },
    })
    useRemoteLanesStore.setState({ hosts })
    useChatStore.setState({ sessions: {} })
    useChatStore.getState().ensure(sessionId)
    if (action === 'abort')
      useChatStore.setState((s) => ({
        sessions: {
          ...s.sessions,
          [sessionId]: { ...s.sessions[sessionId]!, isStreaming: true, promptSentAt: 1 },
        },
      }))
    useDraftsStore.getState().patch(draftKey, {
      text: 'keep this prompt',
      attachments: [{ kind: 'image', data: 'aGVsbG8=', mimeType: 'image/png', name: 'image.png' }],
    })
    // Upload support is unnecessary for inline images, but still required by the UI's attachment admission.
    hosts[MOCK_HOST_ID]!.capabilities.push('workspaces.write')
    const report = vi.spyOn(useChatStore.getState(), 'setError')
    const command = vi.spyOn(window.phosphor, 'piCommand')
    const message = 'The Host could not confirm this. Check the lane before retrying.'
    command.mockRejectedValue(
      new Error(`Error invoking remote method 'pi:command': Error: ${message}`),
    )
    const el = document.createElement('div')
    document.body.append(el)
    const root = createRoot(el)
    try {
      await act(async () =>
        root.render(
          <Composer sessionId={sessionId} workspacePath={mockRemoteInfo.workspacePath} />,
        ),
      )
      const click = () =>
        (
          el.querySelector(
            `button[aria-label="${action === 'prompt' ? 'Send message' : 'Stop'}"]`,
          ) as HTMLButtonElement
        ).click()
      await act(async () => click())
      expect(command).toHaveBeenCalledWith(sessionId, expect.objectContaining({ type: action }))
      expect(report.mock.calls.filter(([, error]) => error !== null)).toEqual([
        [sessionId, message],
      ])
      expect(useDraftsStore.getState().get(draftKey)).toMatchObject({
        text: 'keep this prompt',
        attachments: [expect.objectContaining({ kind: 'image', data: 'aGVsbG8=' })],
      })
      expect(useChatStore.getState().sessions[sessionId]!.items).toEqual([])
      expect(useChatStore.getState().sessions[sessionId]!.promptSentAt).toBeNull()
      if (action === 'prompt') {
        command.mockResolvedValue({
          type: 'response',
          command: 'prompt',
          success: true,
          data: { disposition: 'handled' },
        })
        await act(async () => click())
        expect(command).toHaveBeenCalledTimes(2)
        expect(useDraftsStore.getState().get(draftKey)).toEqual({ text: '', attachments: [] })
      }
    } finally {
      act(() => root.unmount())
      el.remove()
      report.mockRestore()
      command.mockRestore()
      useSessionsStore.setState({ live: {} })
      useRemoteLanesStore.setState({ hosts: {} })
      useDraftsStore.setState({ drafts: {} })
    }
  },
)
